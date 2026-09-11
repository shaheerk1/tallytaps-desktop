/**
 * Undoing mistakes: expense reversal and taking a cost back off goods.
 *
 * Runs inside one real transaction against the real schema and rolls back.
 *
 *   1. reversing a safe expense returns the money and nets the journal to zero;
 *   2. reversing a till expense voids its cash inside the open shift;
 *   3. a till expense whose shift was closed and counted is refused, unchanged;
 *   4. reversing a partner-paid expense reduces their claim again;
 *   5. reversing a cost on half-sold goods also reverses the recognised part;
 *   6. a cost can be taken off one lot while staying on another;
 *   7. a reversed recurring cost becomes due again;
 *   8. an expense cannot be reversed twice;
 *   9. the books still balance after every undo.
 */
const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createDocumentSequenceRepository } = require('../../packages/database/repositories/document-sequence.repository');
const { createBusinessDayRepository } = require('../../packages/database/repositories/business-day.repository');
const { createJournalRepository } = require('../../packages/database/repositories/journal.repository');
const { createExpenseRepository } = require('../../packages/database/repositories/expense.repository');
const { createLotCostingRepository } = require('../../packages/database/repositories/lot-costing.repository');
const { createStakeholderRepository } = require('../../packages/database/repositories/stakeholder.repository');

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectRejection(promise, pattern, label) {
  let message = null;
  try { await promise; } catch (error) { message = error.message; }
  if (message === null) throw new Error(`${label} was accepted but should have been refused.`);
  if (pattern && !pattern.test(message)) throw new Error(`${label} was refused for the wrong reason: ${message}`);
}

async function main() {
  const realDatabase = createDatabase();
  const passed = [];
  try {
    await realDatabase.withConnection(async (connection) => {
      await connection.beginTransaction();
      const tx = {
        execute: (...args) => connection.execute(...args),
        query: (...args) => connection.query(...args),
        beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}
      };
      const database = { withConnection: async (work) => work(tx) };
      const documentSequenceRepository = createDocumentSequenceRepository({ database });
      const businessDayRepository = createBusinessDayRepository({ database });
      const journalRepository = createJournalRepository({ database, documentSequenceRepository });
      const lotCostingRepository = createLotCostingRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository });
      const expenses = createExpenseRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository, lotCostingRepository });
      const stakeholders = createStakeholderRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository, expenseRepository: expenses });

      try {
        const [[user]] = await connection.execute("SELECT id FROM users WHERE status = 'active' ORDER BY id LIMIT 1");
        const stamp = String(Date.now()).slice(-8);
        const locCode = `RV${stamp}`;
        const macCode = 'T1';
        const txnDate = '2099-08-01';
        const origin = { locCode, macCode, txnDate };
        const base = { ...origin, userId: user.id };

        await connection.execute("INSERT INTO pos_locations (loc_code, business_code, name) VALUES (?, 'VERIFY', 'Reversal location')", [locCode]);
        const [ws] = await connection.execute("INSERT INTO pos_workstations (location_code, machine_code, name) VALUES (?, ?, 'Reversal terminal')", [locCode, macCode]);
        const [day] = await connection.execute("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES (?, ?, 'open', ?)", [locCode, txnDate, user.id]);
        const [safe] = await connection.execute(
          "INSERT INTO fund_accounts (fund_code, name, fund_kind, loc_code, opening_balance) VALUES (?, 'Reversal safe', 'cash_safe', ?, 100000)",
          [`SAFE-${locCode}`, locCode]
        );
        const [[goods]] = await connection.execute("SELECT id FROM expense_categories WHERE loc_code IS NULL AND default_treatment = 'lot_cost' AND is_active = 1 ORDER BY sort_order LIMIT 1");
        const [[overhead]] = await connection.execute("SELECT id FROM expense_categories WHERE loc_code IS NULL AND default_treatment = 'overhead' AND is_active = 1 ORDER BY sort_order LIMIT 1");
        const fundBalance = async (fundId) => (await expenses.listFundAccounts({ locCode, includeInactive: true })).find((row) => row.id === Number(fundId)).balance;
        const trialInBalance = async () => (await journalRepository.getTrialBalance({ locCode })).inBalance;

        // ── 1. A safe expense ──────────────────────────────
        const rent = await expenses.recordExpense({ ...base, expenseCategoryId: overhead.id, fundAccountId: safe.insertId, amount: 1500, reason: 'Rent typed twice' });
        assert(money(await fundBalance(safe.insertId)) === 98500, 'The safe should hold 98500 after the expense.');
        const undoneRent = await expenses.reverseExpense({ ...base, expenseEntryId: rent.id, reason: 'Entered twice by mistake' });
        assert(money(await fundBalance(safe.insertId)) === 100000, 'Reversing must return the 1500 to the safe.');
        const [[rentRow]] = await connection.execute('SELECT status, void_reason, voided_by FROM expense_entries WHERE id = ?', [rent.id]);
        assert(rentRow.status === 'void' && rentRow.void_reason === 'Entered twice by mistake' && Number(rentRow.voided_by) === Number(user.id),
          'The expense must be kept, marked void with who and why.');
        const [netLines] = await connection.execute(
          `SELECT l.ledger_account_id, SUM(l.debit - l.credit) AS net FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
           WHERE e.source_id = ? AND e.source_type IN ('expense','expense_reversal') GROUP BY l.ledger_account_id`, [String(rent.id)]
        );
        assert(netLines.length > 0 && netLines.every((row) => money(row.net) === 0), 'The expense and its reversal must net to zero on every account.');
        assert(undoneRent.reversalNumber.startsWith(`EXR-${locCode}`), 'A reversal carries its own origin-stamped number.');
        passed.push('reversing a safe expense returns the money, keeps it as void with who and why, and nets the journal to zero');

        // ── 2. A till expense, shift still open ────────────
        const [drawer] = await connection.execute("INSERT INTO cash_drawers (workstation_id, name) VALUES (?, 'Reversal drawer')", [ws.insertId]);
        const [session] = await connection.execute('INSERT INTO workstation_sessions (workstation_id, user_id, billing_date) VALUES (?, ?, ?)', [ws.insertId, user.id, txnDate]);
        const [shift] = await connection.execute(
          `INSERT INTO cash_shifts (business_day_id, drawer_id, workstation_session_id, workstation_id, user_id, loc_code, mac_code, shift_no, business_date, status, opening_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'open', 0)`, [day.insertId, drawer.insertId, session.insertId, ws.insertId, user.id, locCode, macCode, txnDate]
        );
        await connection.execute(
          `INSERT INTO cash_movements (cash_shift_id, loc_code, mac_code, business_date, shift_no, movement_no, movement_type, direction, amount, reason, created_by)
           VALUES (?, ?, ?, ?, 1, 1, 'opening_float', 'in', 5000, 'Float', ?)`, [shift.insertId, locCode, macCode, txnDate, user.id]
        );
        const [till] = await connection.execute(
          "INSERT INTO fund_accounts (fund_code, name, fund_kind, cash_drawer_id, loc_code) VALUES (?, 'Reversal till', 'pos_drawer', ?, ?)",
          [`DRAWER-${locCode}`, drawer.insertId, locCode]
        );
        const tea = await expenses.recordExpense({ ...base, expenseCategoryId: overhead.id, fundAccountId: till.insertId, amount: 300, reason: 'Tea for staff' });
        assert(money(await fundBalance(till.insertId)) === 4700, 'The till should hold 4700 after paying 300.');
        await expenses.reverseExpense({ ...base, expenseEntryId: tea.id, reason: 'Wrong amount' });
        assert(money(await fundBalance(till.insertId)) === 5000, 'Reversing a till expense must restore the till while its shift is open.');
        const [[cashRow]] = await connection.execute('SELECT m.status FROM cash_movements m JOIN expense_entries e ON e.cash_movement_id = m.id WHERE e.id = ?', [tea.id]);
        assert(cashRow.status === 'void', 'The till payment must be voided, not deleted.');
        const [[event]] = await connection.execute("SELECT COUNT(*) AS n FROM cash_movement_events e JOIN expense_entries x ON x.cash_movement_id = e.cash_movement_id WHERE x.id = ? AND e.action = 'voided'", [tea.id]);
        assert(Number(event.n) === 1, 'The void must leave an audit event on the cash movement.');
        passed.push('reversing a till expense voids its cash inside the open shift, with an audit event');

        // ── 3. A till expense after the shift closed ───────
        const lunch = await expenses.recordExpense({ ...base, expenseCategoryId: overhead.id, fundAccountId: till.insertId, amount: 200, reason: 'Lunch' });
        await connection.execute("UPDATE cash_shifts SET status = 'closed' WHERE id = ?", [shift.insertId]);
        await expectRejection(expenses.reverseExpense({ ...base, expenseEntryId: lunch.id, reason: 'Too late' }), /closed and counted/, 'Reversing a till expense after its shift closed');
        const [[lunchRow]] = await connection.execute('SELECT status FROM expense_entries WHERE id = ?', [lunch.id]);
        assert(lunchRow.status === 'recorded', 'A refused reversal must leave the expense exactly as it was.');
        await connection.execute("UPDATE cash_shifts SET status = 'open' WHERE id = ?", [shift.insertId]);
        passed.push('a till expense whose shift was closed and counted is refused and left unchanged');

        // ── 4. A partner-paid expense ──────────────────────
        const partner = await stakeholders.saveStakeholder({ locCode, displayName: 'Reversal partner', stakeholderType: 'partner' });
        const claimOf = async () => (await stakeholders.listStakeholders({ locCode })).find((row) => row.id === partner.id).claim;
        const lorry = await expenses.recordExpense({ ...base, expenseCategoryId: overhead.id, fundAccountId: partner.fundAccountId, amount: 800, reason: 'Paid from own pocket' });
        assert(money(await claimOf()) === 800, 'The partner should be owed 800.');
        const undoneLorry = await expenses.reverseExpense({ ...base, expenseEntryId: lorry.id, reason: 'The shop paid this, not him' });
        assert(money(await claimOf()) === 0, 'Reversing must reduce the partner claim back to 0.');
        assert(undoneLorry.stakeholderName === 'Reversal partner', 'The result should say whose claim changed.');
        passed.push('reversing a partner-paid expense reduces their claim again');

        // ── 5 & 6. Costs on goods ──────────────────────────
        const [supplier] = await connection.execute("INSERT INTO suppliers (loc_code, supplier_code, name) VALUES (?, 'RVS', 'Reversal farm')", [locCode]);
        const [grn] = await connection.execute(
          `INSERT INTO goods_receipts (business_day_id, grn_number, loc_code, mac_code, grn_no, document_type, supplier_id, business_date, status, created_by)
           VALUES (?, ?, ?, ?, 1, 'receipt', ?, ?, 'finalized', ?)`, [day.insertId, `GRN-${locCode}`, locCode, macCode, supplier.insertId, txnDate, user.id]
        );
        const lotIds = [];
        for (const [index, kilos] of [[1, 100], [2, 100]]) {
          const [item] = await connection.execute('INSERT INTO products (loc_code, sku, name, unit_price) VALUES (?, ?, ?, 0)', [locCode, `RV-${index}`, `Reversal item ${index}`]);
          const [line] = await connection.execute(
            `INSERT INTO goods_receipt_lines (goods_receipt_id, loc_code, mac_code, business_date, grn_no, line_no, product_id, package_qty, handling_quantity, received_kilos, received_base_quantity, conversion_mode, ratio_tolerance_percent)
             VALUES (?, ?, ?, ?, 1, ?, ?, 10, 10, ?, ?, 'variable', 20)`, [grn.insertId, locCode, macCode, txnDate, index, item.insertId, kilos, kilos]
          );
          const [lot] = await connection.execute(
            `INSERT INTO inventory_lots (goods_receipt_line_id, lot_code, loc_code, mac_code, txn_date, grn_no, line_no, supplier_id, product_id, ownership_model,
               received_quantity, received_handling_quantity, remaining_quantity, remaining_handling_quantity, received_kilos, received_base_quantity,
               remaining_kilos, remaining_base_quantity, handling_uom_snapshot, base_uom_snapshot, conversion_mode, ratio_tolerance_percent, terms_snapshot)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'owned', 10, 10, 10, 10, ?, ?, ?, ?, 'bag', 'kg', 'variable', 20, CAST('{}' AS JSON))`,
            [line.insertId, `LOT-${locCode}-${index}`, locCode, macCode, txnDate, index, supplier.insertId, item.insertId, kilos, kilos, kilos, kilos]
          );
          lotIds.push(Number(lot.insertId));
        }
        // Half of lot 1 is sold, so part of any cost on it is recognised as sold.
        await connection.execute(
          `INSERT INTO lot_sale_allocations (inventory_lot_id, loc_code, mac_code, txn_date, document_type, document_no, line_no, allocation_no, quantity, handling_quantity, kilos, base_quantity, sale_value)
           VALUES (?, ?, ?, ?, 'sale', 1, 1, 1, 5, 5, 50, 50, 5000)`, [lotIds[0], locCode, macCode, txnDate]
        );
        const recognised = async (lotId) => {
          const [[row]] = await connection.execute('SELECT COALESCE(recognized_cost, 0) AS c FROM lot_cost_recognition_state WHERE inventory_lot_id = ?', [lotId]);
          return money(row ? row.c : 0);
        };
        const allocatedOn = async (lotId) => {
          const [[row]] = await connection.execute('SELECT allocated_cost_total FROM inventory_lots WHERE id = ?', [lotId]);
          return money(row.allocated_cost_total);
        };

        const unloading = await expenses.recordExpense({ ...base, expenseCategoryId: goods.id, fundAccountId: safe.insertId, amount: 1000, reason: 'Unloading the load' });
        await lotCostingRepository.allocateExpense({ ...base, expenseEntryId: unloading.id, goodsReceiptId: grn.insertId, basis: 'base_quantity' });
        await lotCostingRepository.reconcileRecognizedCosts({ ...origin, userId: user.id, lotIds });
        assert(await allocatedOn(lotIds[0]) === 500 && await allocatedOn(lotIds[1]) === 500, 'The 1000 should sit 500 / 500 on the two lots.');
        assert(await recognised(lotIds[0]) === 250, `Half of lot 1 sold, so 250 of its 500 should be recognised, got ${await recognised(lotIds[0])}.`);

        // 6. Take it off lot 2 only.
        const detached = await lotCostingRepository.detachExpense({ ...base, expenseEntryId: unloading.id, inventoryLotId: lotIds[1], reason: 'Lot 2 was unloaded free' });
        assert(money(detached.amount) === 500, 'Detaching from lot 2 should take its 500 off.');
        assert(await allocatedOn(lotIds[1]) === 0 && await allocatedOn(lotIds[0]) === 500, 'Lot 1 keeps its share while lot 2 is cleared.');
        const [[stillAttached]] = await connection.execute('SELECT allocated_total FROM expense_entries WHERE id = ?', [unloading.id]);
        assert(money(stillAttached.allocated_total) === 500, 'The expense should show 500 still on goods.');
        passed.push('a cost can be taken off one lot while staying on another');

        // 5. Reverse the whole expense: lot 1's share and its recognised part go too.
        await expenses.reverseExpense({ ...base, expenseEntryId: unloading.id, reason: 'The unloading was never paid' });
        assert(await allocatedOn(lotIds[0]) === 0, 'Reversing must take the remaining cost off lot 1.');
        assert(await recognised(lotIds[0]) === 0, `The 250 already recognised as sold must be reversed too, got ${await recognised(lotIds[0])}.`);
        const [[unloadingRow]] = await connection.execute('SELECT status, allocated_total FROM expense_entries WHERE id = ?', [unloading.id]);
        assert(unloadingRow.status === 'void' && money(unloadingRow.allocated_total) === 0, 'The reversed expense carries nothing on goods.');
        passed.push('reversing a cost on half-sold goods also reverses the part already recognised as sold');

        // ── 7. A recurring cost ────────────────────────────
        const [template] = await connection.execute(
          `INSERT INTO recurring_expense_templates (loc_code, name, expense_category_id, fund_account_id, amount, reason, cadence, interval_count, next_due_date, is_active, created_by, updated_by)
           VALUES (?, 'Monthly rent', ?, ?, 2000, 'Rent', 'monthly', 1, ?, 1, ?, ?)`, [locCode, overhead.id, safe.insertId, txnDate, user.id, user.id]
        );
        const nextDue = async () => {
          const [[row]] = await connection.execute("SELECT DATE_FORMAT(next_due_date, '%Y-%m-%d') AS due FROM recurring_expense_templates WHERE id = ?", [template.insertId]);
          return row.due;
        };
        const monthRent = await expenses.recordExpense({ ...base, expenseCategoryId: overhead.id, fundAccountId: safe.insertId, amount: 2000, reason: 'Rent' });
        await expenses.completeRecurringExpense({ templateId: template.insertId, dueDate: txnDate, expenseEntryId: monthRent.id, userId: user.id });
        assert(await nextDue() === '2099-09-01', `Paying the rent should move it to next month, got ${await nextDue()}.`);
        const undoneRentMonth = await expenses.reverseExpense({ ...base, expenseEntryId: monthRent.id, reason: 'Paid by the landlord deposit' });
        assert(await nextDue() === txnDate && undoneRentMonth.recurringDueAgain, `The rent must be due again on ${txnDate}, got ${await nextDue()}.`);
        passed.push('a reversed recurring cost becomes due again');

        // ── 8. Twice ───────────────────────────────────────
        await expectRejection(expenses.reverseExpense({ ...base, expenseEntryId: rent.id, reason: 'Again' }), /already been reversed/, 'Reversing twice');
        passed.push('an expense cannot be reversed twice');

        // ── 9. The books ───────────────────────────────────
        assert(await trialInBalance(), 'The trial balance must still balance after every undo.');
        passed.push('the trial balance still balances after every reversal and detachment');

        console.log('Expense reversal invariants passed:');
        passed.forEach((line, index) => console.log(`  ${index + 1}. ${line}`));
        console.log('All writes will be rolled back.');
      } finally {
        await connection.rollback();
      }
    });
  } finally {
    await realDatabase.close();
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

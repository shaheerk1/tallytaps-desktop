/**
 * Phase 1 exit checks for funds and expenses.
 *
 * Everything runs inside one real transaction against the real schema and is
 * rolled back at the end, so the check can be run against a live database
 * without leaving a row behind.
 *
 *   1. a drawer expense writes an expense entry AND a cash movement, and the
 *      shift's expected total still reconciles;
 *   2. a non-drawer expense writes a fund movement and never touches a drawer;
 *   3. every fund's balance equals the sum of its own movements;
 *   4. a fund cannot be overdrawn;
 *   5. a transfer moves the same amount out of one fund and into another;
 *   6. an expense without a category, amount, fund, or reason is refused;
 *   7. the origin key stops a replayed expense from being written twice;
 *   8. every expense and transfer derives a balanced journal entry.
 *   9. recurring costs post only when confirmed and advance exactly once.
 */
const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createDocumentSequenceRepository } = require('../../packages/database/repositories/document-sequence.repository');
const { createBusinessDayRepository } = require('../../packages/database/repositories/business-day.repository');
const { createJournalRepository } = require('../../packages/database/repositories/journal.repository');
const { createExpenseRepository } = require('../../packages/database/repositories/expense.repository');
const { createExpenseService } = require('../../packages/core/expenses/expense.service');

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectRejection(promise, label) {
  try {
    await promise;
  } catch (error) {
    return error.message;
  }
  throw new Error(`${label} was accepted but should have been refused.`);
}

async function main() {
  const realDatabase = createDatabase();
  try {
    await realDatabase.withConnection(async (connection) => {
      await connection.beginTransaction();
      // The repositories manage their own transactions; inside this harness the
      // outer transaction owns the rollback so nothing is committed.
      const txConnection = {
        execute: (...args) => connection.execute(...args),
        query: (...args) => connection.query(...args),
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {}
      };
      const database = { withConnection: async (work) => work(txConnection) };
      const documentSequenceRepository = createDocumentSequenceRepository({ database });
      const businessDayRepository = createBusinessDayRepository({ database });
      const journalRepository = createJournalRepository({ database, documentSequenceRepository });
      const expenseRepository = createExpenseRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository });
      const service = createExpenseService({ expenseRepository });

      try {
        const [[user]] = await connection.execute('SELECT id FROM users WHERE status = ? ORDER BY id LIMIT 1', ['active']);
        assert(user, 'Expense invariants require an active user.');

        // ── Fixtures ────────────────────────────────────────
        const stamp = String(Date.now()).slice(-8);
        const locCode = `EXP${stamp}`.slice(0, 30);
        const macCode = 'T1';
        const txnDate = '2099-03-01';

        const [ws] = await connection.execute(
          'INSERT INTO pos_workstations (location_code, machine_code, name) VALUES (?, ?, ?)',
          [locCode, macCode, 'Expense invariant terminal']
        );
        const [drawer] = await connection.execute(
          'INSERT INTO cash_drawers (workstation_id, name) VALUES (?, ?)', [ws.insertId, 'Test drawer']
        );
        const [day] = await connection.execute(
          `INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES (?, ?, 'open', ?)`,
          [locCode, txnDate, user.id]
        );
        const [session] = await connection.execute(
          'INSERT INTO workstation_sessions (workstation_id, user_id, billing_date) VALUES (?, ?, ?)',
          [ws.insertId, user.id, txnDate]
        );
        const [shift] = await connection.execute(
          `INSERT INTO cash_shifts
             (business_day_id, drawer_id, workstation_session_id, workstation_id, user_id,
              loc_code, mac_code, shift_no, business_date, status, opening_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'open', 0)`,
          [day.insertId, drawer.insertId, session.insertId, ws.insertId, user.id, locCode, macCode, txnDate]
        );
        // An opening float, so the till has money to spend.
        await connection.execute(
          `INSERT INTO cash_movements
             (cash_shift_id, loc_code, mac_code, business_date, shift_no, movement_no,
              movement_type, direction, amount, reason, created_by)
           VALUES (?, ?, ?, ?, 1, 1, 'opening_float', 'in', 10000, 'Opening float', ?)`,
          [shift.insertId, locCode, macCode, txnDate, user.id]
        );

        const [drawerFund] = await connection.execute(
          `INSERT INTO fund_accounts (fund_code, name, fund_kind, cash_drawer_id, loc_code)
           VALUES (?, 'Test till', 'pos_drawer', ?, ?)`,
          [`DRAWER-${locCode}`, drawer.insertId, locCode]
        );
        const [safeFund] = await connection.execute(
          `INSERT INTO fund_accounts (fund_code, name, fund_kind, loc_code, opening_balance)
           VALUES (?, 'Test safe', 'cash_safe', ?, 5000)`,
          [`SAFE-${locCode}`, locCode]
        );
        const [[lotCategory]] = await connection.execute(
          `SELECT id, name FROM expense_categories WHERE default_treatment = 'lot_cost' AND is_active = 1 ORDER BY sort_order LIMIT 1`
        );
        const [[overheadCategory]] = await connection.execute(
          `SELECT id, name FROM expense_categories WHERE default_treatment = 'overhead' AND is_active = 1 ORDER BY sort_order LIMIT 1`
        );
        assert(lotCategory && overheadCategory, 'Seeded expense categories are missing.');

        const origin = { locCode, macCode, txnDate };
        const base = { userId: user.id, origin };

        // ── 1. Drawer expense writes both ledgers ───────────
        const drawerExpense = await service.recordExpense({
          ...base, expenseCategoryId: lotCategory.id, fundAccountId: drawerFund.insertId,
          amount: 1500, reason: 'Lorry wage for the onion load', payee: 'Driver'
        });
        assert(drawerExpense.expenseNumber.startsWith(`EXP-${locCode}-${macCode}-20990301-`), 'Expense number did not follow the origin format.');

        const [[savedDrawer]] = await connection.execute(
          'SELECT cash_movement_id, fund_movement_id, cash_shift_id, amount FROM expense_entries WHERE id = ?', [drawerExpense.id]
        );
        assert(savedDrawer.cash_movement_id != null, 'A till expense must write a cash movement.');
        assert(savedDrawer.fund_movement_id == null, 'A till expense must not also write a fund movement.');
        assert(Number(savedDrawer.cash_shift_id) === Number(shift.insertId), 'The expense did not attach to the open shift.');

        const [[cashRow]] = await connection.execute(
          `SELECT movement_type, direction, amount FROM cash_movements WHERE id = ?`, [savedDrawer.cash_movement_id]
        );
        assert(cashRow.movement_type === 'expense_cash' && cashRow.direction === 'out', 'The cash movement is not an outgoing expense.');
        assert(money(cashRow.amount) === 1500, 'The cash movement amount does not match the expense.');

        // The shift still reconciles: float in, expense out.
        const [[shiftTotals]] = await connection.execute(
          `SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END), 0) AS expected
           FROM cash_movements WHERE cash_shift_id = ?`, [shift.insertId]
        );
        assert(money(shiftTotals.expected) === 8500, `Shift expected total should be 8500.00, got ${money(shiftTotals.expected)}.`);

        // ── 2. Non-drawer expense uses its own ledger ───────
        const safeExpense = await service.recordExpense({
          ...base, expenseCategoryId: overheadCategory.id, fundAccountId: safeFund.insertId,
          amount: 2000, reason: 'Shop rent paid from the safe'
        });
        const [[savedSafe]] = await connection.execute(
          'SELECT cash_movement_id, fund_movement_id, cash_shift_id FROM expense_entries WHERE id = ?', [safeExpense.id]
        );
        assert(savedSafe.fund_movement_id != null, 'A safe expense must write a fund movement.');
        assert(savedSafe.cash_movement_id == null, 'A safe expense must not touch a drawer.');
        assert(savedSafe.cash_shift_id == null, 'A safe expense must not attach to a cash shift.');

        // ── 3. Balances equal their own ledgers ─────────────
        let funds = await service.listFundAccounts({ locCode });
        const drawerView = funds.find((row) => row.id === drawerFund.insertId);
        const safeView = funds.find((row) => row.id === safeFund.insertId);
        assert(money(drawerView.balance) === 8500, `Till balance should mirror the open shift (8500.00), got ${money(drawerView.balance)}.`);
        assert(money(safeView.balance) === 3000, `Safe balance should be 5000 opening - 2000 spent, got ${money(safeView.balance)}.`);

        // ── 4. A fund cannot be overdrawn ───────────────────
        const overdrawn = await expectRejection(service.recordExpense({
          ...base, expenseCategoryId: overheadCategory.id, fundAccountId: safeFund.insertId,
          amount: 99999, reason: 'More than the safe holds'
        }), 'An overdrawing expense');
        assert(/holds only/i.test(overdrawn), `Overdraw message should name the shortfall, got: ${overdrawn}`);

        // ── 5. A transfer moves value between two funds ─────
        const transfer = await service.transferFunds({
          ...base, fromFundAccountId: drawerFund.insertId, toFundAccountId: safeFund.insertId,
          amount: 3000, reason: 'End of day drop to the safe'
        });
        assert(money(transfer.fromBalance) === 5500, `Till after the drop should be 5500.00, got ${money(transfer.fromBalance)}.`);
        assert(money(transfer.toBalance) === 6000, `Safe after the drop should be 6000.00, got ${money(transfer.toBalance)}.`);

        const [[transferRow]] = await connection.execute(
          'SELECT from_cash_movement_id, from_fund_movement_id, to_cash_movement_id, to_fund_movement_id FROM fund_transfers WHERE transfer_number = ?',
          [transfer.transferNumber]
        );
        assert(transferRow.from_cash_movement_id != null && transferRow.from_fund_movement_id == null,
          'Money leaving the till must be recorded as a cash movement.');
        assert(transferRow.to_fund_movement_id != null && transferRow.to_cash_movement_id == null,
          'Money arriving in the safe must be recorded as a fund movement.');

        // Nothing was created or destroyed by the move.
        funds = await service.listFundAccounts({ locCode });
        const held = money(funds.reduce((sum, row) => sum + Number(row.balance), 0));
        assert(held === 11500, `Total held after the transfer should be 11500.00, got ${held}.`);

        // ── 6. Incomplete expenses are refused ──────────────
        await expectRejection(service.recordExpense({ ...base, fundAccountId: safeFund.insertId, amount: 100, reason: 'No category' }), 'An expense without a category');
        await expectRejection(service.recordExpense({ ...base, expenseCategoryId: overheadCategory.id, amount: 100, reason: 'No fund' }), 'An expense without a fund');
        await expectRejection(service.recordExpense({ ...base, expenseCategoryId: overheadCategory.id, fundAccountId: safeFund.insertId, amount: 0, reason: 'Zero' }), 'A zero-amount expense');
        await expectRejection(service.recordExpense({ ...base, expenseCategoryId: overheadCategory.id, fundAccountId: safeFund.insertId, amount: 100, reason: '   ' }), 'An expense without a reason');
        await expectRejection(service.recordExpense({ expenseCategoryId: overheadCategory.id, fundAccountId: safeFund.insertId, amount: 100, reason: 'No session', userId: user.id }), 'An expense without a workstation session');

        // ── 7. A replayed expense cannot be written twice ───
        const [[replayed]] = await connection.execute(
          'SELECT expense_no, business_day_id, expense_category_id, fund_account_id FROM expense_entries WHERE id = ?', [safeExpense.id]
        );
        const duplicate = await expectRejection(connection.execute(
          `INSERT INTO expense_entries
             (business_day_id, expense_category_id, fund_account_id, loc_code, mac_code, txn_date,
              expense_no, expense_number, amount, reason, fund_movement_id, created_by)
           SELECT business_day_id, expense_category_id, fund_account_id, loc_code, mac_code, txn_date,
                  expense_no, CONCAT(expense_number, '-REPLAY'), amount, reason, fund_movement_id, created_by
           FROM expense_entries WHERE id = ?`, [safeExpense.id]
        ), 'A replayed expense with the same origin key');
        assert(/duplicate/i.test(duplicate), `The origin key should reject the replay, got: ${duplicate}`);

        // ── Register totals ─────────────────────────────────
        const register = await service.listExpenses({ locCode, fromDate: txnDate, toDate: txnDate });
        assert(register.rows.length === 2, `The register should hold 2 expenses, got ${register.rows.length}.`);
        assert(money(register.total) === 3500, `Register total should be 3500.00, got ${money(register.total)}.`);
        assert(money(register.goodsTotal) === 1500, `Goods-related total should be 1500.00, got ${money(register.goodsTotal)}.`);
        assert(money(register.overheadTotal) === 2000, `General total should be 2000.00, got ${money(register.overheadTotal)}.`);
        assert(money(register.goodsTotal + register.overheadTotal) === money(register.total), 'Register split does not sum to the total.');

        // ── Fund ledger reads the right source ──────────────
        const drawerLedger = await service.getFundLedger({ fundAccountId: drawerFund.insertId, locCode });
        assert(drawerLedger.movements.some((row) => row.kind === 'expense_cash'), 'The till ledger should show the expense.');
        const safeLedger = await service.getFundLedger({ fundAccountId: safeFund.insertId, locCode });
        assert(safeLedger.movements.length === 2, `The safe ledger should show 2 movements, got ${safeLedger.movements.length}.`);

        // ── 9. Recurring costs are confirmed, not auto-posted ─
        const recurring = await service.saveRecurringExpense({
          ...base, locCode, name: 'Monthly test rent', expenseCategoryId: overheadCategory.id,
          fundAccountId: safeFund.insertId, amount: 100, reason: 'Test monthly rent',
          cadence: 'monthly', intervalCount: 1, nextDueDate: txnDate, isActive: true
        });
        const beforeRecurring = await service.listExpenses({ locCode, fromDate: txnDate, toDate: txnDate });
        assert(beforeRecurring.rows.length === 2, 'Saving a recurring reminder must not post money automatically.');
        await service.recordRecurringExpense({ ...base, templateId: recurring.id });
        const afterRecurring = await service.listExpenses({ locCode, fromDate: txnDate, toDate: txnDate });
        assert(afterRecurring.rows.length === 3, 'Confirming one due recurring cost should create exactly one expense.');
        const [nextRecurring] = await service.listRecurringExpenses({ locCode });
        assert(nextRecurring.nextDueDate === '2099-04-01', `Monthly schedule should advance to 2099-04-01, got ${nextRecurring.nextDueDate}.`);
        await expectRejection(service.recordRecurringExpense({ ...base, templateId: recurring.id }), 'A future recurring cost');

        // ── 8. Every money movement posted a balanced entry ─
        const trial = await journalRepository.getTrialBalance({ locCode });
        assert(trial.inBalance, `The journal is out of balance by ${trial.difference}.`);
        const [[postings]] = await connection.execute(
          'SELECT COUNT(*) AS n FROM journal_entries WHERE loc_code = ?', [locCode]
        );
        // 2 ordinary expenses + 1 transfer + 1 confirmed recurring expense.
        assert(Number(postings.n) === 4, `Expected 4 derived journal entries, got ${postings.n}.`);

        console.log('Expense and fund invariants passed:');
        console.log('  1. a till expense writes both an expense entry and a cash movement, and the shift reconciles');
        console.log('  2. a safe expense writes a fund movement and never touches a drawer');
        console.log('  3. every fund balance equals the sum of its own movements');
        console.log('  4. a fund cannot be overdrawn');
        console.log('  5. a transfer moves value without creating or destroying any');
        console.log('  6. an expense missing a category, fund, amount, reason, or session is refused');
        console.log('  7. a replayed expense is stopped by its origin key');
        console.log('  8. every expense and transfer derived a balanced journal entry');
        console.log('  9. recurring costs remain reminders until confirmed and then advance exactly once');
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
  console.error(error.message);
  process.exit(1);
});

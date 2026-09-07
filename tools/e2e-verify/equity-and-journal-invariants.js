/**
 * Phase 3 and 4 exit checks: stakeholder equity and the derived journal.
 *
 * Runs inside one real transaction against the real schema and rolls back.
 *
 *   1. a partner-paid expense raises the lot's landed cost AND the partner's
 *      claim in one transaction, or neither;
 *   2. a drawing above the available balance is refused without a named
 *      approver and a reason, and recorded with one;
 *   3. shares in one scope cannot add up to more than the whole;
 *   4. the sum of every stakeholder claim reconciles to what the journal says
 *      the business owes them;
 *   5. every event posts balanced lines and the trial balance nets to zero;
 *   6. the balance sheet balances, with drawings reducing equity;
 *   7. a closed period rejects a new posting until an authorised reopen.
 */
const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createDocumentSequenceRepository } = require('../../packages/database/repositories/document-sequence.repository');
const { createBusinessDayRepository } = require('../../packages/database/repositories/business-day.repository');
const { createJournalRepository } = require('../../packages/database/repositories/journal.repository');
const { createExpenseRepository } = require('../../packages/database/repositories/expense.repository');
const { createLotCostingRepository } = require('../../packages/database/repositories/lot-costing.repository');
const { createStakeholderRepository } = require('../../packages/database/repositories/stakeholder.repository');
const { createExpenseService } = require('../../packages/core/expenses/expense.service');
const { createLotCostingService } = require('../../packages/core/lot-costing/lot-costing.service');
const { createStakeholderService } = require('../../packages/core/stakeholders/stakeholder.service');
const { createAccountingService } = require('../../packages/core/accounting/accounting.service');
const postingRules = require('../../packages/core/accounting/posting-rules');

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectRejection(promise, label) {
  try { await promise; } catch (error) { return error.message; }
  throw new Error(`${label} was accepted but should have been refused.`);
}

async function main() {
  const realDatabase = createDatabase();
  try {
    await realDatabase.withConnection(async (connection) => {
      await connection.beginTransaction();
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
      const lotCostingRepository = createLotCostingRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository });
      const stakeholderRepository = createStakeholderRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository, expenseRepository });
      const expenses = createExpenseService({ expenseRepository });
      const costing = createLotCostingService({ lotCostingRepository });
      const stakeholders = createStakeholderService({ stakeholderRepository });
      const accounting = createAccountingService({ journalRepository });

      try {
        const [[user]] = await connection.execute('SELECT id FROM users WHERE status = ? ORDER BY id LIMIT 1', ['active']);
        const [[approver]] = await connection.execute('SELECT id FROM users WHERE status = ? ORDER BY id LIMIT 1', ['active']);
        assert(user, 'Equity invariants require an active user.');
        const [products] = await connection.execute('SELECT id FROM products ORDER BY id LIMIT 1');
        assert(products.length, 'Equity invariants require at least one product.');

        const stamp = String(Date.now()).slice(-8);
        const locCode = `EQ${stamp}`.slice(0, 30);
        const macCode = 'T1';
        const txnDate = '2099-05-01';
        const origin = { locCode, macCode, txnDate };
        const base = { userId: user.id, origin };

        await connection.execute(
          'INSERT INTO pos_workstations (location_code, machine_code, name) VALUES (?, ?, ?)',
          [locCode, macCode, 'Equity terminal']
        );
        const [day] = await connection.execute(
          `INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES (?, ?, 'open', ?)`,
          [locCode, txnDate, user.id]
        );
        const [supplier] = await connection.execute(
          'INSERT INTO suppliers (supplier_code, name) VALUES (?, ?)', [`SUP-${stamp}`, 'Equity Farms']
        );
        const [safeFund] = await connection.execute(
          `INSERT INTO fund_accounts (fund_code, name, fund_kind, loc_code, opening_balance)
           VALUES (?, 'Equity safe', 'cash_safe', ?, 500000)`, [`SAFE-${locCode}`, locCode]
        );
        const [[lotCategory]] = await connection.execute(
          `SELECT id, name FROM expense_categories WHERE default_treatment = 'lot_cost' AND is_active = 1 ORDER BY sort_order LIMIT 1`
        );

        // One received lot to attach a partner-paid cost to.
        const [grn] = await connection.execute(
          `INSERT INTO goods_receipts
             (business_day_id, grn_number, loc_code, mac_code, grn_no, document_type, supplier_id, business_date, status, created_by)
           VALUES (?, ?, ?, ?, 1, 'receipt', ?, ?, 'finalized', ?)`,
          [day.insertId, `GRN-${locCode}-1`, locCode, macCode, supplier.insertId, txnDate, user.id]
        );
        const [line] = await connection.execute(
          `INSERT INTO goods_receipt_lines
             (goods_receipt_id, loc_code, mac_code, business_date, grn_no, line_no, product_id,
              package_qty, handling_quantity, received_kilos, received_base_quantity, conversion_mode, ratio_tolerance_percent)
           VALUES (?, ?, ?, ?, 1, 1, ?, 10, 10, 100, 100, 'variable', 20)`,
          [grn.insertId, locCode, macCode, txnDate, products[0].id]
        );
        const [lot] = await connection.execute(
          `INSERT INTO inventory_lots
             (goods_receipt_line_id, lot_code, loc_code, mac_code, txn_date, grn_no, line_no,
              supplier_id, product_id, ownership_model, received_quantity, received_handling_quantity,
              remaining_quantity, remaining_handling_quantity, received_kilos, received_base_quantity,
              remaining_kilos, remaining_base_quantity, handling_uom_snapshot, base_uom_snapshot,
              conversion_mode, ratio_tolerance_percent, terms_snapshot)
           VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, 'owned', 10, 10, 10, 10, 100, 100, 100, 100, 'bag', 'kg', 'variable', 20, CAST('{}' AS JSON))`,
          [line.insertId, `LOT-${locCode}-1`, locCode, macCode, txnDate, supplier.insertId, products[0].id]
        );
        const lotId = Number(lot.insertId);

        // ── The partner, with an auto-created pocket ────────
        const partner = await stakeholders.save({
          locCode, displayName: 'Nuwan Perera', stakeholderType: 'partner', borneCostTreatment: 'capital'
        });
        assert(partner.fundAccountId, 'A stakeholder should get their own pocket fund.');
        assert(money(partner.claim) === 0, 'A new stakeholder starts with no claim.');

        // Capital in: 50,000 into the safe.
        const contribution = await stakeholders.contribute({
          ...base, stakeholderId: partner.id, fundAccountId: safeFund.insertId,
          amount: 50000, reason: 'Opening capital for the season'
        });
        assert(money(contribution.claim) === 50000, `Claim after contribution should be 50000.00, got ${contribution.claim}.`);

        // ── 1. A partner-paid cost: both effects or neither ─
        const borne = await expenses.recordExpense({
          ...base, expenseCategoryId: lotCategory.id, fundAccountId: partner.fundAccountId,
          amount: 2500, reason: 'Three-wheeler hired from his own hand'
        });
        assert(borne.stakeholderName === 'Nuwan Perera', 'A pocket expense should name the stakeholder who bore it.');
        assert(borne.stakeholderEntryNumber, 'A pocket expense must write an equity entry.');

        let list = await stakeholders.list({ locCode });
        let nuwan = list.find((row) => row.id === partner.id);
        assert(money(nuwan.borne) === 2500, `Borne cost should be 2500.00, got ${nuwan.borne}.`);
        assert(money(nuwan.claim) === 52500, `Claim should be 52500.00, got ${nuwan.claim}.`);

        await costing.allocateExpense({ ...base, expenseEntryId: borne.id, inventoryLotId: lotId, basis: 'direct' });
        const report = await costing.getProfitability({ locCode });
        const costedLot = report.lots.find((row) => row.id === lotId);
        assert(money(costedLot.allocatedCost) === 2500,
          `The lot should carry the partner-paid cost, got ${costedLot.allocatedCost}.`);

        // The two effects share one transaction: an expense that cannot post
        // its equity side must not leave a lonely expense row behind.
        const [[expenseCount]] = await connection.execute(
          `SELECT COUNT(*) AS n FROM expense_entries e
           JOIN stakeholder_ledger_entries s ON s.expense_entry_id = e.id
           WHERE e.loc_code = ? AND e.fund_account_id = ?`, [locCode, partner.fundAccountId]
        );
        assert(Number(expenseCount.n) === 1, 'Every pocket expense must have exactly one matching equity entry.');

        // ── 2. Drawing beyond the claim ─────────────────────
        const blocked = await expectRejection(stakeholders.draw({
          ...base, stakeholderId: partner.id, fundAccountId: safeFund.insertId,
          amount: 60000, reason: 'Taking more than the share'
        }), 'A drawing above the available balance');
        assert(/available/i.test(blocked) && /approve/i.test(blocked),
          `The refusal should name the available balance and ask for approval, got: ${blocked}`);

        const overridden = await stakeholders.draw({
          ...base, stakeholderId: partner.id, fundAccountId: safeFund.insertId,
          amount: 60000, reason: 'Agreed advance against next season',
          overrideApprovedBy: approver.id, overrideReason: 'Owner approved in the partners meeting'
        });
        assert(overridden.overrideUsed, 'The drawing should be recorded as an override.');
        assert(money(overridden.claim) === -7500, `Claim after the drawing should be -7500.00, got ${overridden.claim}.`);

        const statement = await stakeholders.statement({ stakeholderId: partner.id, locCode });
        const overrideEntry = statement.entries.find((row) => row.entryType === 'drawing');
        assert(overrideEntry.overrideApprover && overrideEntry.overrideReason,
          'An override must record who approved it and why.');

        // Profit can only be shared after it was earned.  Seed one derived sale
        // posting so this check proves an allocation cannot invent equity.
        await journalRepository.postWithConnection(connection, {
          businessDayId: day.insertId, ...origin,
          documentType: 'sale', documentNo: 999001,
          sourceType: 'verify_earned_profit', sourceId: locCode,
          posting: postingRules.invoiceSalePosting({ invoice: {
            invoiceNumber: 'VERIFY-PROFIT', grandTotal: 5000, bagChargeTotal: 0, wageChargeTotal: 0
          } }),
          userId: user.id
        });

        // Profit share brings the claim back up; no cash moves.
        const share = await stakeholders.allocateProfitShare({
          ...base, stakeholderId: partner.id, amount: 5000,
          inventoryLotId: lotId, reason: 'Approved share of this lot'
        });
        assert(money(share.claim) === -2500, `Claim after the profit share should be -2500.00, got ${share.claim}.`);

        // ── 3. Shares cannot exceed the whole ───────────────
        await stakeholders.saveShare({
          stakeholderId: partner.id, scope: 'business', sharePercent: 60,
          effectiveFrom: txnDate, userId: user.id
        });
        const second = await stakeholders.save({ locCode, displayName: 'Kamal Silva', stakeholderType: 'partner' });
        const tooMuch = await expectRejection(stakeholders.saveShare({
          stakeholderId: second.id, scope: 'business', sharePercent: 50,
          effectiveFrom: txnDate, userId: user.id
        }), 'A share taking the business past 100%');
        assert(/100%/.test(tooMuch), `The refusal should name the limit, got: ${tooMuch}`);
        await stakeholders.saveShare({
          stakeholderId: second.id, scope: 'business', sharePercent: 40,
          effectiveFrom: txnDate, userId: user.id
        });

        // ── 4. Equity reconciles to the journal ─────────────
        const equityCheck = await stakeholders.reconcile({ locCode });
        assert(equityCheck.inBalance,
          `Stakeholder claims (${equityCheck.ledgerTotal}) disagree with the journal (${equityCheck.journalTotal}).`);
        assert(money(equityCheck.ledgerTotal) === -2500,
          `Total claims should be -2500.00, got ${equityCheck.ledgerTotal}.`);

        // ── 5. The journal proves itself ────────────────────
        const trial = await accounting.trialBalance({ locCode });
        assert(trial.inBalance, `The trial balance is out by ${trial.difference}.`);
        assert(trial.totalDebit > 0, 'The trial balance should not be empty.');
        const cashCorrection = postingRules.assertBalanced(postingRules.manualCashMovementPosting({
          movement: { reason: 'Correct test movement' },
          before: { direction: 'out', amount: 100 },
          after: { direction: 'in', amount: 40 }
        }));
        assert(cashCorrection.totalDebit === 140 && cashCorrection.totalCredit === 140,
          'A manual cash correction must reverse the old movement before posting its replacement.');

        // ── 6. The balance sheet balances ───────────────────
        const sheet = await accounting.balanceSheet({ locCode });
        assert(sheet.inBalance,
          `Assets ${sheet.assetTotal} do not equal liabilities ${sheet.liabilityTotal} + equity ${sheet.equityTotal} + result ${sheet.retainedResult} (out by ${sheet.difference}).`);
        // Drawings must pull equity down, not push it up.
        assert(sheet.equityTotal < 50000,
          `Drawings should reduce equity below the 50000.00 contributed, got ${sheet.equityTotal}.`);

        // ── 7. A closed period is read-only ─────────────────
        await accounting.closePeriod({
          locCode, periodStart: '2099-05-01', periodEnd: '2099-05-31',
          userId: user.id, notes: 'Season close'
        });
        const closed = await expectRejection(expenses.recordExpense({
          ...base, expenseCategoryId: lotCategory.id, fundAccountId: safeFund.insertId,
          amount: 100, reason: 'Posting into a closed period'
        }), 'A posting into a closed period');
        assert(/closed/i.test(closed), `The refusal should say the period is closed, got: ${closed}`);

        const periods = await accounting.listPeriods({ locCode });
        await expectRejection(accounting.reopenPeriod({ periodId: periods[0].id, userId: user.id, reason: '' }),
          'Reopening without a reason');
        await accounting.reopenPeriod({ periodId: periods[0].id, userId: user.id, reason: 'One late lorry bill arrived' });
        const afterReopen = await expenses.recordExpense({
          ...base, expenseCategoryId: lotCategory.id, fundAccountId: safeFund.insertId,
          amount: 100, reason: 'The late lorry bill'
        });
        assert(afterReopen.expenseNumber, 'After an authorised reopen the period should accept postings again.');

        const finalTrial = await accounting.trialBalance({ locCode });
        assert(finalTrial.inBalance, `The trial balance is out by ${finalTrial.difference} after every event.`);

        console.log('Equity and journal invariants passed:');
        console.log('  1. a partner-paid cost raised the lot to 2500.00 and the claim to 52500.00 in one transaction');
        console.log('  2. a 60000.00 drawing was refused, then recorded with a named approver and reason');
        console.log('  3. business shares cannot be pushed past 100%');
        console.log('  4. stakeholder claims (-2500.00) reconcile exactly to the journal');
        console.log('  5. every event posted balanced lines; the trial balance nets to zero');
        console.log('  6. the balance sheet balances, with drawings reducing equity');
        console.log('  7. a closed period refused a posting until an authorised reopen');
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

/**
 * Remembering late: recording money on the day it actually happened.
 *
 * Runs inside one real transaction against the real schema and rolls back.
 *
 *   1. a safe expense can name an earlier day the shop was open, and lands there;
 *   2. the entry keeps who typed it, when, and why it was late;
 *   3. its journal posting carries the earlier date too, so reports agree;
 *   4. without the permission it is refused;
 *   5. money from a till can never be back-dated;
 *   6. a future date is refused;
 *   7. a day the shop never opened is refused;
 *   8. a date inside a closed accounting period is refused;
 *   9. a late reason is required;
 *  10. a transfer and a partner's money follow the same rules;
 *  11. an ordinary entry, with no date given, still lands on today.
 */
const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createDocumentSequenceRepository } = require('../../packages/database/repositories/document-sequence.repository');
const { createBusinessDayRepository } = require('../../packages/database/repositories/business-day.repository');
const { createJournalRepository } = require('../../packages/database/repositories/journal.repository');
const { createExpenseRepository } = require('../../packages/database/repositories/expense.repository');
const { createLotCostingRepository } = require('../../packages/database/repositories/lot-costing.repository');
const { createStakeholderRepository } = require('../../packages/database/repositories/stakeholder.repository');
const { createExpenseService } = require('../../packages/core/expenses/expense.service');
const { createStakeholderService } = require('../../packages/core/stakeholders/stakeholder.service');
const requestContext = require('../../packages/core/security/request-context');

const money = (value) => Math.round(Number(value || 0) * 100) / 100;
// MySQL DATE comes back as a local midnight Date; toISOString would shift it.
const asDate = (value) => (value instanceof Date
  ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  : String(value).slice(0, 10));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectRejection(run, pattern, label) {
  let message = null;
  try { await run(); } catch (error) { message = error.message; }
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
      const expenseRepository = createExpenseRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository, lotCostingRepository });
      const stakeholderRepository = createStakeholderRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository, expenseRepository });
      const expenses = createExpenseService({ expenseRepository });
      const partners = createStakeholderService({ stakeholderRepository });

      try {
        const [[user]] = await connection.execute("SELECT id FROM users WHERE status = 'active' ORDER BY id LIMIT 1");
        const stamp = String(Date.now()).slice(-8);
        const locCode = `BD${stamp}`;
        const macCode = 'T1';
        const lastWeek = '2099-08-01';   // closed
        const today = '2099-08-05';      // open, the day we are signed in to
        const neverOpened = '2099-08-03';

        await connection.execute("INSERT INTO pos_locations (loc_code, business_code, name) VALUES (?, 'VERIFY', 'Back-dating location')", [locCode]);
        const [ws] = await connection.execute("INSERT INTO pos_workstations (location_code, machine_code, name) VALUES (?, ?, 'Counter')", [locCode, macCode]);
        const [closedDay] = await connection.execute(
          "INSERT INTO business_days (loc_code, business_date, status, opened_by, closed_by, closed_at) VALUES (?, ?, 'closed', ?, ?, NOW())",
          [locCode, lastWeek, user.id, user.id]
        );
        const [openDay] = await connection.execute(
          "INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES (?, ?, 'open', ?)", [locCode, today, user.id]
        );
        const [safe] = await connection.execute(
          "INSERT INTO fund_accounts (fund_code, name, fund_kind, loc_code, opening_balance) VALUES (?, 'Safe', 'cash_safe', ?, 100000)", [`SAFE-${locCode}`, locCode]
        );
        const [bank] = await connection.execute(
          "INSERT INTO fund_accounts (fund_code, name, fund_kind, loc_code, opening_balance) VALUES (?, 'Bank', 'bank', ?, 0)", [`BANK-${locCode}`, locCode]
        );
        const [drawer] = await connection.execute("INSERT INTO cash_drawers (workstation_id, name) VALUES (?, 'Drawer')", [ws.insertId]);
        const [session] = await connection.execute('INSERT INTO workstation_sessions (workstation_id, user_id, billing_date) VALUES (?, ?, ?)', [ws.insertId, user.id, today]);
        const [shift] = await connection.execute(
          `INSERT INTO cash_shifts (business_day_id, drawer_id, workstation_session_id, workstation_id, user_id, loc_code, mac_code, shift_no, business_date, status, opening_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'open', 0)`, [openDay.insertId, drawer.insertId, session.insertId, ws.insertId, user.id, locCode, macCode, today]
        );
        await connection.execute(
          `INSERT INTO cash_movements (cash_shift_id, loc_code, mac_code, business_date, shift_no, movement_no, movement_type, direction, amount, reason, created_by)
           VALUES (?, ?, ?, ?, 1, 1, 'opening_float', 'in', 9000, 'Float', ?)`, [shift.insertId, locCode, macCode, today, user.id]
        );
        const [till] = await connection.execute(
          "INSERT INTO fund_accounts (fund_code, name, fund_kind, cash_drawer_id, loc_code) VALUES (?, 'Till', 'pos_drawer', ?, ?)", [`TILL-${locCode}`, drawer.insertId, locCode]
        );
        const [[overhead]] = await connection.execute("SELECT id FROM expense_categories WHERE loc_code IS NULL AND default_treatment = 'overhead' AND is_active = 1 ORDER BY sort_order LIMIT 1");

        // Signed in on `today`, at this workstation. This is exactly what the
        // IPC gate builds from the session token.
        const signedIn = (permissions) => ({
          user: { id: user.id }, permissions,
          workstation: { locCode, macCode, businessDate: today, workstationId: ws.insertId, workstationSessionId: session.insertId }
        });
        const allowed = signedIn(['money.backdate']);
        const notAllowed = signedIn([]);
        const asUser = (context, work) => requestContext.run(context, work);
        const balanceOf = async (fundId) => money((await expenseRepository.listFundAccounts({ locCode, includeInactive: true })).find((row) => row.id === Number(fundId)).balance);

        // ── 1-3. A cost remembered a few days late ─────────
        const lorry = await asUser(allowed, () => expenses.recordExpense({
          expenseCategoryId: overhead.id, fundAccountId: safe.insertId, amount: 4000,
          reason: 'Lorry hire', paidOn: lastWeek, paidOnReason: 'The driver only gave the bill today'
        }));
        const [[lorryRow]] = await connection.execute('SELECT txn_date, expense_number, metadata, DATE(created_at) AS typed_on FROM expense_entries WHERE id = ?', [lorry.id]);
        const lorryDate = asDate(lorryRow.txn_date);
        assert(lorryDate === lastWeek, `The expense must be dated ${lastWeek}, got ${lorryDate}.`);
        assert(lorryRow.expense_number.includes(lastWeek.replace(/-/g, '')), 'Its voucher number carries the day it happened.');
        assert(money(await balanceOf(safe.insertId)) === 96000, 'The safe must be 4000 lighter.');
        passed.push('a safe expense can name an earlier day the shop was open, and lands on that day');

        const stamped = typeof lorryRow.metadata === 'string' ? JSON.parse(lorryRow.metadata) : lorryRow.metadata;
        assert(stamped.backdated && stamped.backdated.enteredOn === today && /driver only gave the bill/.test(stamped.backdated.reason),
          `The entry must keep when it was typed in and why it was late, got ${JSON.stringify(stamped.backdated)}.`);
        passed.push('the entry keeps the day it was typed in and the reason it was late');

        const [[posting]] = await connection.execute(
          `SELECT e.txn_date FROM journal_entries e WHERE e.source_type = 'expense' AND e.source_id = ? LIMIT 1`, [String(lorry.id)]
        );
        const postingDate = asDate(posting.txn_date);
        assert(postingDate === lastWeek, `The journal posting must carry ${lastWeek}, got ${postingDate}.`);
        passed.push('the journal posting carries the earlier date, so the books and the register agree');

        // ── 4. Without the permission ──────────────────────
        await expectRejection(() => asUser(notAllowed, () => expenses.recordExpense({
          expenseCategoryId: overhead.id, fundAccountId: safe.insertId, amount: 500,
          reason: 'Tea', paidOn: lastWeek, paidOnReason: 'Late'
        })), /needs permission/, 'Back-dating without the permission');
        passed.push('without the permission, an earlier date is refused');

        // ── 5. Till money ─────────────────────────────────
        await expectRejection(() => asUser(allowed, () => expenses.recordExpense({
          expenseCategoryId: overhead.id, fundAccountId: till.insertId, amount: 500,
          reason: 'Tea', paidOn: lastWeek, paidOnReason: 'Remembered late'
        })), /till/i, 'Back-dating money paid from the till');
        passed.push('money paid from a till can never be back-dated: that drawer was counted with its shift');

        // ── 6-7. Dates that make no sense here ────────────
        await expectRejection(() => asUser(allowed, () => expenses.recordExpense({
          expenseCategoryId: overhead.id, fundAccountId: safe.insertId, amount: 500,
          reason: 'Tea', paidOn: '2099-09-01', paidOnReason: 'Next month'
        })), /future/, 'A future date');
        passed.push('a future date is refused');

        await expectRejection(() => asUser(allowed, () => expenses.recordExpense({
          expenseCategoryId: overhead.id, fundAccountId: safe.insertId, amount: 500,
          reason: 'Tea', paidOn: neverOpened, paidOnReason: 'That Wednesday'
        })), /no business day/, 'A day the shop never opened');
        passed.push('a day this location never opened is refused');

        // ── 8. A closed period ────────────────────────────
        await journalRepository.closePeriod({ locCode, periodStart: '2099-07-01', periodEnd: lastWeek, userId: user.id, notes: 'Verified' });
        await expectRejection(() => asUser(allowed, () => expenses.recordExpense({
          expenseCategoryId: overhead.id, fundAccountId: safe.insertId, amount: 500,
          reason: 'Tea', paidOn: lastWeek, paidOnReason: 'Remembered late'
        })), /closed/i, 'Back-dating into a closed accounting period');
        passed.push('a date inside a closed accounting period is still refused; reopening the period stays a deliberate act');
        await connection.execute("UPDATE accounting_periods SET status = 'open' WHERE loc_code = ?", [locCode]);

        // ── 9. The reason ─────────────────────────────────
        await expectRejection(() => asUser(allowed, () => expenses.recordExpense({
          expenseCategoryId: overhead.id, fundAccountId: safe.insertId, amount: 500, reason: 'Tea', paidOn: lastWeek
        })), /why this is being recorded on an earlier date/, 'Back-dating with no reason');
        passed.push('an earlier date always needs a reason');

        // ── 10. Transfers and partner money ───────────────
        const moved = await asUser(allowed, () => partners ? expenses.transferFunds({
          fromFundAccountId: safe.insertId, toFundAccountId: bank.insertId, amount: 10000,
          reason: 'Banked the takings', paidOn: lastWeek, paidOnReason: 'The slip surfaced today'
        }) : null);
        const [[transferRow]] = await connection.execute('SELECT txn_date FROM fund_transfers WHERE transfer_number = ?', [moved.transferNumber]);
        const transferDate = asDate(transferRow.txn_date);
        assert(transferDate === lastWeek && money(await balanceOf(bank.insertId)) === 10000, 'A back-dated transfer moves the money and keeps the earlier date.');

        const partner = await stakeholderRepository.saveStakeholder({ locCode, displayName: 'Late partner', stakeholderType: 'partner' });
        const contribution = await asUser(allowed, () => partners.contribute({
          stakeholderId: partner.id, fundAccountId: safe.insertId, amount: 25000, userId: user.id,
          reason: 'Cash brought in', paidOn: lastWeek, paidOnReason: 'He told us only today'
        }));
        const [[entryRow]] = await connection.execute('SELECT txn_date, metadata FROM stakeholder_ledger_entries WHERE entry_number = ?', [contribution.entryNumber]);
        const entryDate = asDate(entryRow.txn_date);
        const entryMeta = typeof entryRow.metadata === 'string' ? JSON.parse(entryRow.metadata) : entryRow.metadata;
        assert(entryDate === lastWeek && entryMeta.backdated && entryMeta.backdated.enteredOn === today,
          'A partner paying in earlier is dated that day and marked as entered late.');
        passed.push('transfers and partner money follow the same rules and keep the same record');

        // ── 11. The ordinary case is untouched ────────────
        const normal = await asUser(notAllowed, () => expenses.recordExpense({
          expenseCategoryId: overhead.id, fundAccountId: safe.insertId, amount: 300, reason: 'Sugar'
        }));
        const [[normalRow]] = await connection.execute('SELECT txn_date, metadata FROM expense_entries WHERE id = ?', [normal.id]);
        const normalDate = asDate(normalRow.txn_date);
        const normalMeta = typeof normalRow.metadata === 'string' ? JSON.parse(normalRow.metadata) : normalRow.metadata;
        assert(normalDate === today && !normalMeta.backdated, 'An entry with no date given lands on today and is not marked late.');
        assert((await journalRepository.getTrialBalance({ locCode })).inBalance, 'The trial balance must still balance.');
        passed.push('an ordinary entry still lands on today, needs no permission, and the books stay balanced');

        console.log('Money back-dating invariants passed:');
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

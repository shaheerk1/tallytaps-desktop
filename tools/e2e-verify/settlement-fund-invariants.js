/**
 * Money received into a named fund reaches that fund straight away.
 *
 * Runs inside one real transaction against the real schema and rolls back.
 *
 * A collection taken on card names the bank account it was received into. That
 * used to be recorded on the payment and nowhere else, so the fund kept
 * reading 0.00 until somebody pressed Refresh books -- money that was in the
 * bank looked like money that had never arrived.
 *
 *   1. a card collection into a bank fund raises that fund by the amount;
 *   2. the later accounting refresh finds that row and never doubles it;
 *   3. a cash collection still belongs to the drawer, not to a fund.
 */
const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createDocumentSequenceRepository } = require('../../packages/database/repositories/document-sequence.repository');
const { createBusinessDayRepository } = require('../../packages/database/repositories/business-day.repository');
const { createInventoryLedgerRepository } = require('../../packages/database/repositories/inventory-ledger.repository');
const { createExpenseRepository } = require('../../packages/database/repositories/expense.repository');
const { createJournalRepository } = require('../../packages/database/repositories/journal.repository');
const { createBillingRepository } = require('../../packages/database/repositories/billing.repository');
const { recordFundMovementWithConnection } = require('../../packages/database/repositories/fund-movement');

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
      const expenses = createExpenseRepository({
        database, documentSequenceRepository, businessDayRepository,
        journalRepository: createJournalRepository({ database, documentSequenceRepository })
      });
      const billing = createBillingRepository({
        database, documentSequenceRepository, businessDayRepository,
        inventoryLedgerRepository: createInventoryLedgerRepository({ database })
      });

      try {
        const [[user]] = await connection.execute("SELECT id FROM users WHERE status = 'active' ORDER BY id LIMIT 1");
        const stamp = String(Date.now()).slice(-8);
        const locCode = `FM${stamp}`;
        const macCode = 'T1';
        const txnDate = '2099-11-03';

        await connection.execute("INSERT INTO pos_locations (loc_code, business_code, name) VALUES (?, 'VERIFY', 'Fund movement location')", [locCode]);
        const [ws] = await connection.execute("INSERT INTO pos_workstations (location_code, machine_code, name) VALUES (?, ?, 'Counter')", [locCode, macCode]);
        const [day] = await connection.execute(
          "INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES (?, ?, 'open', ?)", [locCode, txnDate, user.id]
        );
        await connection.execute('INSERT INTO workstation_sessions (workstation_id, user_id, billing_date) VALUES (?, ?, ?)', [ws.insertId, user.id, txnDate]);
        const [party] = await connection.execute(
          "INSERT INTO parties (loc_code, mac_code, party_no, party_number, party_type, display_name) VALUES (?, ?, 1, ?, 'person', 'Fund customer')",
          [locCode, macCode, `P-${locCode}`]
        );
        const [account] = await connection.execute(
          "INSERT INTO customer_accounts (party_id, account_no, account_number, loc_code, mac_code, status, credit_enabled, credit_limit) VALUES (?, 1, ?, ?, ?, 'active', 1, 500000)",
          [party.insertId, `CA-${locCode}`, locCode, macCode]
        );
        const [fund] = await connection.execute(
          "INSERT INTO fund_accounts (fund_code, name, fund_kind, loc_code, opening_balance) VALUES (?, 'Verify bank', 'bank', ?, 0)",
          [`FUND-${locCode}`, locCode]
        );
        const fundId = Number(fund.insertId);

        // A sale left entirely on credit, so there is a balance to collect.
        const total = 50000;
        const [invoice] = await connection.execute(
          `INSERT INTO invoices (business_day_id, invoice_number, loc_code, mac_code, receipt_no, txn_date, user_id,
             customer_account_id, status, subtotal, merchandise_total, grand_total, paid_total, balance, inv_stat)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'partial', ?, ?, ?, 0, ?, 'active')`,
          [day.insertId, `INV-${locCode}-1`, locCode, macCode, txnDate, user.id, account.insertId, total, total, total, total]
        );
        await connection.execute(
          `INSERT INTO customer_receivable_entries (business_day_id, customer_account_id, loc_code, mac_code, txn_date,
             document_type, document_no, entry_no, invoice_id, entry_type, amount, reason)
           VALUES (?, ?, ?, ?, ?, 'sale', 1, 1, ?, 'sale_debit', ?, 'Credit sale')`,
          [day.insertId, account.insertId, locCode, macCode, txnDate, invoice.insertId, total]
        );

        const origin = { locCode, macCode, businessDate: txnDate };
        const fundBalance = async () => {
          const [held] = await expenses.loadFundsWithConnection(connection, { locCode, includeInactive: true, fundId });
          return money(held.balance);
        };
        const movementsForFund = async () => {
          const [rows] = await connection.execute(
            'SELECT id, direction, amount, source_type, source_id FROM fund_movements WHERE fund_account_id = ? ORDER BY id', [fundId]
          );
          return rows;
        };

        assert(await fundBalance() === 0, 'A new fund starts empty.');

        // -- 1. A card collection lands in the fund it named --
        await billing.collectInvoiceBalance({
          invoiceId: Number(invoice.insertId), userId: user.id, origin, cashShiftId: null, cashMovements: [],
          payments: [{ method: 'card', amount: 20000, fundAccountId: fundId }]
        });
        assert(await fundBalance() === 20000, `The fund must hold the collection straight away, got ${await fundBalance()}.`);
        const afterCard = await movementsForFund();
        assert(afterCard.length === 1, `One collection must write one fund movement, got ${afterCard.length}.`);
        assert(afterCard[0].direction === 'in', 'Money collected moves into the fund.');
        assert(money(afterCard[0].amount) === 20000, 'The movement carries the amount collected.');
        passed.push('a card collection raises the fund it was received into, with no refresh needed');

        // -- 2. The accounting refresh does not double it --
        const rederived = await recordFundMovementWithConnection(connection, {
          fundAccountId: fundId, businessDayId: day.insertId, locCode, macCode, txnDate,
          direction: 'in', amount: 20000, sourceType: afterCard[0].source_type, sourceId: afterCard[0].source_id,
          reason: 'Refresh books replay', userId: user.id
        });
        assert(Number(rederived) === Number(afterCard[0].id), 'Re-deriving the same settlement must find the row already there.');
        assert((await movementsForFund()).length === 1, 'Refreshing the books must not add a second movement.');
        assert(await fundBalance() === 20000, 'The fund balance must not double when the books are refreshed.');
        passed.push('refreshing the books finds the movement already posted and never doubles it');

        // -- 3. Cash belongs to the drawer, not to a fund --
        await billing.collectInvoiceBalance({
          invoiceId: Number(invoice.insertId), userId: user.id, origin, cashShiftId: null, cashMovements: [],
          payments: [{ method: 'cash', amount: 10000, fundAccountId: null }]
        });
        assert((await movementsForFund()).length === 1, 'A cash collection belongs to the drawer shift and writes no fund movement.');
        assert(await fundBalance() === 20000, 'A cash collection must not touch a bank fund.');
        passed.push('a cash collection still belongs to the drawer and leaves funds alone');

        console.log('Settlement fund invariants passed:');
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

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

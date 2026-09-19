/**
 * A refund never leaves a customer owing money.
 *
 * Runs inside one real transaction against the real schema and rolls back.
 *
 * A refund cancels what the customer still owed on the bill and hands back what
 * they had paid. The money handed back is theirs already, so it must never be
 * charged to their account. It used to be posted as a refund_debit with nothing
 * to cancel it, so a bill paid in full and refunded in full left the customer
 * owing the whole amount.
 *
 *   1. a bill paid in full, refunded in full: the customer owes nothing;
 *   2. a bill left entirely on credit, refunded: the debt is cancelled;
 *   3. a bill part paid, refunded: the debt is cancelled and only the paid part
 *      is handed back, and the customer owes nothing;
 *   4. no refund posts a debit to the customer's account.
 */
const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createDocumentSequenceRepository } = require('../../packages/database/repositories/document-sequence.repository');
const { createBusinessDayRepository } = require('../../packages/database/repositories/business-day.repository');
const { createInventoryLedgerRepository } = require('../../packages/database/repositories/inventory-ledger.repository');
const { createRefundRepository } = require('../../packages/database/repositories/refund.repository');

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
      const refunds = createRefundRepository({
        database, documentSequenceRepository, businessDayRepository,
        inventoryLedgerRepository: createInventoryLedgerRepository({ database })
      });

      try {
        const [[user]] = await connection.execute("SELECT id FROM users WHERE status = 'active' ORDER BY id LIMIT 1");
        const stamp = String(Date.now()).slice(-8);
        const locCode = `RF${stamp}`;
        const macCode = 'T1';
        const txnDate = '2099-11-02';

        await connection.execute("INSERT INTO pos_locations (loc_code, business_code, name) VALUES (?, 'VERIFY', 'Refund ledger location')", [locCode]);
        const [ws] = await connection.execute("INSERT INTO pos_workstations (location_code, machine_code, name) VALUES (?, ?, 'Counter')", [locCode, macCode]);
        const [day] = await connection.execute(
          "INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES (?, ?, 'open', ?)", [locCode, txnDate, user.id]
        );
        const [session] = await connection.execute('INSERT INTO workstation_sessions (workstation_id, user_id, billing_date) VALUES (?, ?, ?)', [ws.insertId, user.id, txnDate]);
        const [party] = await connection.execute(
          "INSERT INTO parties (loc_code, mac_code, party_no, party_number, party_type, display_name) VALUES (?, ?, 1, ?, 'person', 'Refund customer')",
          [locCode, macCode, `P-${locCode}`]
        );
        const [account] = await connection.execute(
          "INSERT INTO customer_accounts (party_id, account_no, account_number, loc_code, mac_code, status, credit_enabled, credit_limit) VALUES (?, 1, ?, ?, ?, 'active', 1, 100000)",
          [party.insertId, `CA-${locCode}`, locCode, macCode]
        );

        // A sale to this customer: `paid` taken at the counter, the rest owed.
        let receiptNo = 0;
        const sell = async ({ total, paid }) => {
          receiptNo += 1;
          const owedOnBill = money(total - paid);
          const [invoice] = await connection.execute(
            `INSERT INTO invoices (business_day_id, invoice_number, loc_code, mac_code, receipt_no, txn_date, user_id,
               customer_account_id, status, subtotal, merchandise_total, grand_total, paid_total, balance, inv_stat)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
            [day.insertId, `INV-${locCode}-${receiptNo}`, locCode, macCode, receiptNo, txnDate, user.id, account.insertId,
              owedOnBill > 0 ? 'partial' : 'paid', total, total, total, paid, owedOnBill]
          );
          const [item] = await connection.execute(
            `INSERT INTO invoice_items (business_day_id, invoice_id, loc_code, mac_code, receipt_no, txn_date, user_id, seq_no,
               item_code, description, quantity, unit_price, merchandise_total, total, inv_stat)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'VRF', 'Verify goods', 1, ?, ?, ?, 'active')`,
            [day.insertId, invoice.insertId, locCode, macCode, receiptNo, txnDate, user.id, total, total, total]
          );
          if (paid > 0) {
            await connection.execute(
              `INSERT INTO payments (business_day_id, invoice_id, loc_code, mac_code, txn_date, document_type, document_no,
                 receipt_no, payment_no, method, amount, status)
               VALUES (?, ?, ?, ?, ?, 'sale', ?, ?, 1, 'card', ?, 'completed')`,
              [day.insertId, invoice.insertId, locCode, macCode, txnDate, receiptNo, receiptNo, paid]
            );
          }
          if (owedOnBill > 0) {
            await connection.execute(
              `INSERT INTO customer_receivable_entries (business_day_id, customer_account_id, loc_code, mac_code, txn_date,
                 document_type, document_no, entry_no, invoice_id, entry_type, amount, reason)
               VALUES (?, ?, ?, ?, ?, 'sale', ?, 1, ?, 'sale_debit', ?, 'Credit sale')`,
              [day.insertId, account.insertId, locCode, macCode, txnDate, receiptNo, invoice.insertId, owedOnBill]
            );
          }
          return { id: Number(invoice.insertId), itemId: Number(item.insertId), total, paid, owedOnBill };
        };

        // Return every line of the bill, handing back what the counter took.
        const refundAll = async (bill) => {
          const draft = await refunds.createDraft({
            sourceInvoiceId: bill.id, sessionId: session.insertId, locCode, macCode, txnDate, userId: user.id, reason: 'Verify'
          });
          await refunds.saveDraftItem(draft.draftId, {
            sourceInvoiceItemId: bill.itemId, productId: null, itemCode: 'VRF', supplierCode: '', description: 'Verify goods',
            sourceQuantity: 1, sourceKilos: null, returnQuantity: 1, returnKilos: null, unitPrice: bill.total,
            sourceMerchandiseTotal: bill.total, sourceBagChargeTotal: 0, sourceWageChargeTotal: 0, discount: 0, tax: 0,
            merchandiseTotal: bill.total, bagChargeMode: 'proportional', bagChargeTotal: 0,
            wageChargeMode: 'proportional', wageChargeTotal: 0, total: bill.total, stockDisposition: 'damaged', metadata: {}
          });
          const handBack = money(bill.total - Math.min(bill.total, bill.owedOnBill));
          await refunds.finalizeDraft({
            draftId: draft.draftId, userId: user.id, reason: 'Verify',
            payments: handBack > 0 ? [{ method: 'card', amount: handBack }] : []
          });
          return handBack;
        };

        const owed = async () => {
          const [[row]] = await connection.execute(
            `SELECT COALESCE(SUM(CASE
                WHEN entry_type IN ('sale_debit','refund_debit','cheque_dishonour_debit','payment_reversal_debit') THEN amount
                WHEN entry_type IN ('collection_credit','return_credit','store_credit') THEN -amount ELSE 0 END), 0) AS balance
               FROM customer_receivable_entries WHERE customer_account_id = ?`, [account.insertId]
          );
          return money(row.balance);
        };
        const billBalance = async (id) => {
          const [[row]] = await connection.execute('SELECT balance FROM invoices WHERE id = ?', [id]);
          return money(row.balance);
        };

        // ── 1. Paid in full, refunded in full ──────────────
        const paidBill = await sell({ total: 2753, paid: 2753 });
        assert(await owed() === 0, 'A bill paid in full must leave nothing owed before the refund.');
        const handedBack = await refundAll(paidBill);
        assert(handedBack === 2753, `The whole bill must be handed back, got ${handedBack}.`);
        assert(await owed() === 0, `A bill paid in full and refunded in full must leave the customer owing nothing, got ${await owed()}.`);
        assert(await billBalance(paidBill.id) === 0, 'The refunded bill itself must show nothing outstanding.');
        passed.push('a bill paid in full and refunded in full leaves the customer owing nothing');

        // ── 2. Left entirely on credit, refunded ───────────
        const creditBill = await sell({ total: 1500, paid: 0 });
        assert(await owed() === 1500, `A credit sale must be owed before its refund, got ${await owed()}.`);
        const creditHandBack = await refundAll(creditBill);
        assert(creditHandBack === 0, 'Nothing is handed back for a bill that was never paid.');
        assert(await owed() === 0, `Refunding a credit sale must cancel the debt, got ${await owed()}.`);
        assert(await billBalance(creditBill.id) === 0, 'The refunded credit bill must show nothing outstanding.');
        passed.push('refunding a bill left on credit cancels the debt');

        // ── 3. Part paid, refunded ─────────────────────────
        const partBill = await sell({ total: 193270, paid: 770 });
        assert(await owed() === 192500, `A part-paid sale must owe its unpaid part, got ${await owed()}.`);
        const partHandBack = await refundAll(partBill);
        assert(partHandBack === 770, `Only the part that was paid may be handed back, got ${partHandBack}.`);
        assert(await owed() === 0, `A part-paid bill refunded in full must leave the customer owing nothing, got ${await owed()}.`);
        passed.push('a part-paid bill refunded cancels the debt and hands back only what was paid');

        // ── 4. No refund charges the customer ──────────────
        const [[debits]] = await connection.execute(
          "SELECT COUNT(*) AS n FROM customer_receivable_entries WHERE customer_account_id = ? AND entry_type = 'refund_debit'", [account.insertId]
        );
        assert(Number(debits.n) === 0, `A refund must never post a debit to the customer, found ${debits.n}.`);
        passed.push('no refund posts a debit to the customer’s account');

        console.log('Customer refund ledger invariants passed:');
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

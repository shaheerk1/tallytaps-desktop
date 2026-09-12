/**
 * A returned bill is a reversed sale, not a sale.
 *
 * Runs inside one real transaction against the real schema and rolls back.
 *
 *   1. a bill with nothing returned is an ordinary sale;
 *   2. a bill where part came back stays in the default list, marked, and
 *      carries what it is now worth;
 *   3. a bill returned in full is left out of the default list;
 *   4. asking for returned bills brings it back, marked as returned;
 *   5. the money actually handed back is tracked apart from the value returned,
 *      because a credit sale can be returned without any cash leaving.
 */
const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createBillingRepository } = require('../../packages/database/repositories/billing.repository');

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
      const billing = createBillingRepository({ database: { withConnection: async (work) => work(tx) } });

      try {
        const [[user]] = await connection.execute("SELECT id FROM users WHERE status = 'active' ORDER BY id LIMIT 1");
        const stamp = String(Date.now()).slice(-8);
        const locCode = `RF${stamp}`;
        const macCode = 'T1';
        const txnDate = '2099-10-01';

        await connection.execute("INSERT INTO pos_locations (loc_code, business_code, name) VALUES (?, 'VERIFY', 'Refund view location')", [locCode]);
        const [day] = await connection.execute(
          "INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES (?, ?, 'open', ?)", [locCode, txnDate, user.id]
        );

        // Three bills of 1000 each, two lines apiece.
        const bills = [];
        for (const receiptNo of [1, 2, 3]) {
          const [invoice] = await connection.execute(
            `INSERT INTO invoices (business_day_id, invoice_number, loc_code, mac_code, receipt_no, txn_date, user_id,
               status, subtotal, merchandise_total, grand_total, paid_total, balance, inv_stat)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', 1000, 1000, 1000, 1000, 0, 'active')`,
            [day.insertId, `INV-${locCode}-${receiptNo}`, locCode, macCode, receiptNo, txnDate, user.id]
          );
          const lines = [];
          for (const lineNo of [1, 2]) {
            const [line] = await connection.execute(
              `INSERT INTO invoice_items (invoice_id, business_day_id, loc_code, mac_code, txn_date, receipt_no, seq_no,
                 item_code, description, quantity, unit_price, merchandise_total, total, inv_stat)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Rice', 1, 500, 500, 500, 'active')`,
              [invoice.insertId, day.insertId, locCode, macCode, txnDate, receiptNo, lineNo, `ITEM-${lineNo}`]
            );
            lines.push(Number(line.insertId));
          }
          bills.push({ id: Number(invoice.insertId), number: `INV-${locCode}-${receiptNo}`, receiptNo, lines });
        }

        const recordReturn = async ({ bill, lines, value, cashBack, refundNo }) => {
          const [refund] = await connection.execute(
            `INSERT INTO refunds (business_day_id, refund_number, source_invoice_id, source_invoice_number, loc_code, mac_code,
               refund_no, txn_date, status, reason, subtotal, merchandise_total, grand_total, refunded_total, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', 'Verification return', ?, ?, ?, ?, ?)`,
            [day.insertId, `REF-${locCode}-${refundNo}`, bill.id, bill.number, locCode, macCode,
              refundNo, txnDate, value, value, value, cashBack, user.id]
          );
          for (const [index, lineId] of lines.entries()) {
            await connection.execute(
              `INSERT INTO refund_items (refund_id, loc_code, mac_code, txn_date, refund_no, line_no, source_invoice_item_id,
                 item_code, description, source_quantity, return_quantity, unit_price, merchandise_total, total)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'ITEM', 'Rice', 1, 1, 500, ?, ?)`,
              [refund.insertId, locCode, macCode, txnDate, refundNo, index + 1, lineId,
                money(value / lines.length), money(value / lines.length)]
            );
          }
        };

        // Bill 2: one of its two lines came back. Bill 3: the whole thing did.
        await recordReturn({ bill: bills[1], lines: [bills[1].lines[0]], value: 500, cashBack: 500, refundNo: 1 });
        await recordReturn({ bill: bills[2], lines: bills[2].lines, value: 1000, cashBack: 0, refundNo: 2 });

        const listed = async (includeRefunded) => {
          const rows = await billing.searchInvoices({ locCode, txnDate, includeRefunded });
          return new Map(rows.map((row) => [row.invoice_number, row]));
        };

        // ── The default list ───────────────────────────────
        const standing = await listed(false);
        const whole = standing.get(bills[0].number);
        assert(whole && whole.refundStatus === 'none' && money(whole.netTotal) === 1000,
          'A bill with nothing returned is an ordinary sale worth its full value.');
        passed.push('a bill with nothing returned is listed as an ordinary sale');

        const part = standing.get(bills[1].number);
        assert(part, 'A bill where only part came back must stay in the default list.');
        assert(part.refundStatus === 'partial', `That bill must read as partly returned, got ${part?.refundStatus}.`);
        assert(money(part.netTotal) === 500 && money(part.refundedTotal) === 500,
          `Its net value must be 500 after a 500 return, got ${money(part.netTotal)}.`);
        assert(money(part.netCollected) === 500, `What the shop kept must be 500, got ${money(part.netCollected)}.`);
        passed.push('a bill where part came back stays in the list, marked, worth what is left of it');

        assert(!standing.has(bills[2].number), 'A bill returned in full must not sit among the sales that stood.');
        passed.push('a bill returned in full is left out of the default list');

        // ── Asking for the returned ones ──────────────────
        const everything = await listed(true);
        const reversed = everything.get(bills[2].number);
        assert(reversed && reversed.refundStatus === 'full', 'Asking for returned bills must bring the reversed one back, marked.');
        assert(money(reversed.netTotal) === 0, `A fully returned bill is worth nothing, got ${money(reversed.netTotal)}.`);
        assert(everything.size === 3, `Showing returned bills must list all three, got ${everything.size}.`);
        passed.push('asking for returned bills shows every bill, with the reversed one marked and worth nothing');

        // ── Value returned versus money handed back ───────
        assert(money(reversed.refundedTotal) === 1000 && money(reversed.refundedCashTotal) === 0,
          'Goods can come back without cash leaving: the two figures are kept apart.');
        assert(money(reversed.netCollected) === 1000,
          'No cash was handed back on that bill, so what was collected is unchanged.');
        passed.push('the value returned and the money handed back are tracked separately');

        console.log('Refund visibility invariants passed:');
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

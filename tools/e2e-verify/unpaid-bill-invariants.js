/**
 * A bill said to be paid, when the money never arrived.
 *
 * Runs inside one real transaction against the real schema and rolls back.
 *
 *   1. a cash bill can be moved back to unpaid while its shift is open: the
 *      balance returns, the drawer is corrected, and the customer owes it;
 *   2. part of a bill can be moved, leaving the rest settled;
 *   3. the customer's account balance rises by exactly what was moved;
 *   4. the day's takings by method net out to what was really taken;
 *   5. a bill with no customer is refused — a debt has to belong to somebody;
 *   6. more than was ever collected is refused;
 *   7. cash whose shift has been closed and counted is refused;
 *   8. a cheque is sent to the dishonour path instead;
 *   9. collecting the amount later settles the bill again.
 */
const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createDocumentSequenceRepository } = require('../../packages/database/repositories/document-sequence.repository');
const { createBusinessDayRepository } = require('../../packages/database/repositories/business-day.repository');
const { createBillingRepository } = require('../../packages/database/repositories/billing.repository');

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

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
      const billing = createBillingRepository({ database, documentSequenceRepository, businessDayRepository });

      try {
        const [[user]] = await connection.execute("SELECT id FROM users WHERE status = 'active' ORDER BY id LIMIT 1");
        const stamp = String(Date.now()).slice(-8);
        const locCode = `UP${stamp}`;
        const macCode = 'T1';
        const txnDate = '2099-11-01';
        const origin = { locCode, macCode, txnDate };

        await connection.execute("INSERT INTO pos_locations (loc_code, business_code, name) VALUES (?, 'VERIFY', 'Unpaid bill location')", [locCode]);
        const [ws] = await connection.execute("INSERT INTO pos_workstations (location_code, machine_code, name) VALUES (?, ?, 'Counter')", [locCode, macCode]);
        const [day] = await connection.execute(
          "INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES (?, ?, 'open', ?)", [locCode, txnDate, user.id]
        );
        const [drawer] = await connection.execute("INSERT INTO cash_drawers (workstation_id, name) VALUES (?, 'Drawer')", [ws.insertId]);
        const [session] = await connection.execute('INSERT INTO workstation_sessions (workstation_id, user_id, billing_date) VALUES (?, ?, ?)', [ws.insertId, user.id, txnDate]);
        const [shift] = await connection.execute(
          `INSERT INTO cash_shifts (business_day_id, drawer_id, workstation_session_id, workstation_id, user_id, loc_code, mac_code, shift_no, business_date, status, opening_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'open', 0)`, [day.insertId, drawer.insertId, session.insertId, ws.insertId, user.id, locCode, macCode, txnDate]
        );

        // A customer to carry the debt.
        const [party] = await connection.execute(
          "INSERT INTO parties (loc_code, mac_code, party_no, party_number, party_type, display_name) VALUES (?, ?, 1, ?, 'person', 'Verify customer')",
          [locCode, macCode, `P-${locCode}`]
        );
        const [account] = await connection.execute(
          "INSERT INTO customer_accounts (party_id, account_no, account_number, loc_code, mac_code, status, credit_enabled, credit_limit) VALUES (?, 1, ?, ?, ?, 'active', 1, 100000)",
          [party.insertId, `CA-${locCode}`, locCode, macCode]
        );

        let receiptNo = 0;
        const sell = async ({ method = 'cash', total = 1000, withCustomer = true, shiftId = shift.insertId }) => {
          receiptNo += 1;
          const [invoice] = await connection.execute(
            `INSERT INTO invoices (business_day_id, invoice_number, loc_code, mac_code, receipt_no, txn_date, user_id, cash_shift_id,
               customer_account_id, status, subtotal, merchandise_total, grand_total, paid_total, balance, inv_stat)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?, 0, 'active')`,
            [day.insertId, `INV-${locCode}-${receiptNo}`, locCode, macCode, receiptNo, txnDate, user.id, shiftId,
              withCustomer ? account.insertId : null, total, total, total, total]
          );
          await connection.execute(
            `INSERT INTO payments (business_day_id, invoice_id, loc_code, mac_code, txn_date, document_type, document_no,
               receipt_no, payment_no, method, amount, status)
             VALUES (?, ?, ?, ?, ?, 'sale', ?, ?, 1, ?, ?, 'completed')`,
            [day.insertId, invoice.insertId, locCode, macCode, txnDate, receiptNo, receiptNo, method, total]
          );
          if (method === 'cash') {
            const [[shiftRow]] = await connection.execute('SELECT shift_no FROM cash_shifts WHERE id = ?', [shiftId]);
            const [numbers] = await connection.execute('SELECT COALESCE(MAX(movement_no), 0) AS max_no FROM cash_movements WHERE cash_shift_id = ?', [shiftId]);
            await connection.execute(
              `INSERT INTO cash_movements (cash_shift_id, loc_code, mac_code, business_date, shift_no, movement_no,
                 movement_type, direction, amount, reference_type, reference_id, reason, created_by)
               VALUES (?, ?, ?, ?, ?, ?, 'sale_cash', 'in', ?, 'invoice', ?, 'Sale', ?)`,
              [shiftId, locCode, macCode, txnDate, Number(shiftRow.shift_no), Number(numbers[0].max_no || 0) + 1,
                total, String(invoice.insertId), user.id]
            );
          }
          return { id: Number(invoice.insertId), number: `INV-${locCode}-${receiptNo}`, total };
        };

        const drawerExpected = async (shiftId = shift.insertId) => {
          const [[row]] = await connection.execute(
            `SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END), 0) AS net
               FROM cash_movements WHERE cash_shift_id = ? AND status = 'active'`, [shiftId]
          );
          return money(row.net);
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
        const billState = async (id) => {
          const [[row]] = await connection.execute('SELECT status, paid_total, balance FROM invoices WHERE id = ?', [id]);
          return { status: row.status, paid: money(row.paid_total), balance: money(row.balance) };
        };

        // ── 1. The card declined after the receipt printed ─
        const declined = await sell({ method: 'card', total: 1000 });
        const cashSale = await sell({ method: 'cash', total: 2000 });
        const cashInDrawer = await drawerExpected();
        const cardBack = await billing.unsettleInvoice({
          invoiceId: declined.id, amount: 1000, reason: 'Card declined after the receipt printed', userId: user.id, origin
        });
        const afterCard = await billState(declined.id);
        assert(afterCard.status === 'partial' && afterCard.paid === 0 && afterCard.balance === 1000,
          `The bill must read as part paid and owed in full, got ${JSON.stringify(afterCard)}.`);
        assert(money(cardBack.drawerCorrected || 0) === 0, 'A card payment must not touch the drawer.');
        assert(await drawerExpected() === cashInDrawer, 'The drawer must be untouched by a card reversal.');
        assert(await owed() === 1000, `The customer must owe 1000, got ${await owed()}.`);
        passed.push('a card payment that never arrived puts the bill back to owed without touching the drawer');

        // ── 2 & 3. Cash, part of a bill ───────────────────
        const cashBack = await billing.unsettleInvoice({
          invoiceId: cashSale.id, amount: 500, reason: 'Cash counted short at the drawer', userId: user.id, origin
        });
        const afterCash = await billState(cashSale.id);
        assert(afterCash.paid === 1500 && afterCash.balance === 500 && afterCash.status === 'partial',
          `Only part moves: 1500 paid, 500 owed, got ${JSON.stringify(afterCash)}.`);
        assert(money(cashBack.drawerCorrected) === 500, 'The drawer correction must equal the cash taken back.');
        assert(await drawerExpected() === money(cashInDrawer - 500), 'The drawer must expect 500 less.');
        passed.push('part of a bill can be moved back, leaving the rest settled');
        assert(await owed() === 1500, `The customer must now owe 1500, got ${await owed()}.`);
        passed.push('the customer account carries exactly what was moved');

        // ── 4. The day's takings ──────────────────────────
        const [[takings]] = await connection.execute(
          `SELECT COALESCE(SUM(amount), 0) AS net FROM payments WHERE business_day_id = ? AND status = 'completed'`, [day.insertId]
        );
        assert(money(takings.net) === 1500, `Takings must net to 1500 after the reversals, got ${money(takings.net)}.`);
        passed.push("the day's takings net out to what was really taken");

        // ── 5. Nobody to own the debt ─────────────────────
        const walkIn = await sell({ method: 'cash', total: 300, withCustomer: false });
        await expectRejection(() => billing.unsettleInvoice({
          invoiceId: walkIn.id, amount: 300, reason: 'Customer walked out', userId: user.id, origin
        }), /Link a customer/, 'Marking a bill with no customer unpaid');
        passed.push('a bill with no customer is refused: an unpaid amount has to belong to somebody');

        // ── 6. More than was ever collected ───────────────
        await expectRejection(() => billing.unsettleInvoice({
          invoiceId: declined.id, amount: 50, reason: 'Again', userId: user.id, origin
        }), /was ever collected/, 'Moving more than was collected');
        passed.push('more than was ever collected on the bill is refused');

        // ── 7. A shift that was already counted ───────────
        const [closedShift] = await connection.execute(
          `INSERT INTO cash_shifts (business_day_id, drawer_id, workstation_session_id, workstation_id, user_id, loc_code, mac_code, shift_no, business_date, status, opening_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, 2, ?, 'closed', 0)`, [day.insertId, drawer.insertId, session.insertId, ws.insertId, user.id, locCode, macCode, txnDate]
        );
        const countedSale = await sell({ method: 'cash', total: 700, shiftId: closedShift.insertId });
        await expectRejection(() => billing.unsettleInvoice({
          invoiceId: countedSale.id, amount: 700, reason: 'Found short next morning', userId: user.id, origin
        }), /closed and counted/, 'Taking cash out of a counted shift');
        const untouched = await billState(countedSale.id);
        assert(untouched.status === 'paid' && untouched.balance === 0, 'A refused reversal must leave the bill exactly as it was.');
        passed.push('cash whose shift was closed and counted is refused, and the bill is left alone');

        // ── 8. Cheques have their own path ────────────────
        const chequeSale = await sell({ method: 'cheque', total: 900 });
        await expectRejection(() => billing.unsettleInvoice({
          invoiceId: chequeSale.id, amount: 900, reason: 'Cheque bounced', userId: user.id, origin
        }), /dishonour/, 'Marking a cheque bill unpaid');
        passed.push('a cheque is sent to the dishonour path, which already puts the balance back');

        // ── 9. Collecting it later ────────────────────────
        await billing.collectInvoiceBalance({
          invoiceId: declined.id, userId: user.id,
          payments: [{ method: 'cash', amount: 1000 }],
          cashShiftId: shift.insertId,
          cashMovements: [{ movementType: 'receivable_collection_cash', direction: 'in', amount: 1000 }],
          origin: { locCode, macCode, businessDate: txnDate }
        });
        const settled = await billState(declined.id);
        assert(settled.status === 'paid' && settled.balance === 0, `Collecting the debt must settle the bill, got ${JSON.stringify(settled)}.`);
        assert(await owed() === 500, `The customer should be left owing 500, got ${await owed()}.`);
        passed.push('collecting the amount later settles the bill and clears the debt');

        console.log('Unpaid bill invariants passed:');
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

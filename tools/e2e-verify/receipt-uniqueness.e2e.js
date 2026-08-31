const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createWorkstationRepository } = require('../../packages/database/repositories/workstation.repository');
const { createBillingRepository } = require('../../packages/database/repositories/billing.repository');
const { createLiveBillRepository } = require('../../packages/database/repositories/live-bill.repository');
const { createCatalogRepository } = require('../../packages/database/repositories/catalog.repository');
const { createBillingEngineService } = require('../../packages/core/billing/billing-engine.service');
const { createPaymentModeRegistry } = require('../../packages/core/payments/payment-mode-registry');

async function main() {
  const database = createDatabase();
  const workstationRepository = createWorkstationRepository({ database });
  const billingRepository = createBillingRepository({ database });
  const liveBillRepository = createLiveBillRepository({ database });
  const catalogRepository = createCatalogRepository({ database });
  const paymentModes = createPaymentModeRegistry();
  const billingEngine = createBillingEngineService({
    liveBillRepository,
    billingRepository,
    catalogRepository,
    workstationRepository,
    paymentModes,
    eventBus: null
  });

  const results = [];
  const log = (label, ok, detail) => {
    results.push({ label, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  };

  const txnDate = '2026-07-31';
  const locCode = 'E2E';
  const macCode = 'UNIQ';

  let workstationId = null;
  let sessionId = null;
  let receiptNo = null;
  let userId = null;

  async function openItemBill() {
    const bill = await billingEngine.openBill({
      sessionId,
      locationCode: locCode,
      machineCode: macCode,
      billingDate: txnDate,
      userId
    });
    await billingEngine.addItem(bill, { itemCode: 'A001', description: 'Item Alpha', qty: 2, unitPrice: 10, discount: 1, tax: 0.5 });
    await billingEngine.addItem(bill, { itemCode: 'A002', description: 'Item Beta', qty: 1, unitPrice: 25, discount: 0, tax: 2.5 });
    return bill;
  }

  async function tryFinalize(bill, payments) {
    try {
      const result = await billingEngine.finalizeBill({
        locCode, macCode, txnDate, receiptNo: bill.receiptNo, sessionId, userId, payments
      });
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  try {
    // 1. Seed a throwaway workstation + user
    await database.withConnection(async (c) => {
      await c.execute('DELETE FROM pos_workstations WHERE location_code = ?', [locCode]);
      await c.execute("INSERT INTO pos_workstations (location_code, machine_code, name, status) VALUES (?, ?, 'E2E Uniqueness', 'active')", [locCode, macCode]);
      const [rows] = await c.execute('SELECT id FROM pos_workstations WHERE location_code = ?', [locCode]);
      workstationId = rows[0].id;
    });
    const [userRows] = await database.withConnection((c) => c.execute('SELECT id FROM users ORDER BY id LIMIT 1'));
    userId = userRows[0].id;

    // 2. Open session + bill
    const session = await workstationRepository.openSession({ workstationId, userId, billingDate: txnDate });
    sessionId = session.id;
    const bill = await billingEngine.openBill({
      sessionId,
      locationCode: locCode,
      machineCode: macCode,
      billingDate: txnDate,
      userId
    });
    receiptNo = bill.receiptNo;
    log('openBill allocates receipt', receiptNo > 0, `receiptNo=${receiptNo}`);

    // 3. Add two items
    await billingEngine.addItem(bill, { itemCode: 'A001', description: 'Item Alpha', qty: 2, unitPrice: 10, discount: 1, tax: 0.5 });
    await billingEngine.addItem(bill, { itemCode: 'A002', description: 'Item Beta', qty: 1, unitPrice: 25, discount: 0, tax: 2.5 });
    const items = await billingEngine.getItems(bill);
    log('two items persisted', items.length === 2, `count=${items.length}, seqs=${items.map(i => i.seqNo).join(',')}`);

    // 4. Finalize (total is 47: 19.5 + 27.5)
    const finalized = await billingEngine.finalizeBill({
      locCode, macCode, txnDate, receiptNo, sessionId, userId,
      payments: [{ method: 'cash', amount: 47 }]
    });
    log('finalize creates invoice', finalized.invoiceId > 0, `invoiceId=${finalized.invoiceId}, number=${finalized.invoiceNumber}`);

    // 5. Double-finalize must fail (invoice already exists for receipt)
    let secondFinalizeFailed = false;
    try {
      await billingEngine.finalizeBill({ locCode, macCode, txnDate, receiptNo, sessionId, userId, payments: [{ method: 'cash', amount: 47 }] });
    } catch (e) {
      secondFinalizeFailed = true;
    }
    log('duplicate finalize rejected', secondFinalizeFailed, '');

    // 6. Only one invoice + items backfilled, nothing duplicated
    const [invCount] = await database.withConnection((c) => c.execute(
      'SELECT COUNT(*) AS n FROM invoices WHERE loc_code = ? AND mac_code = ? AND txn_date = ? AND receipt_no = ?',
      [locCode, macCode, txnDate, receiptNo]
    ));
    const [itemRows] = await database.withConnection((c) => c.execute(
      'SELECT COUNT(*) AS n, COUNT(invoice_id) AS linked FROM invoice_items WHERE loc_code = ? AND mac_code = ? AND txn_date = ? AND receipt_no = ?',
      [locCode, macCode, txnDate, receiptNo]
    ));
    log('single invoice per receipt', invCount[0].n === 1, `invoices=${invCount[0].n}`);
    log('items backfilled exactly once', itemRows[0].n === 2 && itemRows[0].linked === 2, `items=${itemRows[0].n}, linked=${itemRows[0].linked}`);

    // 7. Duplicate seq_no line must be rejected by the unique key
    let dupLineRejected = false;
    try {
      await database.withConnection((c) => c.execute(
        `INSERT INTO invoice_items (invoice_id, loc_code, mac_code, receipt_no, txn_date, seq_no, item_code, description, quantity, unit_price, total, inv_stat, cre_by, upd_stat)
         VALUES (?, ?, ?, ?, ?, ?, 'X', 'dup', 1, 1, 1, 'active', ?, 1)`,
        [finalized.invoiceId, locCode, macCode, receiptNo, txnDate, items[0].seqNo, userId]
      ));
    } catch (e) {
      dupLineRejected = true;
    }
    log('duplicate line (same seq) rejected', dupLineRejected, '');

    // 8. Next receipt allocation skips the consumed number
    const next = await liveBillRepository.allocateNextReceiptNo({ locCode, macCode, txnDate, sessionId });
    log('next receipt monotonic', next > receiptNo, `next=${next}, used=${receiptNo}`);

    // 9. Payment mode registry exposes ordered core modes
    const modes = paymentModes.listModes();
    log(
      'registry lists core modes ordered by priority',
      modes.map((m) => m.id).join(',') === 'cash,card,pending' &&
        modes[0].type === 'tender' && modes[1].type === 'tender' && modes[2].type === 'credit',
      modes.map((m) => `${m.id}:${m.type}`).join(',')
    );

    // 10. Split tender (cash + card) settles as 'paid' with no balance/change
    const billSplit = await openItemBill();
    const splitRes = await tryFinalize(billSplit, [
      { method: 'cash', amount: 20 },
      { method: 'card', amount: 27 }
    ]);
    log(
      'split tender cash+card settles paid',
      splitRes.ok && splitRes.result.status === 'paid' &&
        splitRes.result.paidTotal === 47 && splitRes.result.balance === 0 && splitRes.result.changeAmt === 0,
      splitRes.ok ? `paid=${splitRes.result.paidTotal}, balance=${splitRes.result.balance}` : splitRes.error
    );

    // 11. Pending credit completes a partial receipt
    const billCredit = await openItemBill();
    const creditRes = await tryFinalize(billCredit, [
      { method: 'cash', amount: 20 },
      { method: 'pending', amount: 27 }
    ]);
    log(
      'pending credit completes receipt as partial',
      creditRes.ok && creditRes.result.status === 'partial' &&
        creditRes.result.paidTotal === 20 && creditRes.result.creditTotal === 27 &&
        creditRes.result.balance === 27,
      creditRes.ok
        ? `paid=${creditRes.result.paidTotal}, credit=${creditRes.result.creditTotal}, balance=${creditRes.result.balance}`
        : creditRes.error
    );
    if (creditRes.ok) {
      const [payRows] = await database.withConnection((c) => c.execute(
        'SELECT method, amount FROM payments WHERE invoice_id = ? ORDER BY method',
        [creditRes.result.invoiceId]
      ));
      log('credit payment row persisted',
        payRows.length === 2 && payRows.some((r) => r.method === 'pending' && Number(r.amount) === 27),
        payRows.map((r) => `${r.method}=${r.amount}`).join(', '));
    } else {
      log('credit payment row persisted', false, 'finalize failed');
    }

    // 12. Overpayment returns change and stays 'paid'
    const billOver = await openItemBill();
    const overRes = await tryFinalize(billOver, [{ method: 'cash', amount: 50 }]);
    log(
      'overpayment returns change',
      overRes.ok && overRes.result.status === 'paid' && overRes.result.changeAmt === 3 && overRes.result.balance === 0,
      overRes.ok ? `change=${overRes.result.changeAmt}` : overRes.error
    );

    // 13. Unregistered paymode is rejected
    const billBadMode = await openItemBill();
    const badModeRes = await tryFinalize(billBadMode, [{ method: 'cheque', amount: 47 }]);
    log('unknown paymode rejected', !badModeRes.ok, badModeRes.error || 'unexpectedly accepted');

    // 14. Credit cannot be used when tender already covers the total
    const billBadCredit = await openItemBill();
    const badCreditRes = await tryFinalize(billBadCredit, [
      { method: 'cash', amount: 47 },
      { method: 'pending', amount: 1 }
    ]);
    log('credit with tender covering total rejected', !badCreditRes.ok, badCreditRes.error || 'unexpectedly accepted');

    // 15. Short tender without a credit line is rejected
    const billShort = await openItemBill();
    const shortRes = await tryFinalize(billShort, [{ method: 'cash', amount: 20 }]);
    log('short tender without credit rejected', !shortRes.ok, shortRes.error || 'unexpectedly accepted');

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exitCode = failed.length > 0 ? 1 : 0;
  } finally {
    try {
      await database.withConnection(async (c) => {
        await c.execute('DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE loc_code = ? AND mac_code = ?)', [locCode, macCode]);
        await c.execute('DELETE FROM invoice_items WHERE loc_code = ? AND mac_code = ?', [locCode, macCode]);
        await c.execute('DELETE FROM invoices WHERE loc_code = ? AND mac_code = ?', [locCode, macCode]);
        await c.execute('DELETE FROM workstation_sessions WHERE workstation_id = ?', [workstationId]);
        await c.execute('DELETE FROM pos_workstations WHERE id = ?', [workstationId]);
      });
    } catch (cleanupErr) {
      console.error('Cleanup error:', cleanupErr.message);
    }
    await database.close();
    process.exit(process.exitCode || 0);
  }
}

main().catch((err) => {
  console.error('E2E FAILED:', err.message);
  process.exit(1);
});

const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createDocumentSequenceRepository } = require('../../packages/database/repositories/document-sequence.repository');
const { createLiveBillRepository } = require('../../packages/database/repositories/live-bill.repository');
const { createBillingRepository } = require('../../packages/database/repositories/billing.repository');
const { createRefundRepository } = require('../../packages/database/repositories/refund.repository');
const { createCashManagementRepository } = require('../../packages/database/repositories/cash-management.repository');
const { createCatalogRepository } = require('../../packages/database/repositories/catalog.repository');
const { createPartyRepository } = require('../../packages/database/repositories/party.repository');
const { createIssuedChequeRepository } = require('../../packages/database/repositories/issued-cheque.repository');
const { createBusinessDayRepository } = require('../../packages/database/repositories/business-day.repository');
const { createSupplierSaleStatementRepository } = require('../../packages/database/repositories/supplier-sale-statement.repository');
const { createInventoryLedgerRepository } = require('../../packages/database/repositories/inventory-ledger.repository');

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
      const sequences = createDocumentSequenceRepository({ database });
      const businessDays = createBusinessDayRepository({ database });
      const inventoryLedger = createInventoryLedgerRepository({ database });
      const issuedCheques = createIssuedChequeRepository({ database, documentSequenceRepository: sequences, businessDayRepository: businessDays });
      const liveBills = createLiveBillRepository({ database, documentSequenceRepository: sequences, businessDayRepository: businessDays });
      const billing = createBillingRepository({ database, businessDayRepository: businessDays, documentSequenceRepository: sequences, inventoryLedgerRepository: inventoryLedger });
      const refunds = createRefundRepository({ database, documentSequenceRepository: sequences, businessDayRepository: businessDays, inventoryLedgerRepository: inventoryLedger });
      const cash = createCashManagementRepository({ database, documentSequenceRepository: sequences, businessDayRepository: businessDays });
      const catalog = createCatalogRepository({ database, documentSequenceRepository: sequences, businessDayRepository: businessDays, issuedChequeRepository: issuedCheques, inventoryLedgerRepository: inventoryLedger });
      const parties = createPartyRepository({ database, businessDayRepository: businessDays });
      const pattiyals = createSupplierSaleStatementRepository({ database, documentSequenceRepository: sequences, businessDayRepository: businessDays });

      try {
        const [[context]] = await connection.execute(
          `SELECT w.id, w.location_code, w.machine_code,
                  ws.id AS session_id, ws.user_id, ws.billing_date
           FROM workstation_sessions ws
           JOIN pos_workstations w ON w.id = ws.workstation_id
           JOIN business_days d ON d.loc_code = w.location_code AND d.business_date = ws.billing_date AND d.status = 'open'
           WHERE ws.status = 'open'
           ORDER BY ws.id DESC LIMIT 1`
        );
        const workstation = context ? { id: context.id, location_code: context.location_code, machine_code: context.machine_code } : null;
        const session = context ? { id: context.session_id, user_id: context.user_id, billing_date: context.billing_date } : null;
        const [[supplier]] = await connection.execute('SELECT id, supplier_code FROM suppliers WHERE is_active = 1 ORDER BY id LIMIT 1');
        const [[product]] = await connection.execute('SELECT id, sku, name, unit_price, dual_uom_enabled, handling_uom, base_uom FROM products WHERE is_active = 1 ORDER BY id LIMIT 1');
        if (!workstation || !session || !supplier || !product) throw new Error('Smoke test requires a workstation session, supplier, and active product.');
        const locCode = workstation.location_code;
        const macCode = workstation.machine_code;
        const dateValue = session.billing_date;
        const txnDate = dateValue instanceof Date
          ? `${dateValue.getFullYear()}-${String(dateValue.getMonth() + 1).padStart(2, '0')}-${String(dateValue.getDate()).padStart(2, '0')}`
          : String(dateValue).slice(0, 10);
        const userId = session.user_id;
        const sharedMarketCode = 'SHARED-SMOKE';
        const firstCustomer = await parties.createCustomer({
          name: 'Origin smoke customer A', marketCodes: [sharedMarketCode], creditEnabled: true,
          origin: { locCode, macCode, txnDate }, userId
        }, { locCode, macCode, txnDate }, userId);
        const secondCustomer = await parties.createCustomer({
          name: 'Origin smoke customer B', marketCodes: [sharedMarketCode], creditEnabled: true,
          origin: { locCode, macCode, txnDate }, userId
        }, { locCode, macCode, txnDate }, userId);
        const sharedMatches = await parties.searchCustomerAccounts(sharedMarketCode, { outstandingOnly: false });
        if (![firstCustomer.customer.id, secondCustomer.customer.id].every((id) => sharedMatches.some((row) => Number(row.id) === Number(id)))) {
          throw new Error('A shared operational market code did not return both durable customer accounts.');
        }

        const draft = await catalog.saveGoodsReceiptDraft({
          supplierId: supplier.id, businessDate: txnDate, locCode, macCode, userId,
          lines: [{ productId: product.id, packageQty: 1, packageUnit: product.handling_uom, receivedKilos: product.dual_uom_enabled ? 1 : null, expectedBasePerHandling: product.dual_uom_enabled ? 1 : null, unitCost: 1 }]
        });
        await catalog.finalizeGoodsReceiptDraft({ goodsReceiptId: draft.id, userId });
        const correction = await catalog.createGoodsReceiptCorrection({ goodsReceiptId: draft.id, reason: 'Origin smoke correction', locCode, macCode, businessDate: txnDate, userId });
        await catalog.saveGoodsReceiptDraft({
          goodsReceiptId: correction.id, supplierId: supplier.id, businessDate: txnDate, locCode, macCode,
          documentType: 'correction', correctsGoodsReceiptId: draft.id, correctionReason: 'Origin smoke correction', userId,
          lines: [{ productId: product.id, packageQty: 2, packageUnit: product.handling_uom, receivedKilos: product.dual_uom_enabled ? 2 : null, expectedBasePerHandling: product.dual_uom_enabled ? 1 : null, unitCost: 1 }]
        });
        await catalog.finalizeGoodsReceiptDraft({ goodsReceiptId: correction.id, userId });
        await catalog.adjustStock({ productId: product.id, quantity: 1, businessDate: txnDate, locCode, macCode, reason: 'Origin smoke test', userId });
        await catalog.addSupplierCharge({ supplierId: supplier.id, chargeTypeId: (await connection.execute('SELECT id FROM supplier_charge_types WHERE is_active = 1 ORDER BY id LIMIT 1'))[0][0].id, amount: 1, businessDate: txnDate, locCode, macCode, reason: 'Origin smoke test', userId });
        const settlement = await catalog.createSupplierSettlement({ supplierId: supplier.id, fromDate: txnDate, toDate: txnDate, locCode, macCode, txnDate, userId });
        await catalog.approveSupplierSettlement(settlement.id, userId);
        await connection.execute("UPDATE supplier_settlements SET total_due = 2, paid_total = 0, status = 'approved' WHERE id = ?", [settlement.id]);
        await catalog.recordSupplierPayment({ settlementId: settlement.id, method: 'card', amount: 1, businessDate: txnDate, locCode, macCode, txnDate, userId });
        const bankAccount = await issuedCheques.saveBankAccount({
          bankName: 'Origin Smoke Bank', branchName: 'Test Branch', accountName: 'Origin Smoke Business',
          accountNumber: 'SMOKE-ACCOUNT-1', origin: { locCode, macCode, txnDate }, userId
        });
        const chequePayment = await catalog.recordSupplierPayment({
          settlementId: settlement.id, method: 'cheque', amount: 1, businessDate: txnDate, locCode, macCode, txnDate, userId,
          chequeDetails: { bankAccountId: bankAccount.id, chequeNumber: 'OUT-SMOKE-1', chequeDate: txnDate }
        });
        if (!chequePayment.issuedChequeId) throw new Error('Supplier cheque payment did not create an issued-cheque register entry.');
        const returnedCheque = await issuedCheques.updateIssuedChequeStatus({
          chequeId: chequePayment.issuedChequeId, status: 'returned_unpaid',
          reason: 'Rollback-only issued cheque reversal', userId, origin: { locCode, macCode, txnDate }
        });
        const [[reversedSupplierPayment]] = await connection.execute('SELECT status FROM supplier_payments WHERE id = ?', [chequePayment.id]);
        if (returnedCheque.cheque.status !== 'returned_unpaid' || reversedSupplierPayment.status !== 'reversed') {
          throw new Error('Returned issued cheque did not reverse its linked supplier payment.');
        }

        const [[lot]] = await connection.execute('SELECT id, remaining_handling_quantity, remaining_base_quantity FROM inventory_lots WHERE product_id = ? ORDER BY id DESC LIMIT 1', [product.id]);
        await catalog.finalizeStockCount({
          businessDate: txnDate, locCode, macCode, reason: 'Origin smoke test', userId,
          lines: [{ inventoryLotId: lot.id, countedQuantity: Number(lot.remaining_handling_quantity), countedKilos: lot.remaining_base_quantity }]
        });

        await connection.execute("UPDATE cash_shifts SET status = 'closed' WHERE workstation_id = ? AND status IN ('open','blind_closed')", [workstation.id]);
        const shift = await cash.createShift({ workstationSessionId: session.id, workstationId: workstation.id, userId, businessDate: txnDate, openingLines: [{ denomination: 100, quantity: 1 }] });
        await cash.addMovement({ shiftId: shift.id, movementType: 'cash_in', direction: 'in', amount: 1, reason: 'Origin smoke test', userId });
        await catalog.recordSupplierPayment({ settlementId: settlement.id, method: 'cash', amount: 1, businessDate: txnDate, locCode, macCode, txnDate, sessionId: session.id, userId });
        await cash.archiveReportPrint({ shiftId: shift.id, reportType: 'X', snapshot: { smoke: true }, printedBy: userId });
        await cash.submitClosingCount({ shiftId: shift.id, userId, lines: [{ denomination: 100, quantity: 1 }] });
        await cash.closeShift({ shiftId: shift.id, userId, varianceReason: 'Origin smoke variance' });
        await cash.archiveReportPrint({ shiftId: shift.id, reportType: 'Z', snapshot: { smoke: true }, printedBy: userId });

        const receiptNo = await liveBills.allocateNextReceiptNo({ locCode, macCode, txnDate, sessionId: session.id });
        const saleAmount = Math.max(2, Number(product.unit_price || 0));
        await liveBills.addItem({
          sessionId: session.id, receiptNo, locCode, macCode, txnDate, userId,
          productId: product.id, supplierCode: supplier.supplier_code || '', itemCode: product.sku, description: product.name, qty: 1,
          kilos: product.dual_uom_enabled ? 1 : null, handlingUom: product.handling_uom, baseUom: product.base_uom,
          unitPrice: saleAmount, discount: 0, merchandiseTotal: saleAmount, total: saleAmount
        });
        await liveBills.updateBillCustomer({
          locCode, macCode, txnDate, receiptNo, customerCode: sharedMarketCode,
          customerAccountId: firstCustomer.customer.id
        });
        const linkedLiveItems = await liveBills.getItemsByReceipt({ locCode, macCode, txnDate, receiptNo });
        if (linkedLiveItems[0]?.customerCode !== sharedMarketCode
          || Number(linkedLiveItems[0]?.customerAccountId) !== Number(firstCustomer.customer.id)) {
          throw new Error('Payment-stage customer linking did not update the live bill without replacing its market code.');
        }
        const sale = await billing.finalizeInvoice({
          locCode, macCode, txnDate, receiptNo, sessionId: session.id, userId,
          payments: [{ method: 'cheque', amount: saleAmount - 1, chequeDetails: {
            number: 'SMOKE-CHQ-1', date: txnDate, bankName: 'Smoke Bank', drawerName: 'Smoke Drawer'
          } }],
          customerAccountId: firstCustomer.customer.id,
          customerCode: sharedMarketCode,
          receivableSaleDebt: 1
        });
        const [[cheque]] = await connection.execute('SELECT * FROM cheques WHERE invoice_id = ? LIMIT 1', [sale.invoiceId]);
        if (!cheque || cheque.loc_code !== locCode || cheque.mac_code !== macCode
          || Number(cheque.received_from_customer_account_id) !== Number(firstCustomer.customer.id)) {
          throw new Error('Cheque register origin or liable customer link was not recorded correctly.');
        }
        const depositedCheque = await parties.updateChequeStatus({
          chequeId: cheque.id, status: 'deposited', depositedTo: 'Smoke deposit batch', userId,
          origin: { locCode, macCode, txnDate }
        });
        const clearedCheque = await parties.updateChequeStatus({
          chequeId: cheque.id, status: 'cleared', userId,
          origin: { locCode, macCode, txnDate }
        });
        if (depositedCheque.cheque.status !== 'deposited' || clearedCheque.cheque.status !== 'cleared'
          || clearedCheque.events.length < 3) {
          throw new Error('Cheque deposit/clear lifecycle did not preserve its audit events.');
        }
        const dishonourReceiptNo = await liveBills.allocateNextReceiptNo({ locCode, macCode, txnDate, sessionId: session.id });
        await liveBills.addItem({
          sessionId: session.id, receiptNo: dishonourReceiptNo, locCode, macCode, txnDate, userId,
          customerCode: sharedMarketCode, customerAccountId: firstCustomer.customer.id,
          productId: product.id, supplierCode: supplier.supplier_code || '', itemCode: product.sku,
          description: product.name, qty: 1, kilos: product.dual_uom_enabled ? 1 : null, handlingUom: product.handling_uom, baseUom: product.base_uom, unitPrice: saleAmount, discount: 0,
          merchandiseTotal: saleAmount, total: saleAmount
        });
        const dishonourSale = await billing.finalizeInvoice({
          locCode, macCode, txnDate, receiptNo: dishonourReceiptNo, sessionId: session.id, userId,
          payments: [{ method: 'cheque', amount: saleAmount, chequeDetails: {
            number: 'SMOKE-CHQ-2', date: txnDate, bankName: 'Smoke Bank', drawerName: 'Smoke Drawer'
          } }],
          customerAccountId: firstCustomer.customer.id, customerCode: sharedMarketCode
        });
        const [[dishonourCheque]] = await connection.execute('SELECT id FROM cheques WHERE invoice_id = ? LIMIT 1', [dishonourSale.invoiceId]);
        await parties.updateChequeStatus({
          chequeId: dishonourCheque.id, status: 'dishonoured', reason: 'Rollback-only dishonour verification', userId,
          origin: { locCode, macCode, txnDate }
        });
        const [[restoredInvoice]] = await connection.execute('SELECT balance, paid_total FROM invoices WHERE id = ?', [dishonourSale.invoiceId]);
        const [[dishonourLedger]] = await connection.execute(
          `SELECT COUNT(*) AS entry_count FROM customer_receivable_entries
           WHERE invoice_id = ? AND entry_type = 'cheque_dishonour_debit'`,
          [dishonourSale.invoiceId]
        );
        if (Number(restoredInvoice.balance) !== Number(saleAmount) || Number(restoredInvoice.paid_total) !== 0
          || Number(dishonourLedger.entry_count) !== 1) {
          throw new Error('Cheque dishonour did not restore the invoice receivable exactly once.');
        }
        const [[payableBeforePattiyal]] = await connection.execute(
          'SELECT COUNT(*) AS entry_count, COALESCE(SUM(amount), 0) AS amount FROM supplier_payable_entries'
        );
        const candidateResult = await pattiyals.listCandidates({
          supplierId: supplier.id, scope: 'supplier', fromDate: txnDate, toDate: txnDate, limit: 100
        });
        const saleCandidate = candidateResult.rows.find((row) => Number(row.invoiceId) === Number(sale.invoiceId));
        if (!saleCandidate) throw new Error('Pattiyal smoke test could not find its finalized sale line.');
        const attribution = await pattiyals.setInvoiceItemAttribution({
          invoiceItemId: saleCandidate.invoiceItemId,
          supplierId: supplier.id,
          reason: 'Origin smoke attribution audit',
          userId
        });
        if (Number(attribution.supplierId) !== Number(supplier.id)
          || String(attribution.originalSupplierCode || '') !== String(supplier.supplier_code || '')) {
          throw new Error('Pattiyal supplier attribution audit did not preserve the billed supplier snapshot.');
        }
        const pattiyal = await pattiyals.saveDraft({
          supplierId: supplier.id,
          fromDate: txnDate,
          toDate: txnDate,
          locCode,
          macCode,
          txnDate,
          userId,
          commissionRate: 3,
          commissionRounding: 'floor_rupee',
          grnIds: [correction.id],
          allocations: [{
            invoiceItemId: saleCandidate.invoiceItemId,
            allocatedQuantity: saleCandidate.availableQuantity,
            allocatedKilos: saleCandidate.availableKilos,
            merchandiseAmount: saleCandidate.availableMerchandise
          }],
          manualLines: [{
            productId: product.id,
            itemCode: product.sku,
            description: `${product.name} manual comparison`,
            pricingBasis: 'qty',
            unitPrice: 0,
            quantity: 1,
            kilos: null,
            merchandiseAmount: 0,
            reason: 'Origin smoke comparison row'
          }],
          adjustments: [{ adjustmentType: 'deduction', label: 'Smoke deduction', amount: 1, note: 'Rollback-only check' }]
        });
        const reviewedPattiyal = await pattiyals.reviewStatement(pattiyal.statement.id, userId);
        const finalizedPattiyal = await pattiyals.finalizeStatement(reviewedPattiyal.statement.id, userId);
        if (finalizedPattiyal.statement.status !== 'finalized'
          || finalizedPattiyal.statement.financial_posting_status !== 'evaluation_only'
          || finalizedPattiyal.allocations.length !== 1
          || finalizedPattiyal.manualLines.length !== 1
          || finalizedPattiyal.grns.length !== 1) {
          throw new Error('Pattiyal smoke lifecycle or snapshot data is incomplete.');
        }
        const [[payableAfterPattiyal]] = await connection.execute(
          'SELECT COUNT(*) AS entry_count, COALESCE(SUM(amount), 0) AS amount FROM supplier_payable_entries'
        );
        if (Number(payableAfterPattiyal.entry_count) !== Number(payableBeforePattiyal.entry_count)
          || Number(payableAfterPattiyal.amount) !== Number(payableBeforePattiyal.amount)) {
          throw new Error('Evaluation-only Pattiyal changed the legacy supplier payable ledger.');
        }
        const voidedPattiyal = await pattiyals.voidStatement(finalizedPattiyal.statement.id, userId, 'Origin smoke cleanup');
        if (voidedPattiyal.statement.status !== 'void') throw new Error('Pattiyal smoke void transition failed.');
        const collection = await billing.collectInvoiceBalance({
          invoiceId: sale.invoiceId,
          userId,
          payments: [{ method: 'card', amount: 1 }],
          origin: { locCode, macCode, businessDate: txnDate }
        });
        if (!collection.collectionNo || collection.balance !== 0) throw new Error('Current-day customer collection origin failed.');
        const [[saleItem]] = await connection.execute('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY seq_no LIMIT 1', [sale.invoiceId]);
        const refundDraft = await refunds.createDraft({ sourceInvoiceId: sale.invoiceId, sessionId: session.id, locCode, macCode, txnDate, userId, reason: 'Origin smoke test' });
        await refunds.saveDraftItem(refundDraft.draftId, {
          sourceInvoiceItemId: saleItem.id, productId: saleItem.product_id, itemCode: saleItem.item_code,
          supplierCode: saleItem.supplier_code, description: saleItem.description,
          sourceQuantity: Number(saleItem.quantity), sourceKilos: saleItem.kilos,
          returnQuantity: Number(saleItem.quantity), returnKilos: saleItem.kilos,
          unitPrice: Number(saleItem.unit_price), sourceMerchandiseTotal: Number(saleItem.merchandise_total),
          sourceBagChargeTotal: Number(saleItem.bag_charge_total), sourceWageChargeTotal: Number(saleItem.wage_charge_total),
          discount: Number(saleItem.discount), tax: Number(saleItem.tax), merchandiseTotal: Number(saleItem.merchandise_total),
          bagChargeMode: 'proportional', bagChargeTotal: Number(saleItem.bag_charge_total),
          wageChargeMode: 'proportional', wageChargeTotal: Number(saleItem.wage_charge_total),
          total: Number(saleItem.total), stockDisposition: 'sellable', metadata: {}
        });
        await refunds.setDraftStatus(refundDraft.draftId, 'held', userId);
        await refunds.finalizeDraft({
          draftId: refundDraft.draftId, userId, reason: 'Origin smoke test',
          payments: [{ method: 'card', amount: Number(saleItem.total) }]
        });

        console.log('Origin identity smoke test passed; all writes will be rolled back.');
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

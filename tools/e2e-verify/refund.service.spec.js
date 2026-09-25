'use strict';

const assert = require('assert');
const { createRefundService } = require('../../packages/core/refunds/refund.service.js');

const source = {
  id: 10,
  invoice_number: 'MAIN-WS01-20260803-000200',
  items: [
    {
      id: 99,
      productId: 1,
      itemCode: '0001',
      description: 'B. Onion',
      qty: 1,
      kilos: 10,
      unitPrice: 50.5,
      discount: 0,
      tax: 0,
      // Line money is prorated from its recorded components, not from one total.
      merchandiseTotal: 505,
      bagChargeTotal: 40,
      wageChargeTotal: 10,
      total: 555,
      metadata: { per_kilo: true, kilos: 10, wage: 10, bags: 40 },
      remainingQuantity: 1,
      remainingKilos: 10,
      remainingTotal: 555,
      remainingBagChargeTotal: 40,
      remainingWageChargeTotal: 10
    }
  ]
};

let savedItem = null;
let searchOptions = null;
const repository = {
  async getSourceInvoice(id) { return id === 10 ? source : null; },
  async saveDraftItem(draftId, item) { savedItem = { draftId, ...item }; return { id: draftId, items: [item] }; },
  async getDraft() {
    return { id: 77, reason: '', items: [{ total: 277.5 }] };
  },
  // A return first clears customer debt; only the remainder is paid out.
  async getSettlementQuote() { return { returnTotal: 277.5, outstandingBalance: 0, debtReduction: 0, payoutDue: 277.5 }; },
  async finalizeDraft(payload) { return { refundId: 1, refundNumber: 'REF-1', refundNo: 1, grandTotal: 277.5, paidTotal: payload.payments[0].amount }; },
  async createDraft() { return { draftId: 77, refundNo: 1 }; },
  async removeDraftItem() {},
  async setDraftStatus() {},
  async searchSourceInvoices(options) { searchOptions = options; return []; },
  async listHeldDrafts() { return []; }
};

const service = createRefundService({
  refundRepository: repository,
  paymentModes: { getMode(id) { return id === 'cash' ? { id, type: 'tender' } : { id, type: 'credit' }; } },
  eventBus: { async publishAsync() {} }
});

async function run() {
  await service.searchSourceInvoices({ term: '200', locCode: 'MAIN', macCode: 'WS01', txnDate: '2026-08-03' });
  assert.deepStrictEqual(searchOptions, { term: '200', locCode: 'MAIN', macCode: 'WS01', txnDate: '2026-08-03' });

  await service.addSourceItem({
    draftId: 77,
    sourceInvoiceId: 10,
    sourceItemId: 99,
    kilos: 5,
    stockDisposition: 'damaged'
  });
  assert.strictEqual(savedItem.returnKilos, 5, 'weighted return preserves selected kilos');
  assert.strictEqual(savedItem.returnQuantity, 0.5, 'weighted return derives proportional quantity');
  assert.strictEqual(savedItem.total, 277.5, 'weighted return uses the original line total proportion');
  assert.strictEqual(savedItem.metadata.kilos, 5, 'return metadata carries the selected kilos');
  assert.strictEqual(savedItem.metadata.refundSource.pricingMode, 'source-prorated');

  // More than the line holds is refused, and the reason names what is left.
  await assert.rejects(
    () => service.addSourceItem({ draftId: 77, sourceInvoiceId: 10, sourceItemId: 99, kilos: 11 }),
    /remain refundable/
  );
  await assert.rejects(
    () => service.finalize({ draftId: 77, payments: [{ method: 'cash', amount: 277.5 }], userId: 1, reason: '' }),
    /reason is required/
  );
  await assert.rejects(
    () => service.finalize({ draftId: 77, payments: [{ method: 'cash', amount: 200 }], userId: 1, reason: 'Damaged bag' }),
    /must equal/
  );
  const finalized = await service.finalize({ draftId: 77, payments: [{ method: 'cash', amount: 277.5 }], userId: 1, reason: 'Damaged bag' });
  assert.strictEqual(finalized.refundNumber, 'REF-1');
  console.log('REFUND SERVICE TESTS PASSED');
}

run().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

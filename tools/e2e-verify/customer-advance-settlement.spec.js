'use strict';

/**
 * Money rules for the customer advance tender.
 *
 * A customer advance is a liability the shop already holds in cash. Redeeming
 * it must move that liability onto a bill and never hand the balance back as
 * drawer cash, so these checks guard the two paths that can spend it: sale
 * finalization and a later outstanding-balance collection.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBillingEngineService } = require('../../packages/core/billing/billing-engine.service.js');

const MODES = new Map([
  ['cash', { id: 'cash', type: 'tender' }],
  ['card', { id: 'card', type: 'tender' }],
  ['advance', { id: 'advance', type: 'tender', configuration: { fundingSource: 'customer_advance' } }],
  ['pending', { id: 'pending', type: 'credit' }]
]);

const BILL_CONTEXT = { locCode: 'MAIN', macCode: 'WS01', txnDate: '2026-09-02', receiptNo: 41, sessionId: 3, userId: 7 };

function fixture({ advanceBalance = 5000, invoice = null } = {}) {
  const captured = {};
  const engine = createBillingEngineService({
    liveBillRepository: {
      async getItemsByReceipt() {
        return [{ merchandiseTotal: 4000, bagChargeTotal: 0, wageChargeTotal: 0, discount: 0, total: 4000 }];
      },
      async allocateNextReceiptNo() { return 42; },
      async updateSessionCurrentReceipt() {}
    },
    billingRepository: {
      async finalizeInvoice(payload) { captured.finalize = payload; return { invoiceId: 1, invoiceNumber: 'INV-1' }; },
      async collectInvoiceBalance(payload) { captured.collect = payload; return { collected: payload.payments[0].amount, balance: 0 }; },
      async getInvoice() { return invoice; }
    },
    catalogRepository: {},
    partyRepository: {
      async getCustomerAccount(id) {
        return { customer: { id, status: 'active', creditEnabled: true, creditLimit: null, totalExposure: 0 } };
      }
    },
    workstationRepository: { async advanceReceiptNo() { return 42; } },
    paymentModes: { getMode: (id) => MODES.get(id), replaceConfigured: () => {} },
    cashManagementService: {
      async prepareSale() { return { cashShiftId: 9, movements: [] }; },
      async prepareCollection() { return { cashShiftId: 9, locCode: 'MAIN', macCode: 'WS01', businessDate: '2026-09-02', movements: [] }; }
    },
    customerAdvanceRepository: { async getBalance() { return advanceBalance; } }
  });
  return { engine, captured };
}

const finalize = (engine, payments) => engine.finalizeBill({
  ...BILL_CONTEXT, payments, customerCode: 'PKX', customerAccountId: 22
});

test('advance settles a bill on its own', async () => {
  const { engine, captured } = fixture();
  await finalize(engine, [{ method: 'advance', amount: 4000 }]);
  assert.equal(captured.finalize.payments[0].method, 'advance');
  assert.equal(captured.finalize.payments[0].amount, 4000);
});

test('advance splits with another tender', async () => {
  const { engine, captured } = fixture();
  await finalize(engine, [{ method: 'advance', amount: 3000 }, { method: 'cash', amount: 1000 }]);
  assert.equal(captured.finalize.payments.length, 2);
});

test('advance cannot be over-tendered and returned as cash change', async () => {
  const { engine } = fixture();
  await assert.rejects(
    () => finalize(engine, [{ method: 'advance', amount: 3000 }, { method: 'cash', amount: 2000 }]),
    /Advance money can only settle the 2000\.00 left after the other payments/
  );
});

test('advance cannot exceed the bill total', async () => {
  const { engine } = fixture();
  await assert.rejects(
    () => finalize(engine, [{ method: 'advance', amount: 4500 }]),
    /can only settle the 4000\.00/
  );
});

test('advance cannot exceed the balance held at this location', async () => {
  const { engine } = fixture({ advanceBalance: 1200 });
  await assert.rejects(
    () => finalize(engine, [{ method: 'advance', amount: 3000 }, { method: 'cash', amount: 1000 }]),
    /Only 1200\.00 of customer advance is available/
  );
});

test('advance requires a real linked customer account', async () => {
  const { engine } = fixture();
  await assert.rejects(
    () => engine.finalizeBill({ ...BILL_CONTEXT, payments: [{ method: 'advance', amount: 4000 }], customerCode: 'PKX', customerAccountId: null }),
    /Link a real customer account before using advance money/
  );
});

test('an outstanding balance can be settled from stored advance', async () => {
  const { engine, captured } = fixture({ invoice: { id: 5, customer_account_id: 22 } });
  await engine.collectInvoiceBalance({ invoiceId: 5, sessionId: 3, userId: 7, payments: [{ method: 'advance', amount: 800 }] });
  assert.equal(captured.collect.payments[0].method, 'advance');
  assert.equal(captured.collect.payments[0].amount, 800);
});

test('settling an outstanding balance is bounded by the advance held here', async () => {
  const { engine } = fixture({ advanceBalance: 300, invoice: { id: 5, customer_account_id: 22 } });
  await assert.rejects(
    () => engine.collectInvoiceBalance({ invoiceId: 5, sessionId: 3, userId: 7, payments: [{ method: 'advance', amount: 800 }] }),
    /Only 300\.00 of customer advance is available/
  );
});

test('an unlinked invoice cannot be settled from advance', async () => {
  const { engine } = fixture({ invoice: { id: 5, customer_account_id: null } });
  await assert.rejects(
    () => engine.collectInvoiceBalance({ invoiceId: 5, sessionId: 3, userId: 7, payments: [{ method: 'advance', amount: 800 }] }),
    /no customer account to settle/
  );
});

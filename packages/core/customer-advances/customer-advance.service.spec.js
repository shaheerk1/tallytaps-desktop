const test = require('node:test');
const assert = require('node:assert/strict');
const { createCustomerAdvanceService } = require('./customer-advance.service');

function fixture({ businessDate = '2026-09-02' } = {}) {
  const calls = [];
  const repository = {
    getBalance: async () => 125,
    getSummary: async () => ({ availableBalance: 125 }),
    receive: async (value) => { calls.push(['receive', value]); return value; },
    refundUnused: async (value) => { calls.push(['refund', value]); return value; }
  };
  const modes = new Map([
    ['cash', { id: 'cash', type: 'tender' }],
    ['card', { id: 'card', type: 'tender' }],
    ['cheque', { id: 'cheque', type: 'tender' }],
    ['advance', { id: 'advance', type: 'tender' }],
    ['pending', { id: 'pending', type: 'credit' }]
  ]);
  const service = createCustomerAdvanceService({
    repository,
    paymentModes: { getMode: (id) => modes.get(id), replaceConfigured: () => {} },
    cashManagementService: { getActiveShiftForSession: async () => ({ id: 4, status: 'open', userId: 7, locationCode: 'L1', machineCode: 'M1', businessDate }) }
  });
  return { service, calls };
}

test('receiving cash advance uses the active shift origin and a separate receipt ledger', async () => {
  const { service, calls } = fixture();
  await service.receive({ customerAccountId: 2, sessionId: 3, userId: 7, reason: 'Future order', payments: [{ method: 'cash', amount: 100 }] });
  assert.equal(calls[0][0], 'receive');
  assert.equal(calls[0][1].cashShiftId, 4);
  assert.equal(calls[0][1].locCode, 'L1');
  assert.equal(calls[0][1].payments[0].amount, 100);
});

test('unused advance refund is bounded by the available location balance', async () => {
  const { service } = fixture();
  await assert.rejects(() => service.refundUnused({
    customerAccountId: 2, sessionId: 3, userId: 7, reason: 'Order cancelled', method: 'cash', amount: 126
  }), /Only 125\.00/);
});

test('cheques are not treated as available advance until clearance tracking exists', async () => {
  const { service } = fixture();
  await assert.rejects(() => service.receive({
    customerAccountId: 2, sessionId: 3, userId: 7, reason: 'Future order', payments: [{ method: 'cheque', amount: 100 }]
  }), /clearance tracking/);
});

test('a shift business date read back as a Date still resolves its business day', async () => {
  // mysql2 returns DATE columns as Date objects. Stringifying one yields
  // "Wed Sep 02", which matches no business day and reads to the cashier as a
  // closed day even though the day and shift are both open.
  const { service, calls } = fixture({ businessDate: new Date(2026, 8, 2) });
  await service.receive({ customerAccountId: 2, sessionId: 3, userId: 7, reason: 'Future order', payments: [{ method: 'cash', amount: 100 }] });
  assert.equal(calls[0][1].txnDate, '2026-09-02');
});

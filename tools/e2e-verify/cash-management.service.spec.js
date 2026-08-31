const assert = require('assert');
const { createCashManagementService } = require('../../packages/core/cash-management/cash-management.service');

let received = null;
const repository = {
  async getActiveShiftForSession(sessionId) {
    if (sessionId === 7) return { id: 9, userId: 3, status: 'open' };
    if (sessionId === 8) return { id: 10, userId: 3, status: 'blind_closed' };
    return null;
  },
  async getRecoverableShiftForWorkstation({ workstationId, userId }) {
    return workstationId === 1 && userId === 3 ? { id: 10, userId: 3, status: 'blind_closed' } : null;
  },
  async createShift(payload) { received = payload; return { id: 9, ...payload }; },
  async addMovement(payload) { received = payload; return { id: 2 }; },
  async submitClosingCount(payload) { received = payload; return { id: 9, status: 'blind_closed' }; },
  async closeShift(payload) { received = payload; return { id: 9, status: 'closed' }; },
  async getShift() { return null; }
};

const service = createCashManagementService({ cashManagementRepository: repository });

async function run() {
  await service.openShift({ workstationSessionId: 7, workstationId: 1, userId: 3, businessDate: '2026-08-03', openingLines: [{ denomination: 100, quantity: 2 }, { denomination: 50, quantity: 0 }] });
  assert.deepStrictEqual(received.openingLines, [{ denomination: 100, quantity: 2 }]);
  await assert.rejects(() => service.recordMovement({ shiftId: 9, type: 'cash_out', amount: 10, reason: '', userId: 3 }), /reason/);
  await service.recordMovement({ shiftId: 9, type: 'safe_drop', amount: 125.555, reason: 'Excess drawer cash', userId: 3 });
  assert.strictEqual(received.direction, 'out');
  assert.strictEqual(received.amount, 125.56);
  const sale = await service.prepareSale({ sessionId: 7, userId: 3, grandTotal: 90, payments: [{ method: 'cash', amount: 100, type: 'tender' }] });
  assert.deepStrictEqual(sale.movements, [{ movementType: 'sale_cash', direction: 'in', amount: 100 }, { movementType: 'change_given', direction: 'out', amount: 10 }]);
  const refund = await service.prepareRefund({ sessionId: 7, userId: 3, payments: [{ method: 'cash', amount: 20 }] });
  assert.deepStrictEqual(refund.movements, [{ movementType: 'refund_cash', direction: 'out', amount: 20 }]);
  assert.deepStrictEqual(
    await service.getRecoverableShiftForWorkstation({ workstationId: 1, userId: 3 }),
    { id: 10, userId: 3, status: 'blind_closed' }
  );
  assert.strictEqual(await service.getRecoverableShiftForWorkstation({ workstationId: 0, userId: 3 }), null);
  await assert.rejects(
    () => service.prepareSale({ sessionId: 8, userId: 3, grandTotal: 10, payments: [] }),
    /pending closing count/
  );
  await assert.rejects(() => service.prepareSale({ sessionId: 0, userId: 3, grandTotal: 10, payments: [] }), /Open a cash shift/);
  console.log('CASH MANAGEMENT SERVICE TESTS PASSED');
}

run().catch((error) => { console.error('FATAL', error.stack || error); process.exitCode = 1; });

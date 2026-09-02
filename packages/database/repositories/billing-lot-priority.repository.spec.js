const test = require('node:test');
const assert = require('node:assert/strict');
const { createBillingRepository } = require('./billing.repository');

function repositoryWith(execute) {
  return createBillingRepository({
    database: { withConnection: async (callback) => callback({ execute }) },
    inventoryLedgerRepository: {}
  });
}

test('lot candidates put a remembered active lot first and preserve FIFO fallback order', async () => {
  const statements = [];
  const repository = repositoryWith(async (sql) => {
    statements.push(sql);
    if (sql.includes('FROM inventory_lot_preferences')) return [[{ inventory_lot_id: 22 }]];
    if (sql.includes('FROM inventory_lots l')) return [[
      { id: 22, supplier_id: 2, received_handling_quantity: '8.000', remaining_handling_quantity: '3.000', received_base_quantity: '80.000', remaining_base_quantity: '30.000' },
      { id: 11, supplier_id: 1, received_handling_quantity: '10.000', remaining_handling_quantity: '5.000', received_base_quantity: '100.000', remaining_base_quantity: '50.000' }
    ]];
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const lots = await repository.listAllocationLotCandidates({ productId: 7, locCode: 'L1', txnDate: '2026-09-02', userId: 4 });

  assert.deepEqual(lots.map((lot) => lot.id), [22, 11]);
  assert.equal(lots[0].remembered, true);
  assert.equal(lots[0].priority_reason, 'remembered');
  assert.equal(lots[1].priority_reason, 'fifo');
  assert.equal(statements.some((sql) => /LIMIT\s+\?/i.test(sql)), false);
});

test('remembering a lot validates it before replacing the cashier preference', async () => {
  const calls = [];
  const repository = repositoryWith(async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT l.id')) return [[{ id: 31 }]];
    if (sql.includes('INSERT INTO inventory_lot_preferences')) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const result = await repository.rememberAllocationLot({ productId: 9, locCode: ' L2 ', txnDate: '2026-09-02', userId: 5, lotId: 31 });

  assert.deepEqual(result, { lotId: 31 });
  assert.deepEqual(calls[1].params, ['L2', 9, 5, 31]);
});

test('an exhausted remembered lot is discarded when it is no longer an active candidate', async () => {
  const calls = [];
  const repository = repositoryWith(async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM inventory_lot_preferences')) return [[{ inventory_lot_id: 40 }]];
    if (sql.includes('FROM inventory_lots l')) return [[{ id: 41, supplier_id: 1, received_handling_quantity: 4, remaining_handling_quantity: 2, received_base_quantity: null, remaining_base_quantity: null }]];
    if (sql.includes('DELETE FROM inventory_lot_preferences')) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const lots = await repository.listAllocationLotCandidates({ productId: 2, locCode: 'L1', txnDate: '2026-09-02', userId: 3 });

  assert.equal(lots[0].id, 41);
  assert.equal(lots[0].remembered, false);
  assert.deepEqual(calls[2].params, ['L1', 2, 3, 40]);
});

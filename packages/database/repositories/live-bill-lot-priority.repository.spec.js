const test = require('node:test');
const assert = require('node:assert/strict');
const { createLiveBillRepository } = require('./live-bill.repository');

test('live bill lines persist the selected lot priority with aligned MySQL parameters', async () => {
  let insert;
  const connection = {
    execute: async (sql, params) => {
      if (sql.includes('MAX(seq_no)')) return [[{ maxSeq: 0 }]];
      if (sql.includes('INSERT INTO invoice_items')) {
        insert = { sql, params };
        return [{ insertId: 42 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  const repository = createLiveBillRepository({
    database: { withConnection: async (callback) => callback(connection) },
    documentSequenceRepository: {},
    businessDayRepository: { assertOpenWithConnection: async () => ({ id: 3 }) }
  });

  const line = await repository.addItem({
    sessionId: 8, receiptNo: 12, locCode: 'L1', macCode: 'P1', txnDate: '2026-09-02', userId: 5,
    customerCode: 'C1', productId: 7, supplierCode: 'S1', itemCode: 'SKU-1', description: 'Test item',
    qty: 2, kilos: 20, handlingUom: 'box', baseUom: 'kg', requiresKilos: true, pricingBasis: 'kilos',
    quantityStep: 1, allowZeroQuantity: false, unitPrice: 10, discount: 0, tax: 0,
    merchandiseTotal: 200, bagChargeRate: 0, bagChargeTotal: 0, wageChargeRate: 0, wageBasis: 'none', wageChargeTotal: 0,
    total: 200, metadata: {}, priceOverrideSnapshot: null,
    allocationPriorityLotId: 31, allocationPrioritySource: 'manual', allocationPrioritySetBy: 5
  });

  assert.ok(insert);
  assert.equal((insert.sql.match(/\?/g) || []).length, insert.params.length);
  assert.match(insert.sql, /allocation_priority_lot_id/);
  assert.equal(insert.params[22], 5);
  assert.equal(line.allocationPriorityLotId, 31);
  assert.equal(line.allocationPrioritySource, 'manual');
});

test('live bill lines discard a non-database audit identity without losing the chosen lot', async () => {
  let insertParams;
  const repository = createLiveBillRepository({
    database: { withConnection: async (callback) => callback({ execute: async (sql, params) => {
      if (sql.includes('MAX(seq_no)')) return [[{ maxSeq: 0 }]];
      insertParams = params;
      return [{ insertId: 43 }];
    } }) },
    documentSequenceRepository: {},
    businessDayRepository: { assertOpenWithConnection: async () => ({ id: 3 }) }
  });

  const line = await repository.addItem({
    sessionId: 8, receiptNo: 13, locCode: 'L1', macCode: 'P1', txnDate: '2026-09-02', userId: 5,
    productId: 7, itemCode: 'SKU-1', description: 'Test item', qty: 1, unitPrice: 10, discount: 0,
    total: 10, metadata: {}, allocationPriorityLotId: 31, allocationPrioritySource: 'manual', allocationPrioritySetBy: 'cashier-five'
  });

  assert.equal(insertParams[20], 31);
  assert.equal(insertParams[21], 'manual');
  assert.equal(insertParams[22], null);
  assert.equal(line.allocationPriorityLotId, 31);
});

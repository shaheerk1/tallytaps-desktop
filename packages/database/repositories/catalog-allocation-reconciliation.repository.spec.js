const test = require('node:test');
const assert = require('node:assert/strict');
const { createCatalogRepository } = require('./catalog.repository');

test('sale allocation rework refuses to rewrite an allocation referenced by a refund', async () => {
  let rolledBack = false;
  const connection = {
    beginTransaction: async () => {},
    commit: async () => { throw new Error('A guarded reallocation must not commit.'); },
    rollback: async () => { rolledBack = true; },
    execute: async (sql) => {
      if (sql.includes('FROM lot_sale_allocations a JOIN invoice_items')) return [[{
        id: 4, invoice_item_id: 12, inventory_lot_id: 20, product_id: 7,
        loc_code: 'L1', mac_code: 'P1', txn_date: '2026-09-02', document_no: 9, line_no: 1,
        handling_quantity: 2, base_quantity: 20, sale_value: 200
      }]];
      if (sql.includes('WHERE source_allocation_id = ?')) return [[{ id: 99 }]];
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  const repository = createCatalogRepository({
    database: { withConnection: async (callback) => callback(connection) },
    documentSequenceRepository: {},
    inventoryLedgerRepository: {}
  });

  await assert.rejects(
    repository.reallocateSale({ allocationId: 4, toInventoryLotId: 21, handlingQuantity: 1, baseQuantity: 10, reason: 'Correct lot' }),
    /refund history/
  );
  assert.equal(rolledBack, true);
});

const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createCatalogRepository } = require('../../packages/database/repositories/catalog.repository');

async function main() {
  const database = createDatabase();
  const catalog = createCatalogRepository({ database });

  const results = [];
  const log = (label, ok, detail) => {
    results.push({ label, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  };

  const SKU = `E2E${Date.now().toString().slice(-6)}`;
  const createdIds = [];

  try {
    // 1. Create a product with the new item-master fields
    const created = await catalog.createProduct({
      sku: SKU,
      name: 'E2E Carrot Bundle',
      unitPrice: 45.5,
      stockQty: 12,
      barcode: '8900000000001',
      category: 'Vegetables',
      unit: 'kg',
      isActive: true,
      metadata: { test: true }
    });
    createdIds.push(created.id);
    log('createProduct stores base fields',
      created.id > 0 && created.sku === SKU && Number(created.unit_price) === 45.5 &&
        created.category === 'Vegetables' && created.unit === 'kg' && created.barcode === '8900000000001',
      `id=${created.id}, sku=${created.sku}, price=${created.unit_price}, cat=${created.category}`);

    // 2. Default listProducts only returns active items and includes ours
    const activeList = await catalog.listProducts();
    log('listProducts (active) includes new item',
      activeList.some((p) => p.id === created.id && Number(p.is_active) === 1),
      `count=${activeList.length}`);

    // 3. getProduct by id
    const fetched = await catalog.getProduct(created.id);
    log('getProduct returns item', fetched?.id === created.id && fetched.name === 'E2E Carrot Bundle', `name=${fetched?.name}`);

    // 4. updateProduct changes fields
    const updated = await catalog.updateProduct(created.id, {
      name: 'E2E Carrot 1kg',
      unitPrice: 50,
      category: 'Root Vegetables',
      stockQty: 8
    });
    log('updateProduct persists changes',
      updated.name === 'E2E Carrot 1kg' && Number(updated.unit_price) === 50 &&
        updated.category === 'Root Vegetables' && Number(updated.stock_qty) === 8,
      `name=${updated.name}, price=${updated.unit_price}, cat=${updated.category}`);

    // 5. searchProducts matches barcode and only active
    const byBarcode = await catalog.searchProducts('8900000000001');
    log('searchProducts finds by barcode', byBarcode.length === 1 && byBarcode[0].id === created.id, `hits=${byBarcode.length}`);

    // 6. Inactive item excluded from active list/search, included with includeInactive
    const inactive = await catalog.createProduct({
      sku: `${SKU}-I`,
      name: 'E2E Discontinued Item',
      unitPrice: 5,
      stockQty: 0,
      category: 'General',
      isActive: false
    });
    createdIds.push(inactive.id);
    const afterInactive = await catalog.listProducts();
    const searchInactive = await catalog.searchProducts('E2E Discontinued');
    const allInactive = await catalog.listProducts({ includeInactive: true });
    log('inactive item hidden from active list',
      !afterInactive.some((p) => p.id === inactive.id), '');
    log('inactive item hidden from search',
      searchInactive.length === 0, `hits=${searchInactive.length}`);
    log('inactive item visible with includeInactive',
      allInactive.some((p) => p.id === inactive.id), '');

    // 7. listProductCategories returns distinct categories
    const cats = await catalog.listProductCategories();
    log('categories include new values',
      cats.includes('Root Vegetables') && cats.includes('General'),
      cats.join(', '));

    // 8. deleteProduct removes an unreferenced item
    const toDelete = await catalog.createProduct({ sku: `${SKU}-D`, name: 'E2E Temp Item', unitPrice: 1 });
    createdIds.push(toDelete.id);
    const deleted = await catalog.deleteProduct(toDelete.id);
    const gone = await catalog.getProduct(toDelete.id);
    log('deleteProduct removes unreferenced item', deleted === true && gone === null, `deleted=${deleted}`);

    // 9. deleteProduct refuses items with stock movement history
    const guarded = await catalog.createProduct({ sku: `${SKU}-G`, name: 'E2E Guarded Item', unitPrice: 2 });
    createdIds.push(guarded.id);
    await database.withConnection((c) => c.execute(
      `INSERT INTO stock_movements (product_id, movement_type, quantity, reference_type, note)
       VALUES (?, 'initial', 10, 'e2e', 'guard test')`,
      [guarded.id]
    ));
    let deleteRejected = false;
    try {
      await catalog.deleteProduct(guarded.id);
    } catch (err) {
      deleteRejected = /stock movement history/i.test(err.message);
    }
    log('deleteProduct rejects item with stock history', deleteRejected, '');
    const stillThere = await catalog.getProduct(guarded.id);
    log('guarded item still present after reject', stillThere !== null, '');

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exitCode = failed.length > 0 ? 1 : 0;
  } finally {
    try {
      await database.withConnection(async (c) => {
        for (const id of createdIds) {
          await c.execute('DELETE FROM stock_movements WHERE product_id = ?', [id]);
          await c.execute('DELETE FROM products WHERE id = ?', [id]);
        }
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

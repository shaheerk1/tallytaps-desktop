function createInventoryLedgerRepository({ database } = {}) {
  if (!database) throw new Error('Inventory ledger repository requires a database instance.');

  const roundMeasure = (value) => Math.round(Number(value || 0) * 1000) / 1000;

  async function productProfileWithConnection(connection, productId) {
    const [rows] = await connection.execute(
      `SELECT id, handling_uom, base_uom, dual_uom_enabled
       FROM products WHERE id = ? FOR UPDATE`,
      [productId]
    );
    if (!rows.length) throw new Error('Inventory product no longer exists.');
    return rows[0];
  }

  async function postWithConnection(connection, {
    productId,
    inventoryLotId = null,
    locCode,
    macCode,
    businessDate,
    documentType,
    documentNo,
    lineNo,
    eventNo = 1,
    movementType,
    referenceType = null,
    referenceId = null,
    note = null,
    createdBy = null,
    handlingDelta = null,
    baseDelta = null,
    handlingUom = null,
    baseUom = null
  }) {
    const handling = handlingDelta == null ? null : roundMeasure(handlingDelta);
    const base = baseDelta == null ? null : roundMeasure(baseDelta);
    if ((handling == null || handling === 0) && (base == null || base === 0)) {
      throw new Error('An inventory movement requires a non-zero handling or base quantity.');
    }
    const profile = await productProfileWithConnection(connection, productId);
    const resolvedHandlingUom = String(handlingUom || profile.handling_uom || 'qty').trim();
    const resolvedBaseUom = baseUom == null
      ? (profile.base_uom == null ? null : String(profile.base_uom).trim())
      : String(baseUom).trim() || null;
    const legacyQuantity = base != null && base !== 0 ? base : Number(handling || 0);

    await connection.execute(
      `INSERT INTO stock_movements
         (product_id, inventory_lot_id, loc_code, mac_code, quantity,
          handling_quantity_delta, base_quantity_delta, handling_uom_snapshot, base_uom_snapshot,
          business_date, document_type, document_no, line_no, event_no,
          movement_type, reference_type, reference_id, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [productId, inventoryLotId || null, locCode, macCode, legacyQuantity,
        handling, base, resolvedHandlingUom, resolvedBaseUom,
        businessDate, documentType, documentNo, lineNo, eventNo,
        movementType, referenceType, referenceId == null ? null : String(referenceId), note, createdBy || null]
    );

    await connection.execute(
      `INSERT INTO inventory_balances
         (product_id, loc_code, handling_on_hand, base_on_hand)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         handling_on_hand = handling_on_hand + VALUES(handling_on_hand),
         base_on_hand = base_on_hand + VALUES(base_on_hand),
         version = version + 1`,
      [productId, locCode, Number(handling || 0), Number(base || 0)]
    );

    await connection.execute(
      `UPDATE products
       SET stock_handling_qty = stock_handling_qty + ?,
           stock_base_qty = stock_base_qty + ?,
           stock_qty = stock_qty + ?
       WHERE id = ?`,
      [Number(handling || 0), Number(base || 0), legacyQuantity, productId]
    );

    return { handlingDelta: handling, baseDelta: base, legacyQuantity };
  }

  async function listLocationBalances(productId = null, locCode = null) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT b.*, p.sku, p.name AS product_name, p.handling_uom, p.base_uom, p.dual_uom_enabled
         FROM inventory_balances b
         JOIN products p ON p.id = b.product_id
         WHERE (? IS NULL OR b.product_id = ?)
           AND (? IS NULL OR b.loc_code = ?)
         ORDER BY p.name, b.loc_code`,
        [productId, productId, locCode, locCode]
      );
      return rows;
    });
  }

  return { postWithConnection, listLocationBalances };
}

module.exports = { createInventoryLedgerRepository };

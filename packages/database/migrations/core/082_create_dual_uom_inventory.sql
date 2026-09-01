-- Universal Dual UoM inventory foundation.
--
-- The existing quantity/kilos fields remain in place for backwards
-- compatibility. New code writes both the legacy fields and these neutral
-- handling/base fields until every external consumer has migrated.

ALTER TABLE products
  ADD COLUMN handling_uom VARCHAR(60) NOT NULL DEFAULT 'qty' AFTER unit,
  ADD COLUMN base_uom VARCHAR(60) NULL AFTER handling_uom,
  ADD COLUMN dual_uom_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER base_uom,
  ADD COLUMN stock_handling_qty DECIMAL(14,3) NOT NULL DEFAULT 0 AFTER stock_qty,
  ADD COLUMN stock_base_qty DECIMAL(14,3) NOT NULL DEFAULT 0 AFTER stock_handling_qty;

UPDATE products
SET handling_uom = CASE WHEN requires_kilos = 1 THEN 'bag' ELSE COALESCE(NULLIF(unit, ''), 'qty') END,
    base_uom = CASE WHEN requires_kilos = 1 THEN COALESCE(NULLIF(unit, ''), 'kg') ELSE NULL END,
    dual_uom_enabled = CASE WHEN requires_kilos = 1 THEN 1 ELSE 0 END,
    stock_handling_qty = CASE WHEN requires_kilos = 1 THEN 0 ELSE stock_qty END,
    stock_base_qty = CASE WHEN requires_kilos = 1 THEN stock_qty ELSE 0 END;

ALTER TABLE goods_receipt_lines
  ADD COLUMN handling_quantity DECIMAL(14,3) NULL AFTER package_qty,
  ADD COLUMN handling_uom_snapshot VARCHAR(60) NULL AFTER package_unit,
  ADD COLUMN expected_base_quantity DECIMAL(14,3) NULL AFTER expected_kilos,
  ADD COLUMN received_base_quantity DECIMAL(14,3) NULL AFTER received_kilos,
  ADD COLUMN base_uom_snapshot VARCHAR(60) NULL AFTER received_base_quantity,
  ADD COLUMN conversion_mode ENUM('fixed','variable') NOT NULL DEFAULT 'variable' AFTER base_uom_snapshot,
  ADD COLUMN expected_base_per_handling DECIMAL(14,6) NULL AFTER conversion_mode,
  ADD COLUMN actual_base_per_handling DECIMAL(14,6) NULL AFTER expected_base_per_handling;

UPDATE goods_receipt_lines gl
JOIN products p ON p.id = gl.product_id
SET gl.handling_quantity = gl.package_qty,
    gl.handling_uom_snapshot = COALESCE(NULLIF(gl.package_unit, ''), p.handling_uom),
    gl.expected_base_quantity = gl.expected_kilos,
    gl.received_base_quantity = gl.received_kilos,
    gl.base_uom_snapshot = p.base_uom,
    gl.actual_base_per_handling = CASE
      WHEN gl.package_qty > 0 AND gl.received_kilos IS NOT NULL THEN gl.received_kilos / gl.package_qty
      ELSE NULL
    END;

ALTER TABLE inventory_lots
  ADD COLUMN lot_code VARCHAR(140) NULL AFTER goods_receipt_line_id,
  ADD COLUMN received_handling_quantity DECIMAL(14,3) NOT NULL DEFAULT 0 AFTER received_quantity,
  ADD COLUMN remaining_handling_quantity DECIMAL(14,3) NOT NULL DEFAULT 0 AFTER remaining_quantity,
  ADD COLUMN received_base_quantity DECIMAL(14,3) NULL AFTER received_kilos,
  ADD COLUMN remaining_base_quantity DECIMAL(14,3) NULL AFTER remaining_kilos,
  ADD COLUMN handling_uom_snapshot VARCHAR(60) NOT NULL DEFAULT 'qty' AFTER remaining_base_quantity,
  ADD COLUMN base_uom_snapshot VARCHAR(60) NULL AFTER handling_uom_snapshot,
  ADD COLUMN conversion_mode ENUM('fixed','variable') NOT NULL DEFAULT 'variable' AFTER base_uom_snapshot,
  ADD COLUMN expected_base_per_handling DECIMAL(14,6) NULL AFTER conversion_mode,
  ADD COLUMN actual_base_per_handling DECIMAL(14,6) NULL AFTER expected_base_per_handling;

UPDATE inventory_lots l
JOIN products p ON p.id = l.product_id
SET l.lot_code = CONCAT('LOT-', LPAD(l.id, 10, '0')),
    l.received_handling_quantity = l.received_quantity,
    l.remaining_handling_quantity = l.remaining_quantity,
    l.received_base_quantity = l.received_kilos,
    l.remaining_base_quantity = l.remaining_kilos,
    l.handling_uom_snapshot = p.handling_uom,
    l.base_uom_snapshot = p.base_uom,
    l.actual_base_per_handling = CASE
      WHEN l.received_quantity > 0 AND l.received_kilos IS NOT NULL THEN l.received_kilos / l.received_quantity
      ELSE NULL
    END;

ALTER TABLE inventory_lots
  MODIFY lot_code VARCHAR(140) NOT NULL,
  ADD UNIQUE KEY uq_inventory_lots_lot_code (lot_code),
  ADD KEY idx_inventory_lots_location_product (loc_code, product_id, id);

ALTER TABLE invoice_items
  ADD COLUMN handling_quantity DECIMAL(14,3) NULL AFTER quantity,
  ADD COLUMN base_quantity DECIMAL(14,3) NULL AFTER kilos,
  ADD COLUMN handling_uom_snapshot VARCHAR(60) NULL AFTER base_quantity,
  ADD COLUMN base_uom_snapshot VARCHAR(60) NULL AFTER handling_uom_snapshot;

UPDATE invoice_items i
LEFT JOIN products p ON p.id = i.product_id
SET i.handling_quantity = i.quantity,
    i.base_quantity = i.kilos,
    i.handling_uom_snapshot = COALESCE(p.handling_uom, 'qty'),
    i.base_uom_snapshot = p.base_uom;

ALTER TABLE refund_draft_items
  ADD COLUMN source_handling_quantity DECIMAL(14,3) NULL AFTER source_quantity,
  ADD COLUMN source_base_quantity DECIMAL(14,3) NULL AFTER source_kilos,
  ADD COLUMN return_handling_quantity DECIMAL(14,3) NULL AFTER return_quantity,
  ADD COLUMN return_base_quantity DECIMAL(14,3) NULL AFTER return_kilos,
  ADD COLUMN handling_uom_snapshot VARCHAR(60) NULL AFTER return_base_quantity,
  ADD COLUMN base_uom_snapshot VARCHAR(60) NULL AFTER handling_uom_snapshot;

UPDATE refund_draft_items d
LEFT JOIN products p ON p.id = d.product_id
SET d.source_handling_quantity = d.source_quantity,
    d.source_base_quantity = d.source_kilos,
    d.return_handling_quantity = d.return_quantity,
    d.return_base_quantity = d.return_kilos,
    d.handling_uom_snapshot = COALESCE(p.handling_uom, 'qty'),
    d.base_uom_snapshot = p.base_uom;

ALTER TABLE refund_items
  ADD COLUMN source_handling_quantity DECIMAL(14,3) NULL AFTER source_quantity,
  ADD COLUMN source_base_quantity DECIMAL(14,3) NULL AFTER source_kilos,
  ADD COLUMN return_handling_quantity DECIMAL(14,3) NULL AFTER return_quantity,
  ADD COLUMN return_base_quantity DECIMAL(14,3) NULL AFTER return_kilos,
  ADD COLUMN handling_uom_snapshot VARCHAR(60) NULL AFTER return_base_quantity,
  ADD COLUMN base_uom_snapshot VARCHAR(60) NULL AFTER handling_uom_snapshot;

UPDATE refund_items r
LEFT JOIN products p ON p.id = r.product_id
SET r.source_handling_quantity = r.source_quantity,
    r.source_base_quantity = r.source_kilos,
    r.return_handling_quantity = r.return_quantity,
    r.return_base_quantity = r.return_kilos,
    r.handling_uom_snapshot = COALESCE(p.handling_uom, 'qty'),
    r.base_uom_snapshot = p.base_uom;

ALTER TABLE lot_sale_allocations
  ADD COLUMN handling_quantity DECIMAL(14,3) NOT NULL DEFAULT 0 AFTER quantity,
  ADD COLUMN base_quantity DECIMAL(14,3) NULL AFTER kilos;

UPDATE lot_sale_allocations
SET handling_quantity = quantity,
    base_quantity = kilos;

ALTER TABLE stock_movements
  ADD COLUMN inventory_lot_id BIGINT UNSIGNED NULL AFTER product_id,
  ADD COLUMN handling_quantity_delta DECIMAL(14,3) NULL AFTER quantity,
  ADD COLUMN base_quantity_delta DECIMAL(14,3) NULL AFTER handling_quantity_delta,
  ADD COLUMN handling_uom_snapshot VARCHAR(60) NULL AFTER base_quantity_delta,
  ADD COLUMN base_uom_snapshot VARCHAR(60) NULL AFTER handling_uom_snapshot,
  ADD KEY idx_stock_movements_location_product (loc_code, product_id, business_date),
  ADD KEY idx_stock_movements_lot (inventory_lot_id),
  ADD CONSTRAINT fk_stock_movements_lot FOREIGN KEY (inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE SET NULL;

UPDATE stock_movements m
JOIN products p ON p.id = m.product_id
SET m.handling_quantity_delta = CASE WHEN p.dual_uom_enabled = 1 THEN NULL ELSE m.quantity END,
    m.base_quantity_delta = CASE WHEN p.dual_uom_enabled = 1 THEN m.quantity ELSE NULL END,
    m.handling_uom_snapshot = p.handling_uom,
    m.base_uom_snapshot = p.base_uom;

UPDATE stock_movements m
JOIN inventory_lots l ON m.reference_type = 'inventory_lot' AND m.reference_id = CAST(l.id AS CHAR)
SET m.inventory_lot_id = l.id;

ALTER TABLE inventory_stock_count_lines
  ADD COLUMN expected_handling_quantity DECIMAL(14,3) NULL AFTER expected_quantity,
  ADD COLUMN counted_handling_quantity DECIMAL(14,3) NULL AFTER counted_quantity,
  ADD COLUMN expected_base_quantity DECIMAL(14,3) NULL AFTER expected_kilos,
  ADD COLUMN counted_base_quantity DECIMAL(14,3) NULL AFTER counted_kilos;

UPDATE inventory_stock_count_lines
SET expected_handling_quantity = expected_quantity,
    counted_handling_quantity = counted_quantity,
    expected_base_quantity = expected_kilos,
    counted_base_quantity = counted_kilos;

CREATE TABLE IF NOT EXISTS inventory_balances (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id BIGINT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  handling_on_hand DECIMAL(14,3) NOT NULL DEFAULT 0,
  base_on_hand DECIMAL(14,3) NOT NULL DEFAULT 0,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_balances_product_location (product_id, loc_code),
  KEY idx_inventory_balances_location (loc_code, product_id),
  CONSTRAINT fk_inventory_balances_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO inventory_balances (product_id, loc_code, handling_on_hand, base_on_hand)
SELECT m.product_id, m.loc_code,
       COALESCE(SUM(m.handling_quantity_delta), 0),
       COALESCE(SUM(m.base_quantity_delta), 0)
FROM stock_movements m
GROUP BY m.product_id, m.loc_code
ON DUPLICATE KEY UPDATE
  handling_on_hand = VALUES(handling_on_hand),
  base_on_hand = VALUES(base_on_hand),
  version = version + 1;

UPDATE products p
LEFT JOIN (
  SELECT product_id,
         SUM(handling_on_hand) AS handling_on_hand,
         SUM(base_on_hand) AS base_on_hand
  FROM inventory_balances
  GROUP BY product_id
) b ON b.product_id = p.id
SET p.stock_handling_qty = COALESCE(b.handling_on_hand, p.stock_handling_qty),
    p.stock_base_qty = COALESCE(b.base_on_hand, p.stock_base_qty);

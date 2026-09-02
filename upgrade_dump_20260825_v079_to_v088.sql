-- TallyTaps / DDEC POS database upgrade
-- Source schema: Dump20260825.sql, core migrations 001 through 079
-- Target schema: current desktop application, core migrations 001 through 088
-- Generated from the canonical migration files; do not edit this bundle by hand.
--
-- IMPORTANT
-- 1. Make a fresh database backup before running this file.
-- 2. Close every POS application connected to this database.
-- 3. Select the intended POS database in MySQL Workbench before executing.
-- 4. Run the complete file as one script using a MySQL 8.x administrator account.
-- 5. Do not use MySQL Workbench's "continue on error" option.
--
-- This upgrade is additive/data-preserving. It creates cloud-sync, dual-UoM,
-- lot-allocation, reconciliation, and customer-advance structures; it also
-- backfills new stock fields from the existing quantity/kilo history.

SET NAMES utf8mb4;
SET @tally_upgrade_lock = GET_LOCK('tallytaps_pos_upgrade_079_088', 30);

DROP PROCEDURE IF EXISTS tallytaps_assert_upgrade_079_088;
DELIMITER $$
CREATE PROCEDURE tallytaps_assert_upgrade_079_088()
BEGIN
  IF COALESCE(@tally_upgrade_lock, 0) <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Could not obtain the TallyTaps schema-upgrade lock.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM core_migrations
    WHERE migration_name = '079_create_issued_cheque_register.sql'
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Wrong starting schema: migration 079 is not recorded.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM core_migrations
    WHERE migration_name IN (
      '080_create_pos_cloud_archive_sync.sql',
      '081_index_pos_cloud_archive_sources.sql',
      '082_create_dual_uom_inventory.sql',
      '083_add_lot_ratio_monitoring.sql',
      '084_add_lot_allocation_priority_and_reconciliation.sql',
      '085_backfill_inventory_allocation_exceptions.sql',
      '086_create_customer_advance_ledger.sql',
      '087_link_advance_restorations_to_invoice_allocations.sql',
      '088_rename_advance_payment_mode.sql'
    )
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Upgrade 080-088 is already present or partially recorded. Do not rerun this bundle.';
  END IF;
END$$
DELIMITER ;

CALL tallytaps_assert_upgrade_079_088();
DROP PROCEDURE tallytaps_assert_upgrade_079_088;

SET @tally_upgrade_batch = (SELECT COALESCE(MAX(batch), 0) + 1 FROM core_migrations);

-- ============================================================================
-- 080_create_pos_cloud_archive_sync.sql
-- ============================================================================
-- Optional, offline-first POS archive synchronization.
-- All changes are additive so existing POS databases can be upgraded in place.

CREATE TABLE IF NOT EXISTS pos_cloud_sync_configuration (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  installation_id CHAR(36) NOT NULL,
  registered_host_id VARCHAR(120) NULL,
  node_id CHAR(36) NULL,
  node_key_ciphertext TEXT NULL,
  node_nickname VARCHAR(120) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  interval_minutes INT UNSIGNED NOT NULL DEFAULT 15,
  batch_size INT UNSIGNED NOT NULL DEFAULT 100,
  max_batches_per_run INT UNSIGNED NOT NULL DEFAULT 4,
  last_catalog_hash CHAR(64) NULL,
  last_success_at DATETIME(3) NULL,
  last_attempt_at DATETIME(3) NULL,
  last_error TEXT NULL,
  next_retry_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_pos_cloud_sync_singleton CHECK (id = 1),
  CONSTRAINT chk_pos_cloud_sync_interval CHECK (interval_minutes BETWEEN 1 AND 1440),
  CONSTRAINT chk_pos_cloud_sync_batch CHECK (batch_size BETWEEN 10 AND 500),
  CONSTRAINT chk_pos_cloud_sync_run_batches CHECK (max_batches_per_run BETWEEN 1 AND 20)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pos_cloud_sync_cursors (
  entity_type VARCHAR(80) NOT NULL PRIMARY KEY,
  cursor_at DATETIME(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000',
  cursor_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pos_cloud_sync_outbox (
  sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(80) NOT NULL,
  source_key VARCHAR(700) NOT NULL,
  loc_code VARCHAR(64) NULL,
  mac_code VARCHAR(64) NULL,
  operation ENUM('upsert','delete') NOT NULL DEFAULT 'upsert',
  payload JSON NOT NULL,
  source_created_at DATETIME(3) NULL,
  source_updated_at DATETIME(3) NULL,
  queued_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_attempt_at DATETIME(3) NULL,
  last_error TEXT NULL,
  KEY idx_pos_cloud_outbox_sequence (sequence),
  KEY idx_pos_cloud_outbox_entity (entity_type, sequence)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE invoices ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE invoice_items ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE payments ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE refunds ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE refund_items ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE refund_payments ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE refund_audit_events ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE cash_shifts ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE cash_counts ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE cash_count_lines ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE cash_movements ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE cash_shift_reports ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE cash_shift_report_prints ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE stock_movements ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE inventory_lots ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE inventory_measurements ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE inventory_stock_counts ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE inventory_stock_count_lines ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE lot_sale_allocations ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE parties ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE party_identifiers ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE customer_accounts ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE customer_receivable_entries ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE invoice_customer_assignment_events ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE cheques ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE cheque_status_events ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE issued_cheques ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE issued_cheque_status_events ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE business_bank_accounts ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE business_days ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE business_day_events ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE goods_receipts ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE goods_receipt_lines ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE products ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);

INSERT INTO core_migrations (migration_name, batch)
VALUES ('080_create_pos_cloud_archive_sync.sql', @tally_upgrade_batch);

-- ============================================================================
-- 081_index_pos_cloud_archive_sources.sql
-- ============================================================================
-- Keep background change scans bounded on long-lived POS databases.
CREATE INDEX idx_invoices_cloud_sync ON invoices (cloud_sync_updated_at, id);
CREATE INDEX idx_invoice_items_cloud_sync ON invoice_items (cloud_sync_updated_at, id);
CREATE INDEX idx_payments_cloud_sync ON payments (cloud_sync_updated_at, id);
CREATE INDEX idx_refunds_cloud_sync ON refunds (cloud_sync_updated_at, id);
CREATE INDEX idx_refund_items_cloud_sync ON refund_items (cloud_sync_updated_at, id);
CREATE INDEX idx_refund_payments_cloud_sync ON refund_payments (cloud_sync_updated_at, id);
CREATE INDEX idx_cash_movements_cloud_sync ON cash_movements (cloud_sync_updated_at, id);
CREATE INDEX idx_stock_movements_cloud_sync ON stock_movements (cloud_sync_updated_at, id);
CREATE INDEX idx_receivable_entries_cloud_sync ON customer_receivable_entries (cloud_sync_updated_at, id);
CREATE INDEX idx_cheques_cloud_sync ON cheques (cloud_sync_updated_at, id);
CREATE INDEX idx_issued_cheques_cloud_sync ON issued_cheques (cloud_sync_updated_at, id);
CREATE INDEX idx_business_days_cloud_sync ON business_days (cloud_sync_updated_at, id);
CREATE INDEX idx_goods_receipts_cloud_sync ON goods_receipts (cloud_sync_updated_at, id);
CREATE INDEX idx_goods_receipt_lines_cloud_sync ON goods_receipt_lines (cloud_sync_updated_at, id);
CREATE INDEX idx_products_cloud_sync ON products (cloud_sync_updated_at, id);

INSERT INTO core_migrations (migration_name, batch)
VALUES ('081_index_pos_cloud_archive_sources.sql', @tally_upgrade_batch);

-- ============================================================================
-- 082_create_dual_uom_inventory.sql
-- ============================================================================
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
JOIN inventory_lots l ON m.reference_type = 'inventory_lot' AND CAST(m.reference_id AS UNSIGNED) = l.id
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

INSERT INTO core_migrations (migration_name, batch)
VALUES ('082_create_dual_uom_inventory.sql', @tally_upgrade_batch);

-- ============================================================================
-- 083_add_lot_ratio_monitoring.sql
-- ============================================================================
-- Keep catch-weight / conversion tolerances with the receiving lot.
-- The expected ratio is intentionally not a product-master attribute because
-- packaging and measured contents can vary between deliveries of the same item.

ALTER TABLE goods_receipt_lines
  ADD COLUMN ratio_tolerance_percent DECIMAL(7,3) NOT NULL DEFAULT 20 AFTER actual_base_per_handling;

ALTER TABLE inventory_lots
  ADD COLUMN ratio_tolerance_percent DECIMAL(7,3) NOT NULL DEFAULT 20 AFTER actual_base_per_handling;

INSERT INTO core_migrations (migration_name, batch)
VALUES ('083_add_lot_ratio_monitoring.sql', @tally_upgrade_batch);

-- ============================================================================
-- 084_add_lot_allocation_priority_and_reconciliation.sql
-- ============================================================================
-- Explicit stock-lot priority for live billing plus auditable reconciliation.

ALTER TABLE invoice_items
  ADD COLUMN allocation_priority_lot_id BIGINT UNSIGNED NULL AFTER base_uom_snapshot,
  ADD COLUMN allocation_priority_source ENUM('automatic','remembered','manual') NULL AFTER allocation_priority_lot_id,
  ADD COLUMN allocation_priority_set_by BIGINT UNSIGNED NULL AFTER allocation_priority_source,
  ADD COLUMN allocation_priority_set_at TIMESTAMP NULL AFTER allocation_priority_set_by,
  ADD KEY idx_invoice_items_allocation_priority (allocation_priority_lot_id),
  ADD CONSTRAINT fk_invoice_items_allocation_priority_lot
    FOREIGN KEY (allocation_priority_lot_id) REFERENCES inventory_lots(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_invoice_items_allocation_priority_user
    FOREIGN KEY (allocation_priority_set_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS inventory_lot_preferences (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  loc_code VARCHAR(50) NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  inventory_lot_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_lot_preferences_scope (loc_code, product_id, user_id),
  KEY idx_inventory_lot_preferences_lot (inventory_lot_id),
  CONSTRAINT fk_inventory_lot_preferences_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_inventory_lot_preferences_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_inventory_lot_preferences_lot FOREIGN KEY (inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_allocation_exceptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_item_id BIGINT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  document_no INT UNSIGNED NOT NULL,
  line_no INT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  unallocated_handling_quantity DECIMAL(14,3) NOT NULL DEFAULT 0,
  unallocated_base_quantity DECIMAL(14,3) NULL,
  status ENUM('open','resolved') NOT NULL DEFAULT 'open',
  resolution_note VARCHAR(255) NULL,
  resolved_by BIGINT UNSIGNED NULL,
  resolved_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_allocation_exception_item (invoice_item_id),
  KEY idx_inventory_allocation_exceptions_queue (loc_code, status, txn_date, id),
  KEY idx_inventory_allocation_exceptions_product (loc_code, product_id, status),
  CONSTRAINT fk_inventory_allocation_exceptions_item FOREIGN KEY (invoice_item_id) REFERENCES invoice_items(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_allocation_exceptions_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_allocation_exceptions_resolver FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_allocation_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_item_id BIGINT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  document_no INT UNSIGNED NOT NULL,
  line_no INT UNSIGNED NOT NULL,
  event_no INT UNSIGNED NOT NULL,
  event_type ENUM('manual_allocate','reallocate') NOT NULL,
  from_inventory_lot_id BIGINT UNSIGNED NULL,
  to_inventory_lot_id BIGINT UNSIGNED NOT NULL,
  handling_quantity DECIMAL(14,3) NOT NULL DEFAULT 0,
  base_quantity DECIMAL(14,3) NULL,
  reason VARCHAR(255) NOT NULL,
  details JSON NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_allocation_events_origin (loc_code, mac_code, txn_date, document_no, line_no, event_no),
  KEY idx_inventory_allocation_events_item (invoice_item_id, id),
  CONSTRAINT fk_inventory_allocation_events_item FOREIGN KEY (invoice_item_id) REFERENCES invoice_items(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_allocation_events_from_lot FOREIGN KEY (from_inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_allocation_events_to_lot FOREIGN KEY (to_inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_allocation_events_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_inventory_allocation_events_reason CHECK (CHAR_LENGTH(TRIM(reason)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE inventory_lots
  ADD KEY idx_inventory_lots_fifo (loc_code, product_id, txn_date, grn_no, line_no, id);

INSERT INTO core_migrations (migration_name, batch)
VALUES ('084_add_lot_allocation_priority_and_reconciliation.sql', @tally_upgrade_batch);

-- ============================================================================
-- 085_backfill_inventory_allocation_exceptions.sql
-- ============================================================================
-- Surface finalized historical sale quantities that were never assigned to a
-- GRN lot. Overall inventory already includes these sales, so reconciliation
-- will only consume lot balances.

INSERT INTO inventory_allocation_exceptions
  (invoice_item_id, loc_code, mac_code, txn_date, document_no, line_no, product_id,
   unallocated_handling_quantity, unallocated_base_quantity, status)
SELECT i.id, i.loc_code, i.mac_code, i.txn_date, i.receipt_no, i.seq_no, i.product_id,
       GREATEST(0, ROUND(COALESCE(i.handling_quantity, i.quantity, 0) - COALESCE(SUM(a.handling_quantity), 0), 3)),
       CASE WHEN i.base_quantity IS NULL AND i.kilos IS NULL THEN NULL
            ELSE GREATEST(0, ROUND(COALESCE(i.base_quantity, i.kilos, 0) - COALESCE(SUM(a.base_quantity), 0), 3)) END,
       'open'
FROM invoice_items i
JOIN invoices v ON v.id = i.invoice_id
LEFT JOIN lot_sale_allocations a ON a.invoice_item_id = i.id AND a.document_type = 'sale'
WHERE i.product_id IS NOT NULL AND v.inv_stat = 'active' AND v.status IN ('paid','partial')
GROUP BY i.id, i.loc_code, i.mac_code, i.txn_date, i.receipt_no, i.seq_no, i.product_id,
         i.handling_quantity, i.quantity, i.base_quantity, i.kilos
HAVING GREATEST(0, ROUND(COALESCE(i.handling_quantity, i.quantity, 0) - COALESCE(SUM(a.handling_quantity), 0), 3)) > 0.0005
    OR GREATEST(0, ROUND(COALESCE(i.base_quantity, i.kilos, 0) - COALESCE(SUM(a.base_quantity), 0), 3)) > 0.0005
ON DUPLICATE KEY UPDATE
  unallocated_handling_quantity = VALUES(unallocated_handling_quantity),
  unallocated_base_quantity = VALUES(unallocated_base_quantity),
  status = 'open', resolution_note = NULL, resolved_by = NULL, resolved_at = NULL;

INSERT INTO core_migrations (migration_name, batch)
VALUES ('085_backfill_inventory_allocation_exceptions.sql', @tally_upgrade_batch);

-- ============================================================================
-- 086_create_customer_advance_ledger.sql
-- ============================================================================
-- Customer advances are liabilities until applied to a finalized invoice or refunded.

INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('customer-advances.view', 'Customer Advances View'),
  ('customer-advances.create', 'Customer Advances Create'),
  ('customer-advances.refund', 'Customer Advances Refund');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id AND source.permission_key = 'customers.view'
JOIN permissions target ON target.permission_key = 'customer-advances.view';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id AND source.permission_key = 'receivables.collect'
JOIN permissions target ON target.permission_key = 'customer-advances.create';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id AND source.permission_key = 'customers.manage'
JOIN permissions target ON target.permission_key = 'customer-advances.refund';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.permission_key IN ('customer-advances.view','customer-advances.create','customer-advances.refund')
WHERE r.role_key = 'admin';

CREATE TABLE customer_advance_receipts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_day_id BIGINT UNSIGNED NOT NULL,
  customer_account_id BIGINT UNSIGNED NOT NULL,
  cash_shift_id BIGINT UNSIGNED NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  advance_no INT UNSIGNED NOT NULL,
  advance_number VARCHAR(190) NOT NULL,
  original_amount DECIMAL(12,2) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  status ENUM('active','applied','refunded','void') NOT NULL DEFAULT 'active',
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_advance_origin (loc_code, mac_code, txn_date, advance_no),
  UNIQUE KEY uq_customer_advance_number (advance_number),
  KEY idx_customer_advance_balance (customer_account_id, loc_code, status, txn_date, id),
  CONSTRAINT fk_customer_advance_day FOREIGN KEY (business_day_id, loc_code, txn_date) REFERENCES business_days(id, loc_code, business_date) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_account FOREIGN KEY (customer_account_id) REFERENCES customer_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_shift FOREIGN KEY (cash_shift_id) REFERENCES cash_shifts(id) ON DELETE SET NULL,
  CONSTRAINT fk_customer_advance_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_customer_advance_amount CHECK (original_amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_advance_payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  advance_receipt_id BIGINT UNSIGNED NOT NULL,
  payment_no INT UNSIGNED NOT NULL,
  method VARCHAR(60) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  provider_ref VARCHAR(190) NULL,
  details JSON NULL,
  status ENUM('completed','refunded','void') NOT NULL DEFAULT 'completed',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_advance_payment (advance_receipt_id, payment_no),
  CONSTRAINT fk_customer_advance_payment_receipt FOREIGN KEY (advance_receipt_id) REFERENCES customer_advance_receipts(id) ON DELETE RESTRICT,
  CONSTRAINT chk_customer_advance_payment_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_advance_refunds (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_day_id BIGINT UNSIGNED NOT NULL,
  customer_account_id BIGINT UNSIGNED NOT NULL,
  cash_shift_id BIGINT UNSIGNED NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  refund_no INT UNSIGNED NOT NULL,
  refund_number VARCHAR(190) NOT NULL,
  method VARCHAR(60) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  provider_ref VARCHAR(190) NULL,
  reason VARCHAR(255) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_advance_refund_origin (loc_code, mac_code, txn_date, refund_no),
  UNIQUE KEY uq_customer_advance_refund_number (refund_number),
  CONSTRAINT fk_customer_advance_refund_day FOREIGN KEY (business_day_id, loc_code, txn_date) REFERENCES business_days(id, loc_code, business_date) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_refund_account FOREIGN KEY (customer_account_id) REFERENCES customer_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_refund_shift FOREIGN KEY (cash_shift_id) REFERENCES cash_shifts(id) ON DELETE SET NULL,
  CONSTRAINT fk_customer_advance_refund_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_customer_advance_refund_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_advance_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  advance_receipt_id BIGINT UNSIGNED NOT NULL,
  customer_account_id BIGINT UNSIGNED NOT NULL,
  business_day_id BIGINT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  document_type VARCHAR(40) NOT NULL,
  document_no INT UNSIGNED NOT NULL,
  entry_no INT UNSIGNED NOT NULL,
  invoice_id BIGINT UNSIGNED NULL,
  refund_id BIGINT UNSIGNED NULL,
  advance_refund_id BIGINT UNSIGNED NULL,
  entry_type ENUM('receipt_credit','application_debit','refund_debit','reversal_debit','restore_credit') NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_advance_entry_origin (loc_code, mac_code, txn_date, document_type, document_no, entry_no),
  KEY idx_customer_advance_entries_balance (customer_account_id, loc_code, advance_receipt_id, id),
  KEY idx_customer_advance_entries_invoice (invoice_id),
  CONSTRAINT fk_customer_advance_entry_receipt FOREIGN KEY (advance_receipt_id) REFERENCES customer_advance_receipts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_entry_account FOREIGN KEY (customer_account_id) REFERENCES customer_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_entry_day FOREIGN KEY (business_day_id, loc_code, txn_date) REFERENCES business_days(id, loc_code, business_date) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_entry_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_entry_refund FOREIGN KEY (refund_id) REFERENCES refunds(id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_entry_advance_refund FOREIGN KEY (advance_refund_id) REFERENCES customer_advance_refunds(id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_advance_entry_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_customer_advance_entry_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE invoice_advance_allocations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_id BIGINT UNSIGNED NOT NULL,
  payment_id BIGINT UNSIGNED NOT NULL,
  advance_receipt_id BIGINT UNSIGNED NOT NULL,
  advance_entry_id BIGINT UNSIGNED NOT NULL,
  allocation_no INT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_invoice_advance_allocation (invoice_id, allocation_no),
  KEY idx_invoice_advance_receipt (advance_receipt_id, id),
  CONSTRAINT fk_invoice_advance_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT,
  CONSTRAINT fk_invoice_advance_payment FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE RESTRICT,
  CONSTRAINT fk_invoice_advance_receipt FOREIGN KEY (advance_receipt_id) REFERENCES customer_advance_receipts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_invoice_advance_entry FOREIGN KEY (advance_entry_id) REFERENCES customer_advance_entries(id) ON DELETE RESTRICT,
  CONSTRAINT fk_invoice_advance_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_invoice_advance_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE cash_movements
  MODIFY COLUMN movement_type ENUM(
    'opening_float','sale_cash','receivable_collection_cash','supplier_settlement_cash',
    'customer_advance_cash','customer_advance_refund_cash',
    'change_given','refund_cash','cash_in','cash_out','safe_drop','bank_drop','correction'
  ) NOT NULL;

INSERT INTO payment_modes
  (mode_key, display_name, icon, mode_type, sort_order, is_enabled, is_system, configuration)
VALUES
  ('advance', 'Use Advance', 'ADV', 'tender', 40, 1, 1,
   JSON_OBJECT('fundingSource','customer_advance','requiresCustomer',TRUE,'allowOverpay',FALSE,'createsCashMovement',FALSE,'supportsRefundPayout',FALSE))
ON DUPLICATE KEY UPDATE configuration = VALUES(configuration), display_name = VALUES(display_name), is_system = 1;

INSERT INTO core_migrations (migration_name, batch)
VALUES ('086_create_customer_advance_ledger.sql', @tally_upgrade_batch);

-- ============================================================================
-- 087_link_advance_restorations_to_invoice_allocations.sql
-- ============================================================================
ALTER TABLE customer_advance_entries
  ADD COLUMN invoice_advance_allocation_id BIGINT UNSIGNED NULL AFTER advance_refund_id,
  ADD KEY idx_customer_advance_entries_allocation (invoice_advance_allocation_id),
  ADD CONSTRAINT fk_customer_advance_entry_allocation
    FOREIGN KEY (invoice_advance_allocation_id) REFERENCES invoice_advance_allocations(id) ON DELETE RESTRICT;

UPDATE payment_modes
SET configuration = JSON_OBJECT(
  'fundingSource','customer_advance',
  'requiresCustomer',TRUE,
  'allowOverpay',FALSE,
  'createsCashMovement',FALSE,
  'supportsRefundPayout',TRUE,
  'restoresCustomerAdvance',TRUE
)
WHERE mode_key = 'advance';

INSERT INTO core_migrations (migration_name, batch)
VALUES ('087_link_advance_restorations_to_invoice_allocations.sql', @tally_upgrade_batch);

-- ============================================================================
-- 088_rename_advance_payment_mode.sql
-- ============================================================================
-- The tender tile and the printed receipt both render the payment mode's
-- display name, and "Use Advance" reads as an instruction rather than a tender
-- beside Cash, Card and Cheque. The screens that need the fuller wording label
-- it themselves.

UPDATE payment_modes SET display_name = 'Advance' WHERE mode_key = 'advance';

INSERT INTO core_migrations (migration_name, batch)
VALUES ('088_rename_advance_payment_mode.sql', @tally_upgrade_batch);

-- Final verification. This must return 9 rows numbered 080 through 088.
SELECT migration_name, batch, executed_at
FROM core_migrations
WHERE migration_name IN (
  '080_create_pos_cloud_archive_sync.sql',
  '081_index_pos_cloud_archive_sources.sql',
  '082_create_dual_uom_inventory.sql',
  '083_add_lot_ratio_monitoring.sql',
  '084_add_lot_allocation_priority_and_reconciliation.sql',
  '085_backfill_inventory_allocation_exceptions.sql',
  '086_create_customer_advance_ledger.sql',
  '087_link_advance_restorations_to_invoice_allocations.sql',
  '088_rename_advance_payment_mode.sql'
)
ORDER BY migration_name;

SELECT RELEASE_LOCK('tallytaps_pos_upgrade_079_088') AS upgrade_lock_released;

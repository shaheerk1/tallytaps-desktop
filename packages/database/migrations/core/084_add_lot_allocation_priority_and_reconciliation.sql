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


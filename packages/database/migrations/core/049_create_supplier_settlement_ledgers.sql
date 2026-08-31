CREATE TABLE IF NOT EXISTS lot_sale_allocations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  inventory_lot_id BIGINT UNSIGNED NOT NULL,
  invoice_item_id BIGINT UNSIGNED NULL,
  refund_item_id BIGINT UNSIGNED NULL,
  quantity DECIMAL(14,3) NOT NULL DEFAULT 0,
  kilos DECIMAL(14,3) NULL,
  sale_value DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_lot_sale_allocations_lot (inventory_lot_id),
  KEY idx_lot_sale_allocations_invoice_item (invoice_item_id),
  CONSTRAINT fk_lot_sale_allocations_lot FOREIGN KEY (inventory_lot_id) REFERENCES inventory_lots(id),
  CONSTRAINT fk_lot_sale_allocations_invoice_item FOREIGN KEY (invoice_item_id) REFERENCES invoice_items(id) ON DELETE SET NULL,
  CONSTRAINT fk_lot_sale_allocations_refund_item FOREIGN KEY (refund_item_id) REFERENCES refund_items(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS supplier_payable_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  supplier_id BIGINT UNSIGNED NOT NULL,
  goods_receipt_id BIGINT UNSIGNED NULL,
  inventory_lot_id BIGINT UNSIGNED NULL,
  entry_type ENUM('purchase_debit','consignment_accrual','charge_debit','adjustment','payment_credit','return_credit') NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  business_date DATE NOT NULL,
  reason VARCHAR(255) NULL,
  created_by BIGINT UNSIGNED NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_supplier_payable_supplier_date (supplier_id, business_date),
  CONSTRAINT fk_supplier_payable_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_supplier_payable_grn FOREIGN KEY (goods_receipt_id) REFERENCES goods_receipts(id) ON DELETE SET NULL,
  CONSTRAINT fk_supplier_payable_lot FOREIGN KEY (inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

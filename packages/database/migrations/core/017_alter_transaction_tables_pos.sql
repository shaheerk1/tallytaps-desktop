-- Add POS transaction columns to invoices (maps to old pos_txn_mas)
ALTER TABLE invoices
  ADD COLUMN loc_code VARCHAR(50) NOT NULL DEFAULT '' AFTER invoice_number,
  ADD COLUMN mac_code VARCHAR(50) NOT NULL DEFAULT '' AFTER loc_code,
  ADD COLUMN receipt_no INT UNSIGNED NULL AFTER mac_code,
  ADD COLUMN txn_date DATE NULL AFTER receipt_no,
  ADD COLUMN sale_type VARCHAR(30) NOT NULL DEFAULT 'cash' AFTER user_id,
  ADD COLUMN start_time DATETIME NULL AFTER balance,
  ADD COLUMN end_time DATETIME NULL AFTER start_time,
  ADD COLUMN inv_stat ENUM('active','void','refund') NOT NULL DEFAULT 'active' AFTER end_time,
  ADD COLUMN cre_by BIGINT UNSIGNED NULL AFTER inv_stat,
  ADD COLUMN mod_by BIGINT UNSIGNED NULL AFTER cre_by,
  ADD COLUMN upd_stat TINYINT(1) NOT NULL DEFAULT 1 AFTER mod_by,
  ADD COLUMN remark VARCHAR(255) NULL AFTER upd_stat,
  ADD KEY idx_invoices_receipt (loc_code, mac_code, receipt_no),
  ADD KEY idx_invoices_txn_date (txn_date);

-- Add POS transaction columns to invoice_items (maps to old pos_txn_det)
ALTER TABLE invoice_items
  ADD COLUMN seq_no INT UNSIGNED NOT NULL DEFAULT 1 AFTER invoice_id,
  ADD COLUMN item_code VARCHAR(120) NOT NULL DEFAULT '' AFTER product_id,
  ADD COLUMN inv_stat ENUM('active','void','refund') NOT NULL DEFAULT 'active' AFTER total,
  ADD COLUMN cre_by BIGINT UNSIGNED NULL AFTER inv_stat,
  ADD COLUMN mod_by BIGINT UNSIGNED NULL AFTER cre_by,
  ADD COLUMN upd_stat TINYINT(1) NOT NULL DEFAULT 1 AFTER mod_by,
  ADD COLUMN remark VARCHAR(255) NULL AFTER upd_stat,
  ADD KEY idx_invoice_items_code (item_code);

ALTER TABLE stock_movements
  ADD COLUMN business_date DATE NULL AFTER quantity,
  ADD COLUMN created_by BIGINT UNSIGNED NULL AFTER note,
  ADD KEY idx_stock_movements_business_date (business_date),
  ADD KEY idx_stock_movements_reference (reference_type, reference_id);

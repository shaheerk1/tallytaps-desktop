ALTER TABLE lot_sale_allocations
  ADD COLUMN source_allocation_id BIGINT UNSIGNED NULL AFTER refund_item_id,
  ADD KEY idx_lot_sale_allocations_source (source_allocation_id),
  ADD CONSTRAINT fk_lot_sale_allocations_source FOREIGN KEY (source_allocation_id) REFERENCES lot_sale_allocations(id) ON DELETE SET NULL;

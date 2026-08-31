ALTER TABLE cash_movements
  MODIFY COLUMN movement_type ENUM(
    'opening_float','sale_cash','receivable_collection_cash','supplier_settlement_cash',
    'change_given','refund_cash','cash_in','cash_out','safe_drop','bank_drop','correction'
  ) NOT NULL;

ALTER TABLE supplier_payments
  ADD COLUMN cash_shift_id BIGINT UNSIGNED NULL AFTER reference,
  ADD CONSTRAINT fk_supplier_payments_cash_shift FOREIGN KEY (cash_shift_id) REFERENCES cash_shifts(id) ON DELETE SET NULL;

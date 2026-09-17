-- A lot expense recorded against a GRN can be deducted on a supplier statement.
-- The deduction line keeps which expense it came from, so one expense is only
-- ever deducted once.
ALTER TABLE supplier_sale_statement_adjustments
  ADD COLUMN expense_entry_id BIGINT UNSIGNED NULL AFTER note,
  ADD KEY idx_supplier_statement_adjustment_expense (expense_entry_id, statement_id),
  ADD CONSTRAINT fk_supplier_statement_adjustment_expense FOREIGN KEY (expense_entry_id) REFERENCES expense_entries(id) ON DELETE RESTRICT;

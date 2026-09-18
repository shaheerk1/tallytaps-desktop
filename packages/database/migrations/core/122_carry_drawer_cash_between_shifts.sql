-- The cash counted when a shift closes stays in the drawer for the next shift.
-- A new shift's opening count is checked against it; any difference needs a
-- reason and is kept on the shift, next to the closing variance.
ALTER TABLE cash_shifts
  ADD COLUMN carried_from_shift_id BIGINT UNSIGNED NULL AFTER opening_total,
  ADD COLUMN carried_in_total DECIMAL(14,2) NULL AFTER carried_from_shift_id,
  ADD COLUMN opening_difference DECIMAL(14,2) NULL AFTER carried_in_total,
  ADD COLUMN opening_difference_reason VARCHAR(255) NULL AFTER opening_difference,
  ADD KEY idx_cash_shifts_drawer_closed (drawer_id, status, closed_at),
  ADD CONSTRAINT fk_cash_shifts_carried_from FOREIGN KEY (carried_from_shift_id) REFERENCES cash_shifts(id) ON DELETE RESTRICT;

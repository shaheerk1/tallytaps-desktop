-- Cheques are tender payments, not cash-drawer movements. Keep their
-- receipting details on the payment record so the sale, archive, and future
-- bank-clearing workflow share one durable reference.
ALTER TABLE payments
  ADD COLUMN cheque_number VARCHAR(80) NULL AFTER provider_ref,
  ADD COLUMN cheque_date DATE NULL AFTER cheque_number,
  ADD COLUMN cheque_bank VARCHAR(160) NULL AFTER cheque_date,
  ADD COLUMN cheque_branch VARCHAR(160) NULL AFTER cheque_bank,
  ADD COLUMN cheque_drawer_name VARCHAR(160) NULL AFTER cheque_branch,
  ADD COLUMN cheque_account_reference VARCHAR(100) NULL AFTER cheque_drawer_name,
  ADD COLUMN cheque_notes VARCHAR(255) NULL AFTER cheque_account_reference,
  ADD KEY idx_payments_cheque_reference (cheque_number, cheque_bank);

-- Paying suppliers by cheque, and one list of bank accounts.
--
-- 1. Every bank fund is also a cheque bank account. Migration 098 linked each
--    cheque bank account to a new bank fund; a bank fund added in Money had no
--    cheque account, so it could not issue a cheque or receive a deposit.
-- 2. A supplier account payment can be made with our own cheque (an issued
--    cheque) or by passing on a cheque received from a customer.

INSERT INTO business_bank_accounts
  (loc_code, mac_code, account_no, fund_account_id, account_code, bank_name, branch_name, account_name, account_number, is_active, notes)
SELECT f.loc_code, 'FUND', f.id, f.id, CONCAT('BA-FUND-', f.id), f.name, NULL,
       COALESCE(NULLIF(TRIM(f.holder_name), ''), f.name),
       COALESCE(NULLIF(TRIM(f.account_reference), ''), f.fund_code),
       f.is_active, 'Created from the bank fund of the same name'
FROM fund_accounts f
LEFT JOIN business_bank_accounts b ON b.fund_account_id = f.id
WHERE f.fund_kind = 'bank' AND b.id IS NULL;

ALTER TABLE supplier_account_entries
  ADD COLUMN payment_method ENUM('fund','own_cheque','customer_cheque') NULL AFTER entry_type,
  ADD COLUMN issued_cheque_id BIGINT UNSIGNED NULL AFTER fund_movement_id,
  ADD COLUMN cheque_id BIGINT UNSIGNED NULL AFTER issued_cheque_id,
  ADD KEY idx_supplier_account_entries_issued_cheque (issued_cheque_id),
  ADD KEY idx_supplier_account_entries_cheque (cheque_id),
  ADD CONSTRAINT fk_supplier_account_entries_issued_cheque FOREIGN KEY (issued_cheque_id) REFERENCES issued_cheques(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_supplier_account_entries_cheque FOREIGN KEY (cheque_id) REFERENCES cheques(id) ON DELETE RESTRICT;

UPDATE supplier_account_entries SET payment_method = 'fund' WHERE entry_type = 'payment' AND payment_method IS NULL;

ALTER TABLE issued_cheques
  MODIFY COLUMN purpose ENUM('supplier_settlement','supplier_account','other') NOT NULL DEFAULT 'other',
  ADD COLUMN supplier_account_entry_id BIGINT UNSIGNED NULL AFTER supplier_payment_id,
  ADD UNIQUE KEY uq_issued_cheques_supplier_account_entry (supplier_account_entry_id),
  ADD CONSTRAINT fk_issued_cheques_supplier_account_entry FOREIGN KEY (supplier_account_entry_id) REFERENCES supplier_account_entries(id) ON DELETE RESTRICT;

-- A received cheque handed on to a supplier as payment.
ALTER TABLE cheques
  MODIFY COLUMN status ENUM('received','deposited','passed_on','cleared','dishonoured','returned','cancelled','replaced') NOT NULL DEFAULT 'received',
  ADD COLUMN passed_to_supplier_id BIGINT UNSIGNED NULL AFTER deposited_fund_account_id,
  ADD COLUMN supplier_account_entry_id BIGINT UNSIGNED NULL AFTER passed_to_supplier_id,
  ADD COLUMN passed_at DATETIME NULL AFTER deposited_at,
  ADD KEY idx_cheques_passed_supplier (passed_to_supplier_id, status),
  ADD CONSTRAINT fk_cheques_passed_supplier FOREIGN KEY (passed_to_supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_cheques_supplier_account_entry FOREIGN KEY (supplier_account_entry_id) REFERENCES supplier_account_entries(id) ON DELETE RESTRICT;

-- A cheque payment names the cheque, not a fund, so the fund rule covers fund payments only.
ALTER TABLE supplier_account_entries
  DROP CHECK chk_supplier_account_entries_fund,
  ADD CONSTRAINT chk_supplier_account_entries_fund CHECK (
    entry_type <> 'payment'
    OR (payment_method = 'fund' AND fund_account_id IS NOT NULL)
    OR (payment_method = 'own_cheque' AND issued_cheque_id IS NOT NULL)
    OR (payment_method = 'customer_cheque' AND cheque_id IS NOT NULL)
  );

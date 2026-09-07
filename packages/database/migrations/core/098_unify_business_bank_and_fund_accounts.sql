-- The cheque register and Money workspace previously described the same bank
-- account in separate tables.  Link them so a cleared cheque, card receipt,
-- transfer, or expense all contribute to one understandable account statement.

SET @tally_bank_fund_column = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'business_bank_accounts' AND column_name = 'fund_account_id'
);
SET @tally_bank_fund_sql = IF(
  @tally_bank_fund_column = 0,
  'ALTER TABLE business_bank_accounts ADD COLUMN fund_account_id BIGINT UNSIGNED NULL AFTER account_no',
  'SELECT 1'
);
PREPARE tally_bank_fund_stmt FROM @tally_bank_fund_sql;
EXECUTE tally_bank_fund_stmt;
DEALLOCATE PREPARE tally_bank_fund_stmt;

INSERT INTO fund_accounts
  (fund_code, name, fund_kind, loc_code, account_reference, opening_balance, is_active, sort_order, notes)
SELECT CONCAT('BANK-', b.account_code),
       CONCAT(b.bank_name, ' · ', b.account_name),
       'bank', b.loc_code, b.account_number, 0, b.is_active, 40,
       CONCAT('Linked automatically to cheque account ', b.account_code)
FROM business_bank_accounts b
LEFT JOIN fund_accounts f ON f.fund_code = CONCAT('BANK-', b.account_code)
WHERE f.id IS NULL;

UPDATE business_bank_accounts b
JOIN fund_accounts f ON f.fund_code = CONCAT('BANK-', b.account_code)
SET b.fund_account_id = f.id
WHERE b.fund_account_id IS NULL;

ALTER TABLE business_bank_accounts
  MODIFY COLUMN fund_account_id BIGINT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_business_bank_fund (fund_account_id),
  ADD CONSTRAINT fk_business_bank_fund FOREIGN KEY (fund_account_id) REFERENCES fund_accounts(id) ON DELETE RESTRICT;

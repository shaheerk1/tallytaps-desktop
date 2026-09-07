-- Name the actual business pocket used by non-cash receipts and payments.
-- Nullable columns preserve every existing terminal and historical row.  Cash,
-- cheque, pending credit, and stored advance retain their purpose-built flows.

ALTER TABLE payments
  ADD COLUMN fund_account_id BIGINT UNSIGNED NULL AFTER method,
  ADD KEY idx_payments_fund (fund_account_id, txn_date),
  ADD CONSTRAINT fk_payments_fund FOREIGN KEY (fund_account_id) REFERENCES fund_accounts(id) ON DELETE RESTRICT;

ALTER TABLE refund_payments
  ADD COLUMN fund_account_id BIGINT UNSIGNED NULL AFTER method,
  ADD KEY idx_refund_payments_fund (fund_account_id, txn_date),
  ADD CONSTRAINT fk_refund_payments_fund FOREIGN KEY (fund_account_id) REFERENCES fund_accounts(id) ON DELETE RESTRICT;

ALTER TABLE customer_advance_payments
  ADD COLUMN fund_account_id BIGINT UNSIGNED NULL AFTER method,
  ADD KEY idx_customer_advance_payments_fund (fund_account_id),
  ADD CONSTRAINT fk_customer_advance_payments_fund FOREIGN KEY (fund_account_id) REFERENCES fund_accounts(id) ON DELETE RESTRICT;

ALTER TABLE customer_advance_refunds
  ADD COLUMN fund_account_id BIGINT UNSIGNED NULL AFTER method,
  ADD KEY idx_customer_advance_refunds_fund (fund_account_id, txn_date),
  ADD CONSTRAINT fk_customer_advance_refunds_fund FOREIGN KEY (fund_account_id) REFERENCES fund_accounts(id) ON DELETE RESTRICT;

ALTER TABLE supplier_payments
  ADD COLUMN fund_account_id BIGINT UNSIGNED NULL AFTER method,
  ADD KEY idx_supplier_payments_fund (fund_account_id, txn_date),
  ADD CONSTRAINT fk_supplier_payments_fund FOREIGN KEY (fund_account_id) REFERENCES fund_accounts(id) ON DELETE RESTRICT;

ALTER TABLE cheques
  ADD COLUMN deposited_fund_account_id BIGINT UNSIGNED NULL AFTER deposited_to,
  ADD KEY idx_cheques_deposit_fund (deposited_fund_account_id, status),
  ADD CONSTRAINT fk_cheques_deposit_fund FOREIGN KEY (deposited_fund_account_id) REFERENCES fund_accounts(id) ON DELETE RESTRICT;

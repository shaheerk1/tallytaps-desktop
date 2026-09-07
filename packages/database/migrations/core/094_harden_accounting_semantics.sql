-- Accounting semantic hardening.
--
-- The first accounting release proved the mechanics (balanced entries, funds,
-- cost allocation and stakeholder movements).  This migration makes the
-- classification used by a posted event immutable and separates the very
-- different balances that were previously presented as one partner "claim".

ALTER TABLE expense_entries
  ADD COLUMN treatment_snapshot ENUM('lot_cost','overhead','supplier_deduction') NULL AFTER expense_category_id,
  ADD COLUMN request_id VARCHAR(80) NULL AFTER expense_number,
  ADD COLUMN voided_at DATETIME NULL AFTER status,
  ADD COLUMN voided_by BIGINT UNSIGNED NULL AFTER voided_at,
  ADD COLUMN void_reason VARCHAR(255) NULL AFTER voided_by,
  ADD UNIQUE KEY uq_expense_entries_request (loc_code, mac_code, request_id),
  ADD CONSTRAINT fk_expense_entries_void_user FOREIGN KEY (voided_by) REFERENCES users(id) ON DELETE RESTRICT;

UPDATE expense_entries e
JOIN expense_categories c ON c.id = e.expense_category_id
SET e.treatment_snapshot = c.default_treatment
WHERE e.treatment_snapshot IS NULL;

ALTER TABLE expense_entries
  MODIFY COLUMN treatment_snapshot ENUM('lot_cost','overhead','supplier_deduction') NOT NULL;

-- A stakeholder statement must never confuse permanent capital with a debt the
-- business must repay. Profit entitlement and drawings are separate again so
-- each action can be checked against the balance it is actually allowed to use.
ALTER TABLE stakeholder_ledger_entries
  ADD COLUMN balance_bucket ENUM('capital','repayable','profit','drawing') NULL AFTER entry_type;

UPDATE stakeholder_ledger_entries
SET balance_bucket = CASE
  WHEN entry_type = 'capital_contribution' THEN 'capital'
  WHEN entry_type = 'profit_share_allocation' THEN 'profit'
  WHEN entry_type = 'drawing' THEN 'drawing'
  WHEN entry_type = 'settlement' THEN 'repayable'
  WHEN entry_type = 'expense_borne' AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.treatment')) = 'liability' THEN 'repayable'
  ELSE 'capital'
END
WHERE balance_bucket IS NULL;

ALTER TABLE stakeholder_ledger_entries
  MODIFY COLUMN balance_bucket ENUM('capital','repayable','profit','drawing') NOT NULL,
  ADD KEY idx_stakeholder_ledger_bucket (stakeholder_id, balance_bucket, txn_date, id);

-- Effective-to makes ownership periods explicit. A later migration or the
-- repository closes the prior open interval when a new share starts.
ALTER TABLE stakeholder_shares
  ADD COLUMN effective_to DATE NULL AFTER effective_from,
  ADD CONSTRAINT chk_stakeholder_shares_dates CHECK (effective_to IS NULL OR effective_to >= effective_from);

-- Preserve every close and reopen instead of overwriting the person and reason
-- on the accounting_periods projection.
CREATE TABLE accounting_period_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  accounting_period_id BIGINT UNSIGNED NOT NULL,
  event_no INT UNSIGNED NOT NULL,
  event_type ENUM('closed','reopened') NOT NULL,
  reason VARCHAR(255) NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_accounting_period_events_no (accounting_period_id, event_no),
  KEY idx_accounting_period_events_actor (created_by, created_at),
  CONSTRAINT fk_accounting_period_events_period FOREIGN KEY (accounting_period_id) REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  CONSTRAINT fk_accounting_period_events_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO accounting_period_events (accounting_period_id, event_no, event_type, reason, created_by, created_at)
SELECT id, 1, 'closed', COALESCE(notes, 'Existing period close'), closed_by, COALESCE(closed_at, created_at)
FROM accounting_periods
WHERE status = 'closed' AND closed_by IS NOT NULL;

-- Accounts required by the existing POS subledgers. Codes remain fixed in code;
-- operators never choose debit and credit accounts.
INSERT INTO ledger_accounts (account_code, name, account_type, normal_balance, description, sort_order) VALUES
  ('1100', 'Incoming cheques',              'asset',     'debit',  'Customer cheques received but not yet cleared.', 35),
  ('1110', 'Customer receivables',          'asset',     'debit',  'Finalized sales customers still owe.', 36),
  ('1210', 'Deferred consignment costs',    'asset',     'debit',  'Business-borne costs attached to consignment goods not yet sold.', 45),
  ('2010', 'Supplier payables',             'liability', 'credit', 'Amounts owed to suppliers for owned and consignment goods.', 115),
  ('2050', 'Issued cheques outstanding',    'liability', 'credit', 'Issued cheques that have not yet cleared the business bank.', 120),
  ('2100', 'Customer advances',             'liability', 'credit', 'Customer money held for future invoices.', 125),
  ('4000', 'Merchandise sales',             'income',    'credit', 'Value of goods sold before item charges and returns.', 260),
  ('4010', 'Packaging and handling income', 'income',    'credit', 'Packaging charges collected on sales.', 265),
  ('4020', 'Measured-service income',       'income',    'credit', 'Wage or measured-unit service charges collected on sales.', 270),
  ('4090', 'Sales returns',                 'income',    'debit',  'Value returned or credited to customers.', 275),
  ('5010', 'Consignment supplier cost',     'expense',   'debit',  'Amount earned by suppliers when consignment stock sells.', 315),
  ('5200', 'Staff salaries and wages',      'expense',   'debit',  'Employee pay and related recurring staff costs.', 330),
  ('5900', 'Unclassified money movements',  'expense',   'debit',  'Temporary review account for legacy manual cash movements.', 390);

-- The cost recognized from a lot is a rebuildable projection. Late allocations
-- post only the delta, allowing profit to be recalculated repeatedly without
-- rewriting the original sale or allocation history.
CREATE TABLE lot_cost_recognition_state (
  inventory_lot_id BIGINT UNSIGNED NOT NULL,
  recognized_cost DECIMAL(14,2) NOT NULL DEFAULT 0,
  recognition_version INT UNSIGNED NOT NULL DEFAULT 0,
  last_journal_entry_id BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (inventory_lot_id),
  CONSTRAINT fk_lot_cost_recognition_lot FOREIGN KEY (inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lot_cost_recognition_journal FOREIGN KEY (last_journal_entry_id) REFERENCES journal_entries(id) ON DELETE RESTRICT,
  CONSTRAINT chk_lot_cost_recognition_amount CHECK (recognized_cost >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('stakeholders.override-drawing', 'Stakeholders Approve Excess Drawing'),
  ('expenses.void', 'Expenses Reverse'),
  ('accounting.reconcile', 'Accounting Reconcile Operational Ledgers');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.permission_key IN ('stakeholders.override-drawing','expenses.void','accounting.reconcile')
WHERE r.role_key = 'admin';


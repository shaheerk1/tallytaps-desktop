-- The derived double-entry journal.
--
-- Nobody types a debit. Operators record business events -- an expense, a
-- transfer, a contribution, a drawing, an allocation to a lot -- and a fixed
-- posting-rules service turns each one into balanced journal lines.
--
-- Why it earns its place: it is self-proving. If debits and credits disagree,
-- something is wrong, and that is a class of error the existing subledgers
-- cannot detect at all. It also means the trial balance, profit and loss, and
-- balance sheet all read one place instead of needing new tables each time.
--
-- Constraints, consistent with the DDEC plan's rejection of a formula engine:
-- posting rules are fixed code, lines are append-only and reversed only by
-- contra-entry, and no configuration surface may add or edit a rule.

INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('accounting.journal.view', 'Accounting Journal View'),
  ('accounting.period.close', 'Accounting Period Close');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id AND source.permission_key = 'users.manage'
JOIN permissions target ON target.permission_key IN ('accounting.journal.view','accounting.period.close');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.permission_key IN ('accounting.journal.view','accounting.period.close')
WHERE r.role_key = 'admin';

CREATE TABLE ledger_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_code VARCHAR(20) NOT NULL,
  name VARCHAR(150) NOT NULL,
  account_type ENUM('asset','liability','equity','income','expense') NOT NULL,
  normal_balance ENUM('debit','credit') NOT NULL,
  -- Plain-language line shown in accountant mode, so the chart is readable by
  -- the shop owner too.
  description VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 100,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ledger_accounts_code (account_code),
  KEY idx_ledger_accounts_type (account_type, sort_order, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE accounting_periods (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  loc_code VARCHAR(50) NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status ENUM('open','closed') NOT NULL DEFAULT 'open',
  closed_by BIGINT UNSIGNED NULL,
  closed_at TIMESTAMP NULL,
  reopen_count INT UNSIGNED NOT NULL DEFAULT 0,
  reopen_reason VARCHAR(255) NULL,
  notes VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_accounting_periods_start (loc_code, period_start),
  KEY idx_accounting_periods_range (loc_code, period_start, period_end),
  CONSTRAINT fk_accounting_periods_user FOREIGN KEY (closed_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_accounting_periods_range CHECK (period_end >= period_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE journal_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_day_id BIGINT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  document_type VARCHAR(40) NOT NULL,
  document_no INT UNSIGNED NOT NULL,
  entry_no INT UNSIGNED NOT NULL,
  journal_number VARCHAR(190) NOT NULL,
  -- What produced this entry. Never an operator.
  source_type VARCHAR(60) NOT NULL,
  source_id VARCHAR(120) NOT NULL,
  narration VARCHAR(255) NOT NULL,
  total_debit DECIMAL(14,2) NOT NULL,
  total_credit DECIMAL(14,2) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_journal_entries_origin (loc_code, mac_code, txn_date, document_type, document_no, entry_no),
  UNIQUE KEY uq_journal_entries_number (journal_number),
  UNIQUE KEY uq_journal_entries_source (source_type, source_id),
  KEY idx_journal_entries_period (loc_code, txn_date, id),
  CONSTRAINT fk_journal_entries_day FOREIGN KEY (business_day_id, loc_code, txn_date) REFERENCES business_days(id, loc_code, business_date) ON DELETE RESTRICT,
  CONSTRAINT fk_journal_entries_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  -- The self-proving rule, enforced by the database and not just by code.
  CONSTRAINT chk_journal_entries_balanced CHECK (total_debit = total_credit AND total_debit > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE journal_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  journal_entry_id BIGINT UNSIGNED NOT NULL,
  line_no INT UNSIGNED NOT NULL,
  ledger_account_id BIGINT UNSIGNED NOT NULL,
  debit DECIMAL(14,2) NOT NULL DEFAULT 0,
  credit DECIMAL(14,2) NOT NULL DEFAULT 0,
  -- Dimensions, so a figure can be traced back to the thing it came from.
  fund_account_id BIGINT UNSIGNED NULL,
  stakeholder_id BIGINT UNSIGNED NULL,
  inventory_lot_id BIGINT UNSIGNED NULL,
  expense_category_id BIGINT UNSIGNED NULL,
  memo VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_journal_lines_entry_line (journal_entry_id, line_no),
  KEY idx_journal_lines_account (ledger_account_id, id),
  KEY idx_journal_lines_lot (inventory_lot_id, id),
  KEY idx_journal_lines_stakeholder (stakeholder_id, id),
  CONSTRAINT fk_journal_lines_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE RESTRICT,
  CONSTRAINT fk_journal_lines_account FOREIGN KEY (ledger_account_id) REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_journal_lines_fund FOREIGN KEY (fund_account_id) REFERENCES fund_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_journal_lines_stakeholder FOREIGN KEY (stakeholder_id) REFERENCES stakeholders(id) ON DELETE RESTRICT,
  CONSTRAINT fk_journal_lines_lot FOREIGN KEY (inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  CONSTRAINT fk_journal_lines_category FOREIGN KEY (expense_category_id) REFERENCES expense_categories(id) ON DELETE RESTRICT,
  -- Exactly one side per line; no line is both a debit and a credit.
  CONSTRAINT chk_journal_lines_one_side CHECK (
    (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The chart of accounts. Small on purpose: only what Phase 1-3 events post to.
-- Sales and supplier settlement postings are deliberately out of scope; those
-- subledgers remain the source of truth until a later phase brings them in.
INSERT INTO ledger_accounts (account_code, name, account_type, normal_balance, description, sort_order) VALUES
  ('1000', 'Cash in till',              'asset',     'debit',  'Money in a POS drawer.', 10),
  ('1010', 'Cash in safe',              'asset',     'debit',  'Money held in the back-office safe.', 20),
  ('1020', 'Bank accounts',             'asset',     'debit',  'Money in a business bank account.', 30),
  ('1200', 'Inventory - landed cost',   'asset',     'debit',  'Costs attached to received goods that are not yet sold.', 40),
  ('2000', 'Owed to stakeholders',      'liability', 'credit', 'Money a partner spent for the business that the business will repay.', 110),
  ('3000', 'Stakeholder capital',       'equity',    'credit', 'Money partners have put into the business.', 210),
  ('3100', 'Stakeholder drawings',      'equity',    'debit',  'Money partners have taken out.', 220),
  ('3200', 'Allocated profit share',    'equity',    'credit', 'Profit approved as belonging to a partner.', 230),
  ('5000', 'Goods-related costs',       'expense',   'debit',  'Costs that belong to received goods before they are attached to a lot.', 310),
  ('5100', 'General business costs',    'expense',   'debit',  'Rent, wages, electricity and other costs of the period.', 320);

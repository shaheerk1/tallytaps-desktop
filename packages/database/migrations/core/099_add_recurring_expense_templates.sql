-- Recurring costs are reminders/templates, never silent financial postings.
-- A manager confirms each due item, at which point it becomes an ordinary
-- audited expense with the same fund, period, and journal protections.

CREATE TABLE recurring_expense_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  loc_code VARCHAR(20) NOT NULL,
  name VARCHAR(160) NOT NULL,
  expense_category_id BIGINT UNSIGNED NOT NULL,
  fund_account_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  payee VARCHAR(190) NULL,
  reference VARCHAR(160) NULL,
  reason VARCHAR(255) NOT NULL,
  cadence ENUM('weekly','monthly','yearly','custom_days') NOT NULL DEFAULT 'monthly',
  interval_count SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  next_due_date DATE NOT NULL,
  end_date DATE NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NOT NULL,
  updated_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_recurring_expense_due (loc_code, is_active, next_due_date),
  CONSTRAINT fk_recurring_expense_category FOREIGN KEY (expense_category_id) REFERENCES expense_categories(id) ON DELETE RESTRICT,
  CONSTRAINT fk_recurring_expense_fund FOREIGN KEY (fund_account_id) REFERENCES fund_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_recurring_expense_created_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_recurring_expense_updated_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_recurring_expense_amount CHECK (amount > 0),
  CONSTRAINT chk_recurring_expense_interval CHECK (interval_count > 0),
  CONSTRAINT chk_recurring_expense_dates CHECK (end_date IS NULL OR is_active = 0 OR end_date >= next_due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE recurring_expense_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  recurring_expense_template_id BIGINT UNSIGNED NOT NULL,
  due_date DATE NOT NULL,
  expense_entry_id BIGINT UNSIGNED NOT NULL,
  recorded_by BIGINT UNSIGNED NOT NULL,
  recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_recurring_expense_due (recurring_expense_template_id, due_date),
  UNIQUE KEY uq_recurring_expense_entry (expense_entry_id),
  CONSTRAINT fk_recurring_run_template FOREIGN KEY (recurring_expense_template_id) REFERENCES recurring_expense_templates(id) ON DELETE RESTRICT,
  CONSTRAINT fk_recurring_run_expense FOREIGN KEY (expense_entry_id) REFERENCES expense_entries(id) ON DELETE RESTRICT,
  CONSTRAINT fk_recurring_run_user FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('expenses.recurring.manage', 'Expenses Manage Recurring Costs');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.permission_key = 'expenses.recurring.manage'
WHERE r.role_key = 'admin';

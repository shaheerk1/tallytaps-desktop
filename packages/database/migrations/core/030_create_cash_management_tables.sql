-- Cash management is an append-only drawer/shift ledger. It deliberately
-- remains separate from login sessions and from domain-plugin billing rules.

ALTER TABLE workstation_sessions
  DROP INDEX uq_ws_session_date_user,
  ADD KEY idx_ws_sessions_workstation_date (workstation_id, billing_date);

CREATE TABLE IF NOT EXISTS cash_drawers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  workstation_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  drawer_mode ENUM('fixed', 'shared', 'nondrawer') NOT NULL DEFAULT 'fixed',
  currency_code CHAR(3) NOT NULL DEFAULT 'LKR',
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cash_drawers_workstation (workstation_id),
  CONSTRAINT fk_cash_drawers_workstation FOREIGN KEY (workstation_id) REFERENCES pos_workstations(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cash_shifts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  drawer_id BIGINT UNSIGNED NOT NULL,
  workstation_session_id BIGINT UNSIGNED NOT NULL,
  workstation_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  business_date DATE NOT NULL,
  status ENUM('open', 'blind_closed', 'closed') NOT NULL DEFAULT 'open',
  opening_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  expected_total DECIMAL(12,2) NULL,
  declared_total DECIMAL(12,2) NULL,
  variance_total DECIMAL(12,2) NULL,
  opened_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  blind_closed_at TIMESTAMP NULL,
  closed_at TIMESTAMP NULL,
  closed_by BIGINT UNSIGNED NULL,
  variance_reason VARCHAR(255) NULL,
  metadata JSON NULL,
  PRIMARY KEY (id),
  KEY idx_cash_shifts_drawer_status (drawer_id, status),
  KEY idx_cash_shifts_user_date (user_id, business_date),
  KEY idx_cash_shifts_workstation_date (workstation_id, business_date),
  CONSTRAINT fk_cash_shifts_drawer FOREIGN KEY (drawer_id) REFERENCES cash_drawers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cash_shifts_session FOREIGN KEY (workstation_session_id) REFERENCES workstation_sessions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cash_shifts_workstation FOREIGN KEY (workstation_id) REFERENCES pos_workstations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cash_shifts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cash_shifts_closed_by FOREIGN KEY (closed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cash_movements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cash_shift_id BIGINT UNSIGNED NOT NULL,
  movement_type ENUM('opening_float', 'sale_cash', 'change_given', 'refund_cash', 'cash_in', 'cash_out', 'safe_drop', 'bank_drop', 'correction') NOT NULL,
  direction ENUM('in', 'out') NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  currency_code CHAR(3) NOT NULL DEFAULT 'LKR',
  reference_type VARCHAR(60) NULL,
  reference_id VARCHAR(120) NULL,
  reason VARCHAR(255) NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata JSON NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cash_movement_source (cash_shift_id, movement_type, reference_type, reference_id),
  KEY idx_cash_movements_shift (cash_shift_id, created_at),
  CONSTRAINT fk_cash_movements_shift FOREIGN KEY (cash_shift_id) REFERENCES cash_shifts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cash_movements_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cash_counts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cash_shift_id BIGINT UNSIGNED NOT NULL,
  count_type ENUM('opening', 'closing') NOT NULL,
  total DECIMAL(12,2) NOT NULL DEFAULT 0,
  counted_by BIGINT UNSIGNED NOT NULL,
  counted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cash_count_shift_type (cash_shift_id, count_type),
  CONSTRAINT fk_cash_counts_shift FOREIGN KEY (cash_shift_id) REFERENCES cash_shifts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cash_counts_user FOREIGN KEY (counted_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cash_count_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cash_count_id BIGINT UNSIGNED NOT NULL,
  denomination DECIMAL(12,2) NOT NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 0,
  line_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cash_count_denomination (cash_count_id, denomination),
  CONSTRAINT fk_cash_count_lines_count FOREIGN KEY (cash_count_id) REFERENCES cash_counts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cash_shift_reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cash_shift_id BIGINT UNSIGNED NOT NULL,
  report_type ENUM('X', 'Z') NOT NULL,
  report_no INT UNSIGNED NULL,
  snapshot JSON NOT NULL,
  printed_at TIMESTAMP NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cash_shift_report (cash_shift_id, report_type, report_no),
  KEY idx_cash_shift_reports_shift (cash_shift_id, created_at),
  CONSTRAINT fk_cash_shift_reports_shift FOREIGN KEY (cash_shift_id) REFERENCES cash_shifts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cash_shift_reports_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE invoices
  ADD COLUMN cash_shift_id BIGINT UNSIGNED NULL AFTER txn_date,
  ADD KEY idx_invoices_cash_shift (cash_shift_id),
  ADD CONSTRAINT fk_invoices_cash_shift FOREIGN KEY (cash_shift_id) REFERENCES cash_shifts(id) ON DELETE SET NULL;

ALTER TABLE refunds
  ADD COLUMN cash_shift_id BIGINT UNSIGNED NULL AFTER txn_date,
  ADD KEY idx_refunds_cash_shift (cash_shift_id),
  ADD CONSTRAINT fk_refunds_cash_shift FOREIGN KEY (cash_shift_id) REFERENCES cash_shifts(id) ON DELETE SET NULL;

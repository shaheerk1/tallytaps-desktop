-- Workstation sessions: tracks the daily billing context per login
-- Each login opens a session tied to a workstation + billing date
-- The current_receipt_no resets per day per workstation for unique invoice numbering
CREATE TABLE IF NOT EXISTS workstation_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  workstation_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  billing_date DATE NOT NULL,
  opening_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  current_receipt_no INT UNSIGNED NOT NULL DEFAULT 1,
  status ENUM('open', 'closed') NOT NULL DEFAULT 'open',
  opened_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ws_session_date_user (workstation_id, billing_date, user_id),
  KEY idx_ws_sessions_status (status),
  KEY idx_ws_sessions_user (user_id),
  CONSTRAINT fk_ws_sessions_workstation FOREIGN KEY (workstation_id) REFERENCES pos_workstations(id) ON DELETE CASCADE,
  CONSTRAINT fk_ws_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

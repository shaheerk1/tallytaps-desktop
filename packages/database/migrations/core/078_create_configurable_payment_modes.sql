-- Payment modes are operational configuration, not hard-coded UI options.
-- Administrators can enable/disable or reorder modes directly in this table;
-- billing and refunds reload the configuration before use.
CREATE TABLE payment_modes (
  mode_key VARCHAR(40) NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  icon VARCHAR(20) NOT NULL DEFAULT '',
  mode_type ENUM('tender','credit') NOT NULL,
  sort_order INT NOT NULL DEFAULT 100,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  is_system TINYINT(1) NOT NULL DEFAULT 1,
  configuration JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (mode_key),
  KEY idx_payment_modes_active_order (is_enabled, sort_order, mode_key),
  CONSTRAINT chk_payment_modes_key CHECK (CHAR_LENGTH(TRIM(mode_key)) > 0),
  CONSTRAINT chk_payment_modes_name CHECK (CHAR_LENGTH(TRIM(display_name)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO payment_modes
  (mode_key, display_name, icon, mode_type, sort_order, is_enabled, is_system)
VALUES
  ('cash', 'Cash', '$', 'tender', 10, 1, 1),
  ('card', 'Card', 'CARD', 'tender', 20, 1, 1),
  ('cheque', 'Cheque', 'CHQ', 'tender', 30, 1, 1),
  ('pending', 'Pending', 'DUE', 'credit', 1000, 1, 1);

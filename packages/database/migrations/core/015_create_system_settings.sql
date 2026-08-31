-- System settings: flat key-value store (OpenCart-style)
-- code = group (e.g. 'workstation', 'billing', 'ui', 'general')
-- key  = specific setting within that group
-- value = plain text or JSON (when serialized = 1)

DROP TABLE IF EXISTS settings;

CREATE TABLE IF NOT EXISTS system_settings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(50) NOT NULL,
  `key` VARCHAR(190) NOT NULL,
  value TEXT NULL,
  serialized TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_system_settings_code_key (code, `key`),
  KEY idx_system_settings_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Remove bill_config and default_printer from workstations
-- (those values now live in system_settings with code='workstation')
ALTER TABLE pos_workstations DROP COLUMN bill_config;
ALTER TABLE pos_workstations DROP COLUMN default_printer;

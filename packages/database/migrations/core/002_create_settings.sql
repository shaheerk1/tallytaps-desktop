CREATE TABLE IF NOT EXISTS settings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope VARCHAR(50) NOT NULL,
  scope_id VARCHAR(100) NULL,
  setting_key VARCHAR(190) NOT NULL,
  setting_value JSON NULL,
  data_type VARCHAR(30) NOT NULL DEFAULT 'json',
  is_encrypted TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_settings_scope_key (scope, scope_id, setting_key),
  KEY idx_settings_key (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

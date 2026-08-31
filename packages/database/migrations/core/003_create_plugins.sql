CREATE TABLE IF NOT EXISTS plugins (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  plugin_id VARCHAR(100) NOT NULL,
  name VARCHAR(190) NOT NULL,
  version VARCHAR(50) NOT NULL,
  status ENUM('installed', 'enabled', 'disabled', 'failed') NOT NULL DEFAULT 'installed',
  manifest JSON NOT NULL,
  installed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  enabled_at TIMESTAMP NULL,
  disabled_at TIMESTAMP NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_plugins_plugin_id (plugin_id),
  KEY idx_plugins_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

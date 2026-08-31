CREATE TABLE IF NOT EXISTS plugin_lifecycle_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  plugin_id VARCHAR(100) NOT NULL,
  action VARCHAR(50) NOT NULL,
  from_status ENUM('installed', 'enabled', 'disabled', 'failed') NULL,
  to_status ENUM('installed', 'enabled', 'disabled', 'failed') NOT NULL,
  changed_by VARCHAR(100) NOT NULL DEFAULT 'system',
  note VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_plugin_lifecycle_plugin (plugin_id),
  CONSTRAINT fk_plugin_lifecycle_plugin
    FOREIGN KEY (plugin_id) REFERENCES plugins(plugin_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

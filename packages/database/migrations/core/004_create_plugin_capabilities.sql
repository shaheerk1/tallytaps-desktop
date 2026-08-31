CREATE TABLE IF NOT EXISTS plugin_capabilities (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  plugin_id VARCHAR(100) NOT NULL,
  capability VARCHAR(150) NOT NULL,
  granted TINYINT(1) NOT NULL DEFAULT 0,
  granted_by VARCHAR(100) NULL,
  granted_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_plugin_capability (plugin_id, capability),
  KEY idx_plugin_capabilities_plugin_id (plugin_id),
  CONSTRAINT fk_plugin_capabilities_plugin
    FOREIGN KEY (plugin_id) REFERENCES plugins(plugin_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

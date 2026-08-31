CREATE TABLE IF NOT EXISTS plugin_migrations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  plugin_id VARCHAR(100) NOT NULL,
  migration_name VARCHAR(190) NOT NULL,
  batch INT NOT NULL,
  executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_plugin_migration (plugin_id, migration_name),
  KEY idx_plugin_migrations_plugin_id (plugin_id),
  CONSTRAINT fk_plugin_migrations_plugin
    FOREIGN KEY (plugin_id) REFERENCES plugins(plugin_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

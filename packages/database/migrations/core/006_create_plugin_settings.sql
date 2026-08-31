CREATE TABLE IF NOT EXISTS plugin_settings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  plugin_id VARCHAR(100) NOT NULL,
  setting_key VARCHAR(190) NOT NULL,
  setting_value JSON NULL,
  data_type VARCHAR(30) NOT NULL DEFAULT 'json',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_plugin_settings_key (plugin_id, setting_key),
  CONSTRAINT fk_plugin_settings_plugin
    FOREIGN KEY (plugin_id) REFERENCES plugins(plugin_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

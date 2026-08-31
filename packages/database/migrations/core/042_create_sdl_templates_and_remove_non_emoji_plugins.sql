CREATE TABLE IF NOT EXISTS sdl_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_key VARCHAR(120) NOT NULL DEFAULT 'default',
  store_code VARCHAR(50) NOT NULL DEFAULT '',
  name VARCHAR(150) NOT NULL,
  source_json JSON NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sdl_templates_scope_name (tenant_key, store_code, name),
  CONSTRAINT fk_sdl_templates_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELETE FROM plugin_lifecycle_log WHERE plugin_id <> 'emoji';
DELETE FROM plugins WHERE plugin_id <> 'emoji';

-- Core-owned read model for SDL fields that opt into indexed attributes.
-- Tenant SDL selects values to project; it never supplies table or SQL names.
CREATE TABLE IF NOT EXISTS sdl_attribute_values (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_key VARCHAR(120) NOT NULL DEFAULT 'default',
  store_code VARCHAR(50) NOT NULL DEFAULT '',
  config_revision_id BIGINT UNSIGNED NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id BIGINT UNSIGNED NOT NULL,
  attribute_key VARCHAR(120) NOT NULL,
  value_text VARCHAR(500) NULL,
  value_number DECIMAL(18,4) NULL,
  value_boolean TINYINT(1) NULL,
  value_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sdl_attribute_value (config_revision_id, entity_type, entity_id, attribute_key),
  KEY idx_sdl_attribute_lookup (tenant_key, store_code, entity_type, attribute_key),
  KEY idx_sdl_attribute_number (tenant_key, store_code, attribute_key, value_number),
  -- Prefix indexing keeps this utf8mb4 composite key below MySQL's 3072-byte limit.
  KEY idx_sdl_attribute_text (tenant_key, store_code, attribute_key, value_text(120)),
  CONSTRAINT fk_sdl_attribute_revision FOREIGN KEY (config_revision_id) REFERENCES config_revisions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Records exactly how each published SDL storage plan was handled by core.
CREATE TABLE IF NOT EXISTS sdl_storage_applications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  config_revision_id BIGINT UNSIGNED NOT NULL,
  status ENUM('applied', 'blocked', 'pending_review') NOT NULL,
  plan_json JSON NOT NULL,
  details_json JSON NOT NULL,
  error_message TEXT NULL,
  applied_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sdl_storage_application_revision (config_revision_id),
  KEY idx_sdl_storage_application_status (status, updated_at),
  CONSTRAINT fk_sdl_storage_application_revision FOREIGN KEY (config_revision_id) REFERENCES config_revisions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

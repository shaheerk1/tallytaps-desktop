-- Authoritative editable SDL source, scoped to a tenant/store. Immutable
-- compiled revisions remain in config_revisions; this is the working document.
CREATE TABLE IF NOT EXISTS sdl_documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_key VARCHAR(120) NOT NULL DEFAULT 'default',
  store_code VARCHAR(50) NOT NULL DEFAULT '',
  source_version INT UNSIGNED NOT NULL DEFAULT 1,
  source_checksum CHAR(64) NOT NULL,
  source_json JSON NOT NULL,
  imported_from VARCHAR(120) NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sdl_documents_scope (tenant_key, store_code),
  KEY idx_sdl_documents_updated (tenant_key, store_code, updated_at),
  CONSTRAINT fk_sdl_documents_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

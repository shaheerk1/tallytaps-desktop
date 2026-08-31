-- Immutable, tenant-scoped configuration revisions. SDL is compiled into one
-- of these records before it is allowed to affect a POS transaction.

CREATE TABLE IF NOT EXISTS config_revisions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_key VARCHAR(120) NOT NULL DEFAULT 'default',
  store_code VARCHAR(50) NOT NULL DEFAULT '',
  revision_no INT UNSIGNED NOT NULL,
  status ENUM('published', 'retired') NOT NULL DEFAULT 'published',
  checksum CHAR(64) NOT NULL,
  source_json JSON NOT NULL,
  compiled_json JSON NOT NULL,
  validation_json JSON NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  published_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retired_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_config_revisions_scope_revision (tenant_key, store_code, revision_no),
  KEY idx_config_revisions_active (tenant_key, store_code, status, published_at),
  KEY idx_config_revisions_checksum (tenant_key, store_code, checksum),
  CONSTRAINT fk_config_revisions_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE invoices
  ADD COLUMN config_revision_id BIGINT UNSIGNED NULL AFTER cash_shift_id,
  ADD KEY idx_invoices_config_revision (config_revision_id),
  ADD CONSTRAINT fk_invoices_config_revision FOREIGN KEY (config_revision_id) REFERENCES config_revisions(id) ON DELETE SET NULL;

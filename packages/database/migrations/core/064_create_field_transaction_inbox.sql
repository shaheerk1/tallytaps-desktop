CREATE TABLE IF NOT EXISTS field_inbox_configuration (
  id TINYINT UNSIGNED NOT NULL,
  host_id VARCHAR(120) NOT NULL,
  api_key_ciphertext TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS field_inbox_resolution (
  host_id VARCHAR(120) NOT NULL,
  record_id VARCHAR(120) NOT NULL,
  client_record_id VARCHAR(180) NULL,
  resolved_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_by BIGINT UNSIGNED NULL,
  PRIMARY KEY (host_id, record_id),
  KEY idx_field_inbox_resolution_client (host_id, client_record_id),
  KEY idx_field_inbox_resolution_user (resolved_by),
  CONSTRAINT fk_field_inbox_resolution_user
    FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('field-inbox.view', 'Field Transaction Inbox View'),
  ('field-inbox.resolve', 'Field Transaction Inbox Resolve');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.permission_key IN ('field-inbox.view', 'field-inbox.resolve')
WHERE r.role_key = 'admin';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source
  ON source.id = rp.permission_id
 AND source.permission_key = 'reports.view'
JOIN permissions target
  ON target.permission_key = 'field-inbox.view';

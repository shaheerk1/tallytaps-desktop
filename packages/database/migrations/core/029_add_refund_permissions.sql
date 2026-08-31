INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('refund.view', 'Refund View'),
  ('refund.create', 'Refund Create'),
  ('refund.approve', 'Refund Approve'),
  ('refund.void', 'Refund Void'),
  ('refund.report.view', 'Refund Report View');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.permission_key IN (
  'refund.view', 'refund.create', 'refund.approve', 'refund.void', 'refund.report.view'
)
WHERE r.role_key = 'admin';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.permission_key IN ('refund.view', 'refund.create')
WHERE r.role_key = 'cashier';

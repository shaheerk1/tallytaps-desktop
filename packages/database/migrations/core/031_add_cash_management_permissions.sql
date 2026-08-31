INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('cash.shift.view', 'Cash Shift View'),
  ('cash.shift.open', 'Cash Shift Open'),
  ('cash.movement.create', 'Cash Movement Create'),
  ('cash.count.create', 'Cash Count Create'),
  ('cash.shift.blindClose', 'Cash Shift Blind Close'),
  ('cash.shift.close', 'Cash Shift Close'),
  ('cash.report.x', 'Cash X Report'),
  ('cash.report.z', 'Cash Z Report'),
  ('cash.variance.approve', 'Cash Variance Approve');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key LIKE 'cash.%'
WHERE r.role_key = 'admin';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key IN (
  'cash.shift.view', 'cash.shift.open', 'cash.movement.create', 'cash.count.create', 'cash.shift.blindClose', 'cash.report.x'
)
WHERE r.role_key = 'cashier';

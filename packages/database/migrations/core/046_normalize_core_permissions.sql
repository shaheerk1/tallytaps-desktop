-- The core permission catalog replaces retired plugin, form, and unimplemented-action rows.
-- Existing roles retain equivalent access through the grants below.
INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('billing.view', 'Billing View'),
  ('billing.create', 'Billing Create'),
  ('refund.view', 'Refund View'),
  ('refund.create', 'Refund Create'),
  ('cash.shift.view', 'Cash Shift View'),
  ('cash.shift.open', 'Cash Shift Open'),
  ('cash.movement.create', 'Cash Movement Create'),
  ('cash.count.create', 'Cash Count Create'),
  ('cash.shift.blindClose', 'Cash Shift Blind Close'),
  ('cash.shift.close', 'Cash Shift Close'),
  ('products.manage', 'Products Manage'),
  ('customers.view', 'Customers View'),
  ('customers.manage', 'Customers Manage'),
  ('receivables.view', 'Receivables View'),
  ('receivables.collect', 'Receivables Collect'),
  ('reports.view', 'Reports View'),
  ('settings.manage', 'Settings Manage'),
  ('users.manage', 'Users Manage'),
  ('plugins.manage', 'Plugins Manage');

-- Preserve the current operational access model while moving it to explicit domains.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id AND source.permission_key = 'billing.view'
JOIN permissions target ON target.permission_key IN ('customers.view', 'receivables.view');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id AND source.permission_key = 'billing.create'
JOIN permissions target ON target.permission_key = 'receivables.collect';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id AND source.permission_key = 'products.manage'
JOIN permissions target ON target.permission_key = 'customers.manage';

-- Administrators always retain every supported core permission.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.permission_key IN (
  'billing.view', 'billing.create', 'refund.view', 'refund.create',
  'cash.shift.view', 'cash.shift.open', 'cash.movement.create', 'cash.count.create',
  'cash.shift.blindClose', 'cash.shift.close', 'products.manage',
  'customers.view', 'customers.manage', 'receivables.view', 'receivables.collect',
  'reports.view', 'settings.manage', 'users.manage', 'plugins.manage'
)
WHERE r.role_key = 'admin';

DELETE rp
FROM role_permissions rp
JOIN permissions p ON p.id = rp.permission_id
WHERE p.permission_key IN (
  'billing.cancel', 'refund.approve', 'refund.void', 'refund.report.view',
  'cash.report.x', 'cash.report.z', 'cash.variance.approve',
  'inventory.view', 'inventory.adjust', 'form.access.billing'
)
OR p.permission_key LIKE 'billing-engine.%'
OR p.permission_key LIKE 'custom-fields.%'
OR p.permission_key LIKE 'ddec-plugin.%'
OR p.permission_key LIKE 'hardware.%'
OR p.permission_key LIKE 'hotel.%'
OR p.permission_key LIKE 'pharmacy.%'
OR p.permission_key LIKE 'power-tools.%'
OR p.permission_key LIKE 'produce-market.%'
OR p.permission_key LIKE 'repair.%'
OR p.permission_key LIKE 'restaurant.%'
OR p.permission_key LIKE 'retail.%'
OR p.permission_key LIKE 'salon.%'
OR p.permission_key LIKE 'supermarket-plugin.%';

DELETE FROM permissions
WHERE permission_key IN (
  'billing.cancel', 'refund.approve', 'refund.void', 'refund.report.view',
  'cash.report.x', 'cash.report.z', 'cash.variance.approve',
  'inventory.view', 'inventory.adjust', 'form.access.billing'
)
OR permission_key LIKE 'billing-engine.%'
OR permission_key LIKE 'custom-fields.%'
OR permission_key LIKE 'ddec-plugin.%'
OR permission_key LIKE 'hardware.%'
OR permission_key LIKE 'hotel.%'
OR permission_key LIKE 'pharmacy.%'
OR permission_key LIKE 'power-tools.%'
OR permission_key LIKE 'produce-market.%'
OR permission_key LIKE 'repair.%'
OR permission_key LIKE 'restaurant.%'
OR permission_key LIKE 'retail.%'
OR permission_key LIKE 'salon.%'
OR permission_key LIKE 'supermarket-plugin.%';

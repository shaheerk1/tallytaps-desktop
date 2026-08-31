-- Ensure billing permissions exist and are assigned to the cashier role
-- This is a safe, idempotent migration that runs via db:migrate

INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('billing.view', 'Billing View'),
  ('billing.create', 'Billing Create'),
  ('billing.cancel', 'Billing Cancel');

-- Find or create the cashier role
SET @cashierRoleId = (SELECT id FROM roles WHERE role_key = 'cashier');

-- If cashier role doesn't exist yet, create it
INSERT IGNORE INTO roles (role_key, name) VALUES ('cashier', 'Cashier');
SET @cashierRoleId = (SELECT id FROM roles WHERE role_key = 'cashier');

-- Grant billing permissions to cashier
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT @cashierRoleId, id FROM permissions
WHERE permission_key IN ('billing.view', 'billing.create');

-- Grant form.access.billing to cashier for sidebar visibility
INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('form.access.billing', 'Form Access Billing');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT @cashierRoleId, id FROM permissions
WHERE permission_key = 'form.access.billing';

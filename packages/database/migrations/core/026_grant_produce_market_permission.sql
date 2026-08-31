-- Ensure the produce-market.view permission exists and is granted to the admin role.
-- The Produce Market plugin declares this permission on its menu/route contributions,
-- so admin must hold it for the sidebar entry to appear when the plugin is enabled.
-- This is safe and idempotent.

INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('produce-market.view', 'Produce Market View');

-- Find or create the admin role
INSERT IGNORE INTO roles (role_key, name) VALUES ('admin', 'Administrator');
SET @adminRoleId = (SELECT id FROM roles WHERE role_key = 'admin');

-- Grant to admin
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT @adminRoleId, id FROM permissions
WHERE permission_key = 'produce-market.view';

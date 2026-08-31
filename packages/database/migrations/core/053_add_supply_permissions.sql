INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('suppliers.view','Suppliers View'), ('suppliers.manage','Suppliers Manage'),
  ('receiving.view','Receiving View'), ('receiving.manage','Receiving Manage'),
  ('inventory.adjust','Inventory Adjust'),
  ('supplier-settlements.view','Supplier Settlements View'), ('supplier-settlements.manage','Supplier Settlements Manage'),
  ('reports.export','Reports Export');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id FROM role_permissions rp JOIN permissions p1 ON p1.id = rp.permission_id AND p1.permission_key = 'products.manage'
JOIN permissions p2 ON p2.permission_key IN ('suppliers.view','suppliers.manage','receiving.view','receiving.manage','inventory.adjust','supplier-settlements.view','supplier-settlements.manage');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id FROM role_permissions rp JOIN permissions p1 ON p1.id = rp.permission_id AND p1.permission_key = 'reports.view'
JOIN permissions p2 ON p2.permission_key = 'reports.export';

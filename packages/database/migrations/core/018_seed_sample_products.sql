-- Seed sample products for testing billing (generic POS items)
-- Safe to run multiple times (INSERT IGNORE on unique SKU)

INSERT IGNORE INTO products (sku, name, category, unit_price, stock_qty, metadata)
VALUES
  ('ITEM001', 'Product A - Standard',  'general',    25.00,  100, '{}'),
  ('ITEM002', 'Product B - Premium',   'general',    50.00,  75,  '{}'),
  ('ITEM003', 'Product C - Economy',   'general',    10.00,  200, '{}'),
  ('ITEM004', 'Service X - Basic',     'service',    15.00,  999, '{}'),
  ('ITEM005', 'Service Y - Pro',       'service',    40.00,  999, '{}'),
  ('ITEM006', 'Bundle Pack - Small',   'bundle',     75.00,  50,  '{}'),
  ('ITEM007', 'Bundle Pack - Large',   'bundle',    150.00,  30,  '{}'),
  ('ITEM008', 'Consumable D',          'consumable',  5.00,  500, '{}'),
  ('ITEM009', 'Consumable E',          'consumable',  8.50,  350, '{}'),
  ('ITEM010', 'Special Item F',        'special',    99.99,  20,  '{}');

-- Keep automated receivable collections distinct from ordinary sale cash so
-- shift reports and audits can identify why money entered the drawer.
ALTER TABLE cash_movements
  MODIFY COLUMN movement_type ENUM(
    'opening_float',
    'sale_cash',
    'receivable_collection_cash',
    'change_given',
    'refund_cash',
    'cash_in',
    'cash_out',
    'safe_drop',
    'bank_drop',
    'correction'
  ) NOT NULL;

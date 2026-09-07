-- Expense allocation and landed cost.
--
-- This is what finally makes `supplier_charge_types.treatment = 'landed_cost'`
-- mean something: a cost can now be attached to the goods it belongs to, so a
-- lot knows what it really cost and a per-lot margin becomes computable.
--
-- Truth lives in `expense_allocations`, which is append-only and signed. Moving
-- a cost from one lot to another never edits an existing row; it writes a
-- negative row on the lot that gives the cost up and a positive row on the lot
-- that takes it, so both lots keep a complete history and the sums stay honest.
--
-- The three new columns on `inventory_lots` are projections, exactly like
-- `products.stock_qty`. They are rebuildable at any time from the allocation
-- ledger plus the purchase debits already recorded in supplier_payable_entries.

INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('expenses.allocate', 'Expenses Allocate To Goods'),
  ('lot-costing.view', 'Lot Costing View');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id AND source.permission_key = 'receiving.manage'
JOIN permissions target ON target.permission_key = 'expenses.allocate';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id AND source.permission_key = 'receiving.view'
JOIN permissions target ON target.permission_key = 'lot-costing.view';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.permission_key IN ('expenses.allocate','lot-costing.view')
WHERE r.role_key = 'admin';

-- `allocation_target` and `allocated_total` are projections of the allocation
-- ledger below, so a late cost can be attached without rewriting the expense.
ALTER TABLE expense_entries
  ADD COLUMN allocation_target ENUM('none','lot','goods_receipt') NOT NULL DEFAULT 'none' AFTER reason,
  ADD COLUMN goods_receipt_id BIGINT UNSIGNED NULL AFTER allocation_target,
  ADD COLUMN allocated_total DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER goods_receipt_id,
  ADD KEY idx_expense_entries_grn (goods_receipt_id, id),
  ADD CONSTRAINT fk_expense_entries_grn FOREIGN KEY (goods_receipt_id) REFERENCES goods_receipts(id) ON DELETE RESTRICT;

CREATE TABLE expense_allocations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  expense_entry_id BIGINT UNSIGNED NOT NULL,
  inventory_lot_id BIGINT UNSIGNED NOT NULL,
  business_day_id BIGINT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  document_type ENUM('expense','reallocation') NOT NULL DEFAULT 'expense',
  document_no INT UNSIGNED NOT NULL,
  entry_no INT UNSIGNED NOT NULL,
  -- How the share was worked out. `direct` is the whole cost on one lot.
  basis ENUM('direct','base_quantity','handling_quantity','sale_value','equal') NOT NULL DEFAULT 'direct',
  basis_value DECIMAL(14,3) NULL,
  -- Signed: a reallocation writes a negative row on the lot giving the cost up.
  amount DECIMAL(14,2) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_expense_allocations_origin (loc_code, mac_code, txn_date, document_type, document_no, entry_no),
  KEY idx_expense_allocations_lot (inventory_lot_id, id),
  KEY idx_expense_allocations_expense (expense_entry_id, id),
  CONSTRAINT fk_expense_allocations_expense FOREIGN KEY (expense_entry_id) REFERENCES expense_entries(id) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_allocations_lot FOREIGN KEY (inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_allocations_day FOREIGN KEY (business_day_id, loc_code, txn_date) REFERENCES business_days(id, loc_code, business_date) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_allocations_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_expense_allocations_amount CHECK (amount <> 0),
  CONSTRAINT chk_expense_allocations_reason CHECK (CHAR_LENGTH(TRIM(reason)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE expense_reallocations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  expense_entry_id BIGINT UNSIGNED NOT NULL,
  from_inventory_lot_id BIGINT UNSIGNED NOT NULL,
  to_inventory_lot_id BIGINT UNSIGNED NOT NULL,
  business_day_id BIGINT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  reallocation_no INT UNSIGNED NOT NULL,
  reallocation_number VARCHAR(190) NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  from_allocation_id BIGINT UNSIGNED NULL,
  to_allocation_id BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_expense_reallocations_origin (loc_code, mac_code, txn_date, reallocation_no),
  UNIQUE KEY uq_expense_reallocations_number (reallocation_number),
  KEY idx_expense_reallocations_expense (expense_entry_id, id),
  CONSTRAINT fk_expense_reallocations_expense FOREIGN KEY (expense_entry_id) REFERENCES expense_entries(id) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_reallocations_from FOREIGN KEY (from_inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_reallocations_to FOREIGN KEY (to_inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_reallocations_day FOREIGN KEY (business_day_id, loc_code, txn_date) REFERENCES business_days(id, loc_code, business_date) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_reallocations_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_expense_reallocations_amount CHECK (amount > 0),
  CONSTRAINT chk_expense_reallocations_distinct CHECK (from_inventory_lot_id <> to_inventory_lot_id),
  CONSTRAINT chk_expense_reallocations_reason CHECK (CHAR_LENGTH(TRIM(reason)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Landed cost projections. Rebuildable from supplier_payable_entries
-- (purchase debits) and expense_allocations at any time.
ALTER TABLE inventory_lots
  ADD COLUMN purchase_cost_total DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER terms_snapshot,
  ADD COLUMN allocated_cost_total DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER purchase_cost_total,
  ADD COLUMN landed_cost_total DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER allocated_cost_total;

-- Backfill the purchase side from the debits the GRN already wrote. Consignment
-- lots stay at zero: the shop never bought those goods.
UPDATE inventory_lots l
LEFT JOIN (
  SELECT inventory_lot_id, COALESCE(SUM(amount), 0) AS purchase_total
  FROM supplier_payable_entries
  WHERE entry_type = 'purchase_debit' AND inventory_lot_id IS NOT NULL
  GROUP BY inventory_lot_id
) p ON p.inventory_lot_id = l.id
SET l.purchase_cost_total = COALESCE(p.purchase_total, 0),
    l.landed_cost_total = COALESCE(p.purchase_total, 0);

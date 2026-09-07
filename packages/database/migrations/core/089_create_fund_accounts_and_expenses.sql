-- Fund accounts and expenses: the first half of the accounting spine.
--
-- Until now money could only exist inside a POS drawer, because cash_movements
-- requires a cash_shift. A fund account is simply a named place money sits --
-- the till, the safe, a bank account, or a stakeholder's own pocket -- so that
-- safe_drop and bank_drop finally have a destination and a business cost can be
-- recorded no matter which pocket paid it.
--
-- Balance ownership is deliberately split so no amount is ever counted twice:
--   * a `pos_drawer` fund is a view over the existing cash_movements ledger;
--   * every other fund kind keeps its own fund_movements ledger.
-- An expense therefore writes EITHER a cash movement (drawer) OR a fund
-- movement (safe/bank/stakeholder), never both.

INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('funds.view', 'Funds View'),
  ('funds.manage', 'Funds Manage'),
  ('funds.transfer', 'Funds Transfer'),
  ('expenses.view', 'Expenses View'),
  ('expenses.create', 'Expenses Create');

-- A cashier who may already move cash in and out of the drawer keeps exactly
-- that power, now recorded as a categorised expense instead of a bare cash_out.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id AND source.permission_key = 'cash.movement.create'
JOIN permissions target ON target.permission_key IN ('expenses.view', 'expenses.create');

-- Fund setup, transfers, and the full expense register are management work.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id AND source.permission_key = 'settings.manage'
JOIN permissions target ON target.permission_key IN ('funds.view', 'funds.manage', 'funds.transfer');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.permission_key IN ('funds.view','funds.manage','funds.transfer','expenses.view','expenses.create')
WHERE r.role_key = 'admin';

CREATE TABLE fund_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  fund_code VARCHAR(60) NOT NULL,
  name VARCHAR(150) NOT NULL,
  fund_kind ENUM('pos_drawer','cash_safe','bank','stakeholder') NOT NULL,
  cash_drawer_id BIGINT UNSIGNED NULL,
  loc_code VARCHAR(50) NOT NULL,
  currency_code CHAR(3) NOT NULL DEFAULT 'LKR',
  opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
  holder_name VARCHAR(190) NULL,
  account_reference VARCHAR(190) NULL,
  notes TEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 100,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_fund_accounts_code (fund_code),
  UNIQUE KEY uq_fund_accounts_drawer (cash_drawer_id),
  KEY idx_fund_accounts_location (loc_code, is_active, sort_order, id),
  CONSTRAINT fk_fund_accounts_drawer FOREIGN KEY (cash_drawer_id) REFERENCES cash_drawers(id) ON DELETE RESTRICT,
  CONSTRAINT chk_fund_accounts_code CHECK (CHAR_LENGTH(TRIM(fund_code)) > 0),
  CONSTRAINT chk_fund_accounts_name CHECK (CHAR_LENGTH(TRIM(name)) > 0),
  CONSTRAINT chk_fund_accounts_location CHECK (CHAR_LENGTH(TRIM(loc_code)) > 0),
  -- A drawer fund mirrors a real drawer; every other kind must not claim one.
  CONSTRAINT chk_fund_accounts_drawer_link CHECK (
    (fund_kind = 'pos_drawer' AND cash_drawer_id IS NOT NULL)
    OR (fund_kind <> 'pos_drawer' AND cash_drawer_id IS NULL)
  ),
  -- A drawer's float is opened per shift, so it never carries its own opening.
  CONSTRAINT chk_fund_accounts_opening CHECK (fund_kind <> 'pos_drawer' OR opening_balance = 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fund_movements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  fund_account_id BIGINT UNSIGNED NOT NULL,
  business_day_id BIGINT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  document_type VARCHAR(40) NOT NULL,
  document_no INT UNSIGNED NOT NULL,
  entry_no INT UNSIGNED NOT NULL,
  direction ENUM('in','out') NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  source_type VARCHAR(60) NULL,
  source_id VARCHAR(120) NULL,
  reason VARCHAR(255) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_fund_movements_origin (loc_code, mac_code, txn_date, document_type, document_no, entry_no),
  KEY idx_fund_movements_balance (fund_account_id, txn_date, id),
  CONSTRAINT fk_fund_movements_account FOREIGN KEY (fund_account_id) REFERENCES fund_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_fund_movements_day FOREIGN KEY (business_day_id, loc_code, txn_date) REFERENCES business_days(id, loc_code, business_date) ON DELETE RESTRICT,
  CONSTRAINT fk_fund_movements_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_fund_movements_amount CHECK (amount > 0),
  CONSTRAINT chk_fund_movements_reason CHECK (CHAR_LENGTH(TRIM(reason)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE expense_categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  category_code VARCHAR(80) NOT NULL,
  name VARCHAR(150) NOT NULL,
  -- `lot_cost` categories are the ones Phase 2 will allow to raise a lot's
  -- landed cost. Until then every category behaves as a period expense, and the
  -- treatment is recorded so no category has to be re-classified later.
  default_treatment ENUM('lot_cost','overhead','supplier_deduction') NOT NULL DEFAULT 'overhead',
  help_text VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 100,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_expense_categories_code (category_code),
  KEY idx_expense_categories_active (is_active, sort_order, id),
  CONSTRAINT chk_expense_categories_code CHECK (CHAR_LENGTH(TRIM(category_code)) > 0),
  CONSTRAINT chk_expense_categories_name CHECK (CHAR_LENGTH(TRIM(name)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE expense_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_day_id BIGINT UNSIGNED NOT NULL,
  expense_category_id BIGINT UNSIGNED NOT NULL,
  fund_account_id BIGINT UNSIGNED NOT NULL,
  cash_shift_id BIGINT UNSIGNED NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  expense_no INT UNSIGNED NOT NULL,
  expense_number VARCHAR(190) NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  payee VARCHAR(190) NULL,
  reference VARCHAR(190) NULL,
  reason VARCHAR(255) NOT NULL,
  status ENUM('recorded','void') NOT NULL DEFAULT 'recorded',
  -- Exactly one of these is set: a drawer expense lands in the shift ledger, and
  -- every other fund keeps its own movement. This is what stops double counting.
  cash_movement_id BIGINT UNSIGNED NULL,
  fund_movement_id BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_expense_entries_origin (loc_code, mac_code, txn_date, expense_no),
  UNIQUE KEY uq_expense_entries_number (expense_number),
  KEY idx_expense_entries_register (loc_code, txn_date, id),
  KEY idx_expense_entries_category (expense_category_id, txn_date, id),
  KEY idx_expense_entries_fund (fund_account_id, txn_date, id),
  CONSTRAINT fk_expense_entries_day FOREIGN KEY (business_day_id, loc_code, txn_date) REFERENCES business_days(id, loc_code, business_date) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_entries_category FOREIGN KEY (expense_category_id) REFERENCES expense_categories(id) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_entries_fund FOREIGN KEY (fund_account_id) REFERENCES fund_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_entries_shift FOREIGN KEY (cash_shift_id) REFERENCES cash_shifts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_entries_cash_movement FOREIGN KEY (cash_movement_id) REFERENCES cash_movements(id) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_entries_fund_movement FOREIGN KEY (fund_movement_id) REFERENCES fund_movements(id) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_entries_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_expense_entries_amount CHECK (amount > 0),
  CONSTRAINT chk_expense_entries_reason CHECK (CHAR_LENGTH(TRIM(reason)) > 0),
  CONSTRAINT chk_expense_entries_single_ledger CHECK (
    (cash_movement_id IS NOT NULL AND fund_movement_id IS NULL)
    OR (cash_movement_id IS NULL AND fund_movement_id IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fund_transfers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_day_id BIGINT UNSIGNED NOT NULL,
  from_fund_account_id BIGINT UNSIGNED NOT NULL,
  to_fund_account_id BIGINT UNSIGNED NOT NULL,
  cash_shift_id BIGINT UNSIGNED NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  transfer_no INT UNSIGNED NOT NULL,
  transfer_number VARCHAR(190) NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  from_cash_movement_id BIGINT UNSIGNED NULL,
  from_fund_movement_id BIGINT UNSIGNED NULL,
  to_cash_movement_id BIGINT UNSIGNED NULL,
  to_fund_movement_id BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_fund_transfers_origin (loc_code, mac_code, txn_date, transfer_no),
  UNIQUE KEY uq_fund_transfers_number (transfer_number),
  KEY idx_fund_transfers_from (from_fund_account_id, txn_date, id),
  KEY idx_fund_transfers_to (to_fund_account_id, txn_date, id),
  CONSTRAINT fk_fund_transfers_day FOREIGN KEY (business_day_id, loc_code, txn_date) REFERENCES business_days(id, loc_code, business_date) ON DELETE RESTRICT,
  CONSTRAINT fk_fund_transfers_from FOREIGN KEY (from_fund_account_id) REFERENCES fund_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_fund_transfers_to FOREIGN KEY (to_fund_account_id) REFERENCES fund_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_fund_transfers_shift FOREIGN KEY (cash_shift_id) REFERENCES cash_shifts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_fund_transfers_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_fund_transfers_amount CHECK (amount > 0),
  CONSTRAINT chk_fund_transfers_distinct CHECK (from_fund_account_id <> to_fund_account_id),
  CONSTRAINT chk_fund_transfers_reason CHECK (CHAR_LENGTH(TRIM(reason)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A drawer expense is a real cash payout and must reconcile in the shift, so it
-- gets its own movement type rather than hiding inside a generic cash_out.
ALTER TABLE cash_movements
  MODIFY COLUMN movement_type ENUM(
    'opening_float','sale_cash','receivable_collection_cash','supplier_settlement_cash',
    'customer_advance_cash','customer_advance_refund_cash','expense_cash','fund_transfer_in','fund_transfer_out',
    'change_given','refund_cash','cash_in','cash_out','safe_drop','bank_drop','correction'
  ) NOT NULL;

-- Seed the categories a DDEC shop actually uses on day one. The help text is
-- shown next to the category in the expense form, because "does this cost belong
-- to the goods or to the month" is the one decision a new owner gets wrong.
INSERT INTO expense_categories (category_code, name, default_treatment, help_text, sort_order) VALUES
  ('lorry_wage',   'Lorry wage',       'lot_cost', 'Paid to bring a delivery in. Belongs to the goods it carried.', 10),
  ('unloading',    'Unloading',        'lot_cost', 'Paid to unload a delivery. Belongs to the goods it unloaded.', 20),
  ('repacking',    'Repacking',        'lot_cost', 'Re-bagging or sorting received goods. Belongs to those goods.', 30),
  ('transport',    'Transport',        'lot_cost', 'Moving goods after receiving. Belongs to the goods moved.', 40),
  ('market_levy',  'Market levy',      'lot_cost', 'Market charge on a delivery. Belongs to that delivery.', 50),
  ('packaging',    'Packaging',        'lot_cost', 'Bags, crates and wrapping used for received goods.', 60),
  ('shop_rent',    'Shop rent',        'overhead', 'A cost of the month, not of any one delivery.', 110),
  ('wages',        'Staff wages',      'overhead', 'A cost of the month, not of any one delivery.', 120),
  ('electricity',  'Electricity',      'overhead', 'A cost of the month, not of any one delivery.', 130),
  ('water',        'Water',            'overhead', 'A cost of the month, not of any one delivery.', 140),
  ('telephone',    'Telephone and internet', 'overhead', 'A cost of the month, not of any one delivery.', 150),
  ('repairs',      'Repairs and maintenance', 'overhead', 'Keeping the shop and equipment working.', 160),
  ('fuel',         'Fuel',             'overhead', 'Vehicle fuel that is not tied to one delivery.', 170),
  ('bank_charges', 'Bank charges',     'overhead', 'Fees taken by the bank.', 180),
  ('office',       'Office and stationery', 'overhead', 'Printing, books, and small office items.', 190),
  ('other',        'Other expense',    'overhead', 'Use only when nothing else fits, and write a clear reason.', 900);

-- Every existing drawer becomes a fund so the register is complete from the
-- first launch; nothing about drawer behavior changes.
INSERT INTO fund_accounts (fund_code, name, fund_kind, cash_drawer_id, loc_code, currency_code, is_active, sort_order)
SELECT
  CONCAT('DRAWER-', w.location_code, '-', w.machine_code),
  CONCAT(d.name, ' (', w.machine_code, ')'),
  'pos_drawer', d.id, w.location_code, d.currency_code,
  IF(d.status = 'active', 1, 0), 10
FROM cash_drawers d
JOIN pos_workstations w ON w.id = d.workstation_id;

-- One cash safe per location, so safe_drop has somewhere real to land.
INSERT INTO fund_accounts (fund_code, name, fund_kind, loc_code, is_active, sort_order, notes)
SELECT DISTINCT
  CONCAT('SAFE-', w.location_code), 'Cash safe', 'cash_safe', w.location_code, 1, 20,
  'Back-office cash held outside the till.'
FROM pos_workstations w;

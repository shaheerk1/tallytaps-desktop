-- Stakeholders and the equity ledger.
--
-- Answers "whose money is in this business, and what can each person take out".
-- The ledger is append-only and signed from the stakeholder's point of view:
-- a positive amount increases what the business owes them, a negative amount
-- decreases it. Their claim is simply the sum of their entries.
--
-- A partner paying a business cost from their own pocket is one event with two
-- effects -- the cost belongs to the business and the partner's claim rises --
-- so the expense entry and the `expense_borne` row are written in one
-- transaction or neither is written at all.

INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('stakeholders.view', 'Stakeholders View'),
  ('stakeholders.manage', 'Stakeholders Manage'),
  ('stakeholders.contribute', 'Stakeholders Record Contribution'),
  ('stakeholders.drawing', 'Stakeholders Record Drawing'),
  ('stakeholders.profit-share', 'Stakeholders Allocate Profit Share');

-- Equity is owner-level information; it follows user administration, not the
-- till. A cashier never receives any of it.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id AND source.permission_key = 'users.manage'
JOIN permissions target ON target.permission_key IN (
  'stakeholders.view','stakeholders.manage','stakeholders.contribute',
  'stakeholders.drawing','stakeholders.profit-share'
);

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.permission_key IN (
    'stakeholders.view','stakeholders.manage','stakeholders.contribute',
    'stakeholders.drawing','stakeholders.profit-share'
  )
WHERE r.role_key = 'admin';

CREATE TABLE stakeholders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  stakeholder_code VARCHAR(60) NOT NULL,
  display_name VARCHAR(190) NOT NULL,
  stakeholder_type ENUM('owner','partner','investor') NOT NULL DEFAULT 'partner',
  -- Their own pocket, so an expense paid personally can name the fund it left.
  fund_account_id BIGINT UNSIGNED NULL,
  -- Does money they spend personally become part of their investment, or a debt
  -- the business repays? Different balance-sheet treatment, chosen per person.
  borne_cost_treatment ENUM('capital','liability') NOT NULL DEFAULT 'capital',
  loc_code VARCHAR(50) NOT NULL,
  mobile VARCHAR(60) NULL,
  notes TEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 100,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_stakeholders_code (stakeholder_code),
  UNIQUE KEY uq_stakeholders_fund (fund_account_id),
  KEY idx_stakeholders_location (loc_code, is_active, sort_order, id),
  CONSTRAINT fk_stakeholders_fund FOREIGN KEY (fund_account_id) REFERENCES fund_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT chk_stakeholders_code CHECK (CHAR_LENGTH(TRIM(stakeholder_code)) > 0),
  CONSTRAINT chk_stakeholders_name CHECK (CHAR_LENGTH(TRIM(display_name)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A share can cover the whole business or only one lot, so a partner who funded
-- a single onion delivery is tracked separately from a whole-business partner.
CREATE TABLE stakeholder_shares (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  stakeholder_id BIGINT UNSIGNED NOT NULL,
  scope ENUM('business','lot') NOT NULL DEFAULT 'business',
  inventory_lot_id BIGINT UNSIGNED NULL,
  share_percent DECIMAL(7,4) NOT NULL,
  effective_from DATE NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  notes VARCHAR(255) NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_stakeholder_shares_scope (stakeholder_id, scope, inventory_lot_id, effective_from),
  KEY idx_stakeholder_shares_lot (inventory_lot_id, is_active, id),
  CONSTRAINT fk_stakeholder_shares_stakeholder FOREIGN KEY (stakeholder_id) REFERENCES stakeholders(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stakeholder_shares_lot FOREIGN KEY (inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stakeholder_shares_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_stakeholder_shares_percent CHECK (share_percent > 0 AND share_percent <= 100),
  CONSTRAINT chk_stakeholder_shares_scope CHECK (
    (scope = 'lot' AND inventory_lot_id IS NOT NULL)
    OR (scope = 'business' AND inventory_lot_id IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stakeholder_ledger_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  stakeholder_id BIGINT UNSIGNED NOT NULL,
  business_day_id BIGINT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  txn_date DATE NOT NULL,
  document_type VARCHAR(40) NOT NULL,
  document_no INT UNSIGNED NOT NULL,
  entry_no INT UNSIGNED NOT NULL,
  entry_number VARCHAR(190) NOT NULL,
  entry_type ENUM('capital_contribution','expense_borne','drawing','profit_share_allocation','settlement') NOT NULL,
  -- Signed from the stakeholder's side: + raises their claim, - lowers it.
  amount DECIMAL(14,2) NOT NULL,
  fund_account_id BIGINT UNSIGNED NULL,
  expense_entry_id BIGINT UNSIGNED NULL,
  inventory_lot_id BIGINT UNSIGNED NULL,
  cash_movement_id BIGINT UNSIGNED NULL,
  fund_movement_id BIGINT UNSIGNED NULL,
  reason VARCHAR(255) NOT NULL,
  -- Set only when a drawing was allowed past the available balance.
  override_approved_by BIGINT UNSIGNED NULL,
  override_reason VARCHAR(255) NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_stakeholder_ledger_origin (loc_code, mac_code, txn_date, document_type, document_no, entry_no),
  UNIQUE KEY uq_stakeholder_ledger_number (entry_number),
  KEY idx_stakeholder_ledger_balance (stakeholder_id, txn_date, id),
  KEY idx_stakeholder_ledger_lot (inventory_lot_id, id),
  CONSTRAINT fk_stakeholder_ledger_stakeholder FOREIGN KEY (stakeholder_id) REFERENCES stakeholders(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stakeholder_ledger_day FOREIGN KEY (business_day_id, loc_code, txn_date) REFERENCES business_days(id, loc_code, business_date) ON DELETE RESTRICT,
  CONSTRAINT fk_stakeholder_ledger_fund FOREIGN KEY (fund_account_id) REFERENCES fund_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stakeholder_ledger_expense FOREIGN KEY (expense_entry_id) REFERENCES expense_entries(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stakeholder_ledger_lot FOREIGN KEY (inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stakeholder_ledger_cash_movement FOREIGN KEY (cash_movement_id) REFERENCES cash_movements(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stakeholder_ledger_fund_movement FOREIGN KEY (fund_movement_id) REFERENCES fund_movements(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stakeholder_ledger_override_user FOREIGN KEY (override_approved_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stakeholder_ledger_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_stakeholder_ledger_amount CHECK (amount <> 0),
  CONSTRAINT chk_stakeholder_ledger_reason CHECK (CHAR_LENGTH(TRIM(reason)) > 0),
  -- An override must name who allowed it and why.
  CONSTRAINT chk_stakeholder_ledger_override CHECK (
    (override_approved_by IS NULL AND override_reason IS NULL)
    OR (override_approved_by IS NOT NULL AND CHAR_LENGTH(TRIM(override_reason)) > 0)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE business_days (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  loc_code VARCHAR(50) NOT NULL,
  business_date DATE NOT NULL,
  status ENUM('open', 'closing', 'closed') NOT NULL DEFAULT 'open',
  opened_by BIGINT UNSIGNED NULL,
  opened_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closing_started_by BIGINT UNSIGNED NULL,
  closing_started_at TIMESTAMP NULL,
  closed_by BIGINT UNSIGNED NULL,
  closed_at TIMESTAMP NULL,
  close_reason VARCHAR(255) NULL,
  reopen_count INT UNSIGNED NOT NULL DEFAULT 0,
  summary_snapshot JSON NULL,
  active_marker TINYINT GENERATED ALWAYS AS (
    CASE WHEN status IN ('open', 'closing') THEN 1 ELSE NULL END
  ) STORED,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_business_days_location_date (loc_code, business_date),
  UNIQUE KEY uq_business_days_one_active_location (loc_code, active_marker),
  KEY idx_business_days_status_date (status, business_date),
  CONSTRAINT fk_business_days_opened_by FOREIGN KEY (opened_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_business_days_closing_by FOREIGN KEY (closing_started_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_business_days_closed_by FOREIGN KEY (closed_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_business_days_location CHECK (CHAR_LENGTH(TRIM(loc_code)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE business_day_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_day_id BIGINT UNSIGNED NOT NULL,
  event_no INT UNSIGNED NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  from_status VARCHAR(20) NULL,
  to_status VARCHAR(20) NULL,
  user_id BIGINT UNSIGNED NULL,
  reason VARCHAR(255) NULL,
  details JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_business_day_events_sequence (business_day_id, event_no),
  KEY idx_business_day_events_created (business_day_id, created_at),
  CONSTRAINT fk_business_day_events_day FOREIGN KEY (business_day_id) REFERENCES business_days(id) ON DELETE RESTRICT,
  CONSTRAINT fk_business_day_events_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historical transaction dates become closed business days. Active shifts take
-- precedence when choosing the one operational date for each location, followed
-- by an open workstation session and finally today's date for an unused location.
INSERT IGNORE INTO business_days (loc_code, business_date, status, opened_at, closed_at)
SELECT origin.loc_code, origin.business_date, 'closed', NOW(), NOW()
FROM (
  SELECT loc_code, txn_date AS business_date FROM invoices
  UNION SELECT loc_code, txn_date FROM refund_drafts
  UNION SELECT loc_code, txn_date FROM refunds
  UNION SELECT loc_code, business_date FROM goods_receipts
  UNION SELECT loc_code, business_date FROM cash_shifts
  UNION SELECT loc_code, txn_date FROM supplier_settlements
  UNION SELECT loc_code, txn_date FROM supplier_payments
  UNION SELECT loc_code, business_date FROM inventory_stock_counts
  UNION SELECT loc_code, business_date FROM stock_movements
  UNION SELECT w.location_code, s.billing_date
    FROM workstation_sessions s JOIN pos_workstations w ON w.id = s.workstation_id
) origin
WHERE origin.loc_code IS NOT NULL AND origin.loc_code <> '' AND origin.business_date IS NOT NULL;

CREATE TEMPORARY TABLE selected_active_business_days (
  loc_code VARCHAR(50) NOT NULL PRIMARY KEY,
  business_date DATE NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO selected_active_business_days (loc_code, business_date)
SELECT ranked.loc_code, ranked.business_date
FROM (
  SELECT candidates.loc_code, candidates.business_date,
         ROW_NUMBER() OVER (
           PARTITION BY candidates.loc_code
           ORDER BY candidates.priority ASC, candidates.activity_at DESC, candidates.business_date DESC
         ) AS row_no
  FROM (
    SELECT s.loc_code, s.business_date, 1 AS priority, s.opened_at AS activity_at
    FROM cash_shifts s
    WHERE s.status IN ('open', 'blind_closed')
    UNION ALL
    SELECT w.location_code, ws.billing_date, 2 AS priority, ws.opened_at AS activity_at
    FROM workstation_sessions ws
    JOIN pos_workstations w ON w.id = ws.workstation_id
    WHERE ws.status = 'open'
    UNION ALL
    SELECT w.location_code, CURDATE(), 3 AS priority, w.created_at AS activity_at
    FROM pos_workstations w
    WHERE w.status = 'active'
  ) candidates
) ranked
WHERE ranked.row_no = 1;

INSERT IGNORE INTO business_days (loc_code, business_date, status)
SELECT loc_code, business_date, 'closed' FROM selected_active_business_days;

UPDATE business_days d
JOIN selected_active_business_days selected
  ON selected.loc_code = d.loc_code AND selected.business_date = d.business_date
SET d.status = 'open', d.closed_at = NULL, d.close_reason = NULL;

-- An open login session is a context, not a separate accounting day. Align it
-- to the location's chosen active day without changing transaction history.
UPDATE workstation_sessions ws
JOIN pos_workstations w ON w.id = ws.workstation_id
JOIN selected_active_business_days selected ON selected.loc_code = w.location_code
SET ws.billing_date = selected.business_date
WHERE ws.status = 'open';

DROP TEMPORARY TABLE selected_active_business_days;

ALTER TABLE cash_shifts ADD COLUMN business_day_id BIGINT UNSIGNED NULL AFTER id;
ALTER TABLE invoices ADD COLUMN business_day_id BIGINT UNSIGNED NULL AFTER id;
ALTER TABLE invoice_items ADD COLUMN business_day_id BIGINT UNSIGNED NULL AFTER id;
ALTER TABLE refund_drafts ADD COLUMN business_day_id BIGINT UNSIGNED NULL AFTER id;
ALTER TABLE refunds ADD COLUMN business_day_id BIGINT UNSIGNED NULL AFTER id;
ALTER TABLE goods_receipts ADD COLUMN business_day_id BIGINT UNSIGNED NULL AFTER id;
ALTER TABLE supplier_settlements ADD COLUMN business_day_id BIGINT UNSIGNED NULL AFTER id;
ALTER TABLE supplier_payments ADD COLUMN business_day_id BIGINT UNSIGNED NULL AFTER id;
ALTER TABLE inventory_stock_counts ADD COLUMN business_day_id BIGINT UNSIGNED NULL AFTER id;

UPDATE cash_shifts t JOIN business_days d ON d.loc_code = t.loc_code AND d.business_date = t.business_date SET t.business_day_id = d.id;
UPDATE invoices t JOIN business_days d ON d.loc_code = t.loc_code AND d.business_date = t.txn_date SET t.business_day_id = d.id;
UPDATE invoice_items t JOIN business_days d ON d.loc_code = t.loc_code AND d.business_date = t.txn_date SET t.business_day_id = d.id;
UPDATE refund_drafts t JOIN business_days d ON d.loc_code = t.loc_code AND d.business_date = t.txn_date SET t.business_day_id = d.id;
UPDATE refunds t JOIN business_days d ON d.loc_code = t.loc_code AND d.business_date = t.txn_date SET t.business_day_id = d.id;
UPDATE goods_receipts t JOIN business_days d ON d.loc_code = t.loc_code AND d.business_date = t.business_date SET t.business_day_id = d.id;
UPDATE supplier_settlements t JOIN business_days d ON d.loc_code = t.loc_code AND d.business_date = t.txn_date SET t.business_day_id = d.id;
UPDATE supplier_payments t JOIN business_days d ON d.loc_code = t.loc_code AND d.business_date = t.txn_date SET t.business_day_id = d.id;
UPDATE inventory_stock_counts t JOIN business_days d ON d.loc_code = t.loc_code AND d.business_date = t.business_date SET t.business_day_id = d.id;

ALTER TABLE cash_shifts
  MODIFY business_day_id BIGINT UNSIGNED NOT NULL,
  ADD KEY idx_cash_shifts_business_day (business_day_id, status),
  ADD CONSTRAINT fk_cash_shifts_business_day FOREIGN KEY (business_day_id) REFERENCES business_days(id) ON DELETE RESTRICT;
ALTER TABLE invoices
  MODIFY business_day_id BIGINT UNSIGNED NOT NULL,
  ADD KEY idx_invoices_business_day (business_day_id, status),
  ADD CONSTRAINT fk_invoices_business_day FOREIGN KEY (business_day_id) REFERENCES business_days(id) ON DELETE RESTRICT;
ALTER TABLE invoice_items
  MODIFY business_day_id BIGINT UNSIGNED NOT NULL,
  ADD KEY idx_invoice_items_business_day (business_day_id, invoice_id),
  ADD CONSTRAINT fk_invoice_items_business_day FOREIGN KEY (business_day_id) REFERENCES business_days(id) ON DELETE RESTRICT;
ALTER TABLE refund_drafts
  MODIFY business_day_id BIGINT UNSIGNED NOT NULL,
  ADD KEY idx_refund_drafts_business_day (business_day_id, status),
  ADD CONSTRAINT fk_refund_drafts_business_day FOREIGN KEY (business_day_id) REFERENCES business_days(id) ON DELETE RESTRICT;
ALTER TABLE refunds
  MODIFY business_day_id BIGINT UNSIGNED NOT NULL,
  ADD KEY idx_refunds_business_day (business_day_id, status),
  ADD CONSTRAINT fk_refunds_business_day FOREIGN KEY (business_day_id) REFERENCES business_days(id) ON DELETE RESTRICT;
ALTER TABLE goods_receipts
  MODIFY business_day_id BIGINT UNSIGNED NOT NULL,
  ADD KEY idx_goods_receipts_business_day (business_day_id, status),
  ADD CONSTRAINT fk_goods_receipts_business_day FOREIGN KEY (business_day_id) REFERENCES business_days(id) ON DELETE RESTRICT;
ALTER TABLE supplier_settlements
  MODIFY business_day_id BIGINT UNSIGNED NOT NULL,
  ADD KEY idx_supplier_settlements_business_day (business_day_id, status),
  ADD CONSTRAINT fk_supplier_settlements_business_day FOREIGN KEY (business_day_id) REFERENCES business_days(id) ON DELETE RESTRICT;
ALTER TABLE supplier_payments
  MODIFY business_day_id BIGINT UNSIGNED NOT NULL,
  ADD KEY idx_supplier_payments_business_day (business_day_id),
  ADD CONSTRAINT fk_supplier_payments_business_day FOREIGN KEY (business_day_id) REFERENCES business_days(id) ON DELETE RESTRICT;
ALTER TABLE inventory_stock_counts
  MODIFY business_day_id BIGINT UNSIGNED NOT NULL,
  ADD KEY idx_inventory_stock_counts_business_day (business_day_id, status),
  ADD CONSTRAINT fk_inventory_stock_counts_business_day FOREIGN KEY (business_day_id) REFERENCES business_days(id) ON DELETE RESTRICT;

INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('business-day.view', 'Business Day View'),
  ('business-day.open', 'Business Day Open'),
  ('business-day.close', 'Business Day Close'),
  ('business-day.reopen', 'Business Day Reopen');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.permission_key IN ('business-day.view', 'business-day.open', 'business-day.close', 'business-day.reopen')
WHERE r.role_key IN ('admin', 'cashier');

INSERT INTO business_day_events
  (business_day_id, event_no, event_type, from_status, to_status, reason, details)
SELECT d.id, 1, 'migration_open', NULL, 'open',
       'Created from the active operational context during the business-day upgrade.',
       JSON_OBJECT('source', 'migration_070')
FROM business_days d WHERE d.status = 'open';

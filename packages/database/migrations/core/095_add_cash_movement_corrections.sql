-- Manual drawer entries may be corrected only while their shift is open.
-- Source-linked movements (sales, refunds, advances, supplier payments) remain
-- immutable; their originating workflow owns any reversal.  A void is kept in
-- place for audit rather than deleting financial history.

ALTER TABLE cash_movements
  ADD COLUMN status ENUM('active','void') NOT NULL DEFAULT 'active' AFTER amount,
  ADD COLUMN voided_at DATETIME NULL AFTER status,
  ADD COLUMN voided_by BIGINT UNSIGNED NULL AFTER voided_at,
  ADD COLUMN void_reason VARCHAR(255) NULL AFTER voided_by,
  ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at,
  ADD KEY idx_cash_movements_active_shift (cash_shift_id, status, id),
  ADD CONSTRAINT fk_cash_movements_voided_by FOREIGN KEY (voided_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE cash_movement_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cash_movement_id BIGINT UNSIGNED NOT NULL,
  event_no INT UNSIGNED NOT NULL,
  action ENUM('edited','voided') NOT NULL,
  reason VARCHAR(255) NOT NULL,
  before_state JSON NOT NULL,
  after_state JSON NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cash_movement_event_no (cash_movement_id, event_no),
  KEY idx_cash_movement_events_created (created_at, id),
  CONSTRAINT fk_cash_movement_events_movement FOREIGN KEY (cash_movement_id) REFERENCES cash_movements(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cash_movement_events_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('cash.movement.correct', 'Cash Movement Correct');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.permission_key = 'cash.movement.correct'
WHERE r.role_key = 'admin';

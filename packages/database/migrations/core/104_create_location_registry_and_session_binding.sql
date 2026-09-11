-- Location registry and session-to-workstation binding.
--
-- A location code is the one key that separates data: each location has its
-- own catalog, customers, settings, and books. A code is therefore issued once
-- and never reused. Rows in pos_locations are never deleted -- a closed location
-- is marked retired and its code stays taken -- so the primary key alone stops
-- a code from being handed out twice.
--
-- The business code is a grouping label only (for combined reports and the
-- server's monitoring view). It is never used to separate data.

CREATE TABLE pos_locations (
  loc_code VARCHAR(50) NOT NULL,
  business_code VARCHAR(50) NOT NULL,
  name VARCHAR(150) NOT NULL,
  status ENUM('active','retired') NOT NULL DEFAULT 'active',
  notes VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retired_at TIMESTAMP NULL,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (loc_code),
  KEY idx_pos_locations_business (business_code, status, loc_code),
  CONSTRAINT chk_pos_locations_code CHECK (CHAR_LENGTH(TRIM(loc_code)) > 0 AND loc_code = UPPER(loc_code)),
  CONSTRAINT chk_pos_locations_business CHECK (CHAR_LENGTH(TRIM(business_code)) > 0 AND business_code = UPPER(business_code)),
  CONSTRAINT chk_pos_locations_name CHECK (CHAR_LENGTH(TRIM(name)) > 0),
  CONSTRAINT chk_pos_locations_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- "Never reused" is enforced by the database, not by remembering to be careful.
CREATE TRIGGER trg_pos_locations_never_deleted
BEFORE DELETE ON pos_locations
FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A location code is never deleted. Retire the location instead so its code stays taken.';

CREATE TRIGGER trg_pos_locations_code_immutable
BEFORE UPDATE ON pos_locations
FOR EACH ROW
BEGIN
  IF NEW.loc_code <> OLD.loc_code THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A location code cannot be changed once issued.';
  END IF;
END;

-- Every code already in use is registered, including codes that only survive in
-- transaction history, so none of them can be issued again. Existing locations
-- start as their own business; the label can be changed later.
INSERT INTO pos_locations (loc_code, business_code, name, status)
SELECT UPPER(w.location_code), UPPER(w.location_code), MIN(w.name), 'active'
FROM pos_workstations w
GROUP BY UPPER(w.location_code);

INSERT IGNORE INTO pos_locations (loc_code, business_code, name, status, retired_at, notes)
SELECT DISTINCT UPPER(d.loc_code), UPPER(d.loc_code), UPPER(d.loc_code), 'retired', CURRENT_TIMESTAMP,
       'Found only in transaction history; kept so the code is never reused.'
FROM business_days d;

-- Every transaction table stores loc_code as VARCHAR(50); the workstation was
-- the only place limited to 30, so a long code could be registered but not
-- used. It now matches and must name a registered location.
ALTER TABLE pos_workstations
  MODIFY COLUMN location_code VARCHAR(50) NOT NULL,
  MODIFY COLUMN machine_code VARCHAR(50) NOT NULL,
  ADD CONSTRAINT fk_pos_workstations_location FOREIGN KEY (location_code) REFERENCES pos_locations(loc_code) ON UPDATE RESTRICT ON DELETE RESTRICT;

-- One sign-in is bound to exactly one workstation session, so every request made
-- with that token is known to come from that workstation.
ALTER TABLE sessions
  ADD COLUMN workstation_session_id BIGINT UNSIGNED NULL AFTER user_id,
  ADD KEY idx_sessions_workstation_session (workstation_session_id),
  ADD CONSTRAINT fk_sessions_workstation_session FOREIGN KEY (workstation_session_id) REFERENCES workstation_sessions(id) ON DELETE SET NULL;

INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('locations.manage', 'Locations Manage');

-- Locations are set up alongside workstations, by whoever manages workstations.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id AND source.permission_key = 'settings.manage'
JOIN permissions target ON target.permission_key = 'locations.manage';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key = 'locations.manage'
WHERE r.role_key = 'admin';

-- POS Workstations: one row per physical billing machine/counter
-- Composite key: location_code + machine_code uniquely identifies a POS terminal
CREATE TABLE IF NOT EXISTS pos_workstations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  location_code VARCHAR(30) NOT NULL,
  machine_code VARCHAR(30) NOT NULL,
  name VARCHAR(150) NOT NULL,
  bill_config JSON NULL,
  default_printer VARCHAR(255) NULL,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_workstation_loc_machine (location_code, machine_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

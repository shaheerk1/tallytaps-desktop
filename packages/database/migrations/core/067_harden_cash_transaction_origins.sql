ALTER TABLE cash_shifts
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER user_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN shift_no INT UNSIGNED NULL AFTER mac_code;
UPDATE cash_shifts s JOIN pos_workstations w ON w.id = s.workstation_id
SET s.loc_code = w.location_code, s.mac_code = w.machine_code;
UPDATE cash_shifts s JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY loc_code, mac_code, business_date ORDER BY id) AS generated_no
  FROM cash_shifts
) numbered ON numbered.id = s.id SET s.shift_no = numbered.generated_no;
ALTER TABLE cash_shifts
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL, MODIFY shift_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_cash_shifts_origin (loc_code, mac_code, business_date, shift_no),
  ADD CONSTRAINT chk_cash_shifts_origin_location CHECK (CHAR_LENGTH(TRIM(loc_code)) > 0),
  ADD CONSTRAINT chk_cash_shifts_origin_machine CHECK (CHAR_LENGTH(TRIM(mac_code)) > 0);

ALTER TABLE cash_counts
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER cash_shift_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN business_date DATE NULL AFTER mac_code,
  ADD COLUMN shift_no INT UNSIGNED NULL AFTER business_date;
UPDATE cash_counts c JOIN cash_shifts s ON s.id = c.cash_shift_id
SET c.loc_code = s.loc_code, c.mac_code = s.mac_code, c.business_date = s.business_date, c.shift_no = s.shift_no;
ALTER TABLE cash_counts
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL,
  MODIFY business_date DATE NOT NULL, MODIFY shift_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_cash_counts_origin (loc_code, mac_code, business_date, shift_no, count_type);

ALTER TABLE cash_count_lines
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER cash_count_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN business_date DATE NULL AFTER mac_code,
  ADD COLUMN shift_no INT UNSIGNED NULL AFTER business_date,
  ADD COLUMN count_type VARCHAR(20) NULL AFTER shift_no;
UPDATE cash_count_lines l
JOIN cash_counts c ON c.id = l.cash_count_id
SET l.loc_code = c.loc_code, l.mac_code = c.mac_code, l.business_date = c.business_date,
    l.shift_no = c.shift_no, l.count_type = c.count_type;
ALTER TABLE cash_count_lines
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL,
  MODIFY business_date DATE NOT NULL, MODIFY shift_no INT UNSIGNED NOT NULL, MODIFY count_type VARCHAR(20) NOT NULL,
  ADD UNIQUE KEY uq_cash_count_lines_origin (loc_code, mac_code, business_date, shift_no, count_type, denomination);

ALTER TABLE cash_movements
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER cash_shift_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN business_date DATE NULL AFTER mac_code,
  ADD COLUMN shift_no INT UNSIGNED NULL AFTER business_date,
  ADD COLUMN movement_no INT UNSIGNED NULL AFTER shift_no;
UPDATE cash_movements m JOIN cash_shifts s ON s.id = m.cash_shift_id
SET m.loc_code = s.loc_code, m.mac_code = s.mac_code, m.business_date = s.business_date, m.shift_no = s.shift_no;
UPDATE cash_movements m JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY cash_shift_id ORDER BY id) AS generated_no FROM cash_movements
) numbered ON numbered.id = m.id SET m.movement_no = numbered.generated_no;
ALTER TABLE cash_movements
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL,
  MODIFY business_date DATE NOT NULL, MODIFY shift_no INT UNSIGNED NOT NULL, MODIFY movement_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_cash_movements_origin (loc_code, mac_code, business_date, shift_no, movement_no);

ALTER TABLE cash_shift_reports
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER cash_shift_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN business_date DATE NULL AFTER mac_code,
  ADD COLUMN shift_no INT UNSIGNED NULL AFTER business_date;
UPDATE cash_shift_reports r JOIN cash_shifts s ON s.id = r.cash_shift_id
SET r.loc_code = s.loc_code, r.mac_code = s.mac_code, r.business_date = s.business_date, r.shift_no = s.shift_no;
UPDATE cash_shift_reports SET report_no = id WHERE report_no IS NULL;
ALTER TABLE cash_shift_reports
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL,
  MODIFY business_date DATE NOT NULL, MODIFY shift_no INT UNSIGNED NOT NULL, MODIFY report_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_cash_reports_origin (loc_code, mac_code, business_date, shift_no, report_type, report_no);

ALTER TABLE cash_shift_report_prints
  ADD COLUMN loc_code VARCHAR(50) NULL AFTER cash_shift_id,
  ADD COLUMN mac_code VARCHAR(50) NULL AFTER loc_code,
  ADD COLUMN business_date DATE NULL AFTER mac_code,
  ADD COLUMN shift_no INT UNSIGNED NULL AFTER business_date,
  ADD COLUMN print_no INT UNSIGNED NULL AFTER report_no;
UPDATE cash_shift_report_prints p JOIN cash_shifts s ON s.id = p.cash_shift_id
SET p.loc_code = s.loc_code, p.mac_code = s.mac_code, p.business_date = s.business_date, p.shift_no = s.shift_no;
UPDATE cash_shift_report_prints p JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY cash_shift_id ORDER BY id) AS generated_no FROM cash_shift_report_prints
) numbered ON numbered.id = p.id SET p.print_no = numbered.generated_no;
ALTER TABLE cash_shift_report_prints
  MODIFY loc_code VARCHAR(50) NOT NULL, MODIFY mac_code VARCHAR(50) NOT NULL,
  MODIFY business_date DATE NOT NULL, MODIFY shift_no INT UNSIGNED NOT NULL, MODIFY print_no INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_cash_report_prints_origin (loc_code, mac_code, business_date, shift_no, print_no);

INSERT INTO document_sequences (document_type, loc_code, mac_code, txn_date, next_number)
SELECT 'cash_shift', loc_code, mac_code, business_date, MAX(shift_no) + 1
FROM cash_shifts GROUP BY loc_code, mac_code, business_date
ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number));

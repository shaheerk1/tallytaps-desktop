-- Printed cash reports are archived as separate runs so the operator can
-- review every X/Z print instead of only the logical shift snapshot.

CREATE TABLE IF NOT EXISTS cash_shift_report_prints (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cash_shift_report_id BIGINT UNSIGNED NULL,
  cash_shift_id BIGINT UNSIGNED NOT NULL,
  report_type ENUM('X', 'Z') NOT NULL,
  report_no INT UNSIGNED NOT NULL,
  snapshot JSON NOT NULL,
  printed_by BIGINT UNSIGNED NOT NULL,
  printed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cash_shift_report_prints_shift (cash_shift_id, printed_at),
  KEY idx_cash_shift_report_prints_report (cash_shift_report_id),
  KEY idx_cash_shift_report_prints_type_no (cash_shift_id, report_type, report_no),
  CONSTRAINT fk_cash_shift_report_prints_report FOREIGN KEY (cash_shift_report_id) REFERENCES cash_shift_reports(id) ON DELETE SET NULL,
  CONSTRAINT fk_cash_shift_report_prints_shift FOREIGN KEY (cash_shift_id) REFERENCES cash_shifts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cash_shift_report_prints_user FOREIGN KEY (printed_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

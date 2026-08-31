INSERT INTO document_sequences (document_type, loc_code, mac_code, txn_date, next_number)
SELECT 'cash_x_report', loc_code, mac_code, business_date, MAX(report_no) + 1
FROM cash_shift_report_prints
WHERE report_type = 'X'
GROUP BY loc_code, mac_code, business_date
ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number));

DROP TABLE refund_sequences;

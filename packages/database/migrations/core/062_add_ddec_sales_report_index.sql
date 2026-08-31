-- Drives the finalized-sales date range used by the direct DDEC sales report.
ALTER TABLE invoices
  ADD KEY idx_invoices_sales_report (inv_stat, status, txn_date, id);

-- Customer is stored on every live invoice line so recalled bills retain it;
-- supplier is deliberately a per-line value because a bill can mix suppliers.
ALTER TABLE invoices
  ADD COLUMN customer_code VARCHAR(120) NOT NULL DEFAULT '' AFTER customer_id,
  ADD KEY idx_invoices_customer_code_date (customer_code, txn_date);

ALTER TABLE invoice_items
  ADD COLUMN customer_code VARCHAR(120) NOT NULL DEFAULT '' AFTER receipt_no,
  ADD COLUMN supplier_code VARCHAR(120) NOT NULL DEFAULT '' AFTER product_id,
  ADD KEY idx_invoice_items_customer_live (customer_code, invoice_id, txn_date),
  ADD KEY idx_invoice_items_supplier_date (supplier_code, txn_date);

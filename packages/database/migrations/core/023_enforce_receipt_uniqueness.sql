-- Enforce the composite receipt identity: a receipt is uniquely identified by
-- (location code, machine code, txn date, receipt no) — matching the reference
-- model where loc_code + mac_code + txn_date + receiptno is the key.
--
-- invoice_items: a line is unique per receipt + seq_no. MySQL treats NULL
-- values as distinct in unique indexes, so legacy rows (txn_date/receipt_no
-- NULL from the non-POS createSale path) do not collide with each other or
-- with POS rows.

ALTER TABLE invoice_items
  ADD UNIQUE KEY uq_invoice_items_receipt_line (loc_code, mac_code, txn_date, receipt_no, seq_no);

-- invoices: only one master row may exist per receipt.

ALTER TABLE invoices
  ADD UNIQUE KEY uq_invoices_receipt (loc_code, mac_code, txn_date, receipt_no);

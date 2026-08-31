ALTER TABLE business_days
  ADD UNIQUE KEY uq_business_days_document_identity (id, loc_code, business_date);

ALTER TABLE cash_shifts
  DROP FOREIGN KEY fk_cash_shifts_business_day,
  ADD CONSTRAINT fk_cash_shifts_business_day_identity
    FOREIGN KEY (business_day_id, loc_code, business_date)
    REFERENCES business_days (id, loc_code, business_date) ON DELETE RESTRICT;

ALTER TABLE invoices
  DROP FOREIGN KEY fk_invoices_business_day,
  ADD CONSTRAINT fk_invoices_business_day_identity
    FOREIGN KEY (business_day_id, loc_code, txn_date)
    REFERENCES business_days (id, loc_code, business_date) ON DELETE RESTRICT;

ALTER TABLE invoice_items
  DROP FOREIGN KEY fk_invoice_items_business_day,
  ADD CONSTRAINT fk_invoice_items_business_day_identity
    FOREIGN KEY (business_day_id, loc_code, txn_date)
    REFERENCES business_days (id, loc_code, business_date) ON DELETE RESTRICT;

ALTER TABLE refund_drafts
  DROP FOREIGN KEY fk_refund_drafts_business_day,
  ADD CONSTRAINT fk_refund_drafts_business_day_identity
    FOREIGN KEY (business_day_id, loc_code, txn_date)
    REFERENCES business_days (id, loc_code, business_date) ON DELETE RESTRICT;

ALTER TABLE refunds
  DROP FOREIGN KEY fk_refunds_business_day,
  ADD CONSTRAINT fk_refunds_business_day_identity
    FOREIGN KEY (business_day_id, loc_code, txn_date)
    REFERENCES business_days (id, loc_code, business_date) ON DELETE RESTRICT;

ALTER TABLE goods_receipts
  DROP FOREIGN KEY fk_goods_receipts_business_day,
  ADD CONSTRAINT fk_goods_receipts_business_day_identity
    FOREIGN KEY (business_day_id, loc_code, business_date)
    REFERENCES business_days (id, loc_code, business_date) ON DELETE RESTRICT;

ALTER TABLE supplier_settlements
  DROP FOREIGN KEY fk_supplier_settlements_business_day,
  ADD CONSTRAINT fk_supplier_settlements_business_day_identity
    FOREIGN KEY (business_day_id, loc_code, txn_date)
    REFERENCES business_days (id, loc_code, business_date) ON DELETE RESTRICT;

ALTER TABLE supplier_payments
  DROP FOREIGN KEY fk_supplier_payments_business_day,
  ADD CONSTRAINT fk_supplier_payments_business_day_identity
    FOREIGN KEY (business_day_id, loc_code, txn_date)
    REFERENCES business_days (id, loc_code, business_date) ON DELETE RESTRICT;

ALTER TABLE inventory_stock_counts
  DROP FOREIGN KEY fk_inventory_stock_counts_business_day,
  ADD CONSTRAINT fk_inventory_stock_counts_business_day_identity
    FOREIGN KEY (business_day_id, loc_code, business_date)
    REFERENCES business_days (id, loc_code, business_date) ON DELETE RESTRICT;

ALTER TABLE payments
  DROP FOREIGN KEY fk_payments_business_day,
  ADD CONSTRAINT fk_payments_business_day_identity
    FOREIGN KEY (business_day_id, loc_code, txn_date)
    REFERENCES business_days (id, loc_code, business_date) ON DELETE RESTRICT;

ALTER TABLE customer_receivable_entries
  DROP FOREIGN KEY fk_receivable_entries_business_day,
  ADD CONSTRAINT fk_receivable_entries_business_day_identity
    FOREIGN KEY (business_day_id, loc_code, txn_date)
    REFERENCES business_days (id, loc_code, business_date) ON DELETE RESTRICT;

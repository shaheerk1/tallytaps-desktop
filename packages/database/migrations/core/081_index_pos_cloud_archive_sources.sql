-- Keep background change scans bounded on long-lived POS databases.
CREATE INDEX idx_invoices_cloud_sync ON invoices (cloud_sync_updated_at, id);
CREATE INDEX idx_invoice_items_cloud_sync ON invoice_items (cloud_sync_updated_at, id);
CREATE INDEX idx_payments_cloud_sync ON payments (cloud_sync_updated_at, id);
CREATE INDEX idx_refunds_cloud_sync ON refunds (cloud_sync_updated_at, id);
CREATE INDEX idx_refund_items_cloud_sync ON refund_items (cloud_sync_updated_at, id);
CREATE INDEX idx_refund_payments_cloud_sync ON refund_payments (cloud_sync_updated_at, id);
CREATE INDEX idx_cash_movements_cloud_sync ON cash_movements (cloud_sync_updated_at, id);
CREATE INDEX idx_stock_movements_cloud_sync ON stock_movements (cloud_sync_updated_at, id);
CREATE INDEX idx_receivable_entries_cloud_sync ON customer_receivable_entries (cloud_sync_updated_at, id);
CREATE INDEX idx_cheques_cloud_sync ON cheques (cloud_sync_updated_at, id);
CREATE INDEX idx_issued_cheques_cloud_sync ON issued_cheques (cloud_sync_updated_at, id);
CREATE INDEX idx_business_days_cloud_sync ON business_days (cloud_sync_updated_at, id);
CREATE INDEX idx_goods_receipts_cloud_sync ON goods_receipts (cloud_sync_updated_at, id);
CREATE INDEX idx_goods_receipt_lines_cloud_sync ON goods_receipt_lines (cloud_sync_updated_at, id);
CREATE INDEX idx_products_cloud_sync ON products (cloud_sync_updated_at, id);

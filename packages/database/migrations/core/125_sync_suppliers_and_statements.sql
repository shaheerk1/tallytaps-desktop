-- The phone should be able to read supply work too: who the suppliers are,
-- their statements with the lines behind them, and their account entries.
-- A table only reaches the archive if it carries the sync stamp.
ALTER TABLE suppliers ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE supplier_sale_statements ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE supplier_sale_statement_adjustments ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE supplier_sale_statement_allocations ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE supplier_sale_statement_manual_lines ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE supplier_sale_statement_purchase_lines ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);

CREATE INDEX idx_suppliers_cloud_sync ON suppliers (cloud_sync_updated_at, id);
CREATE INDEX idx_supplier_statements_cloud_sync ON supplier_sale_statements (cloud_sync_updated_at, id);
CREATE INDEX idx_statement_adjustments_cloud_sync ON supplier_sale_statement_adjustments (cloud_sync_updated_at, id);
CREATE INDEX idx_statement_allocations_cloud_sync ON supplier_sale_statement_allocations (cloud_sync_updated_at, id);
CREATE INDEX idx_statement_manual_lines_cloud_sync ON supplier_sale_statement_manual_lines (cloud_sync_updated_at, id);
CREATE INDEX idx_statement_purchase_lines_cloud_sync ON supplier_sale_statement_purchase_lines (cloud_sync_updated_at, id);
CREATE INDEX idx_supplier_account_entries_cloud_sync ON supplier_account_entries (cloud_sync_updated_at, id);

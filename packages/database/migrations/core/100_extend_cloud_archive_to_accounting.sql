-- Make the accounting and supplier subledgers eligible for the same generic,
-- append/update-aware cloud archive used by sales and inventory.

ALTER TABLE supplier_payable_entries ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE supplier_settlements ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE supplier_settlement_lines ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE supplier_payments ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);

CREATE INDEX idx_supplier_payable_cloud_sync ON supplier_payable_entries (cloud_sync_updated_at, id);
CREATE INDEX idx_supplier_settlement_cloud_sync ON supplier_settlements (cloud_sync_updated_at, id);
CREATE INDEX idx_supplier_settlement_line_cloud_sync ON supplier_settlement_lines (cloud_sync_updated_at, id);
CREATE INDEX idx_supplier_payment_cloud_sync ON supplier_payments (cloud_sync_updated_at, id);
CREATE INDEX idx_expense_entry_cloud_sync ON expense_entries (cloud_sync_updated_at, id);
CREATE INDEX idx_expense_allocation_cloud_sync ON expense_allocations (cloud_sync_updated_at, id);
CREATE INDEX idx_fund_movement_cloud_sync ON fund_movements (cloud_sync_updated_at, id);
CREATE INDEX idx_journal_entry_cloud_sync ON journal_entries (cloud_sync_updated_at, id);
CREATE INDEX idx_journal_line_cloud_sync ON journal_lines (cloud_sync_updated_at, id);

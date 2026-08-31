-- DDEC POS development database cleanup
--
-- DESTRUCTIVE: this permanently removes operational/test transactions.
-- It is intentionally not a core migration and must never be run on a live DB.
--
-- Preserved:
--   users, roles, permissions, role assignments, POS workstations, cash drawers,
--   system settings, UI/receipt settings, payment modes, priority lists,
--   suppliers, supply agreements, business bank accounts,
--   supplier charge types, field inbox configuration and migration history.
-- Customer/party masters are intentionally cleared by this reset.
--
-- Product cleanup:
--   SKU 0001 is preserved with its current item configuration and zero stock.
--   If it does not exist, a basic test item is created. All other products are removed.
--
-- Billing-date reset:
--   old workstation sessions and business days are removed; an OPEN business day
--   dated one calendar day before the MySQL server's current date is created for
--   every active POS location. The next login resumes that date and receipt numbering
--   begins from 1 because document_sequences is cleared.

USE `pos_platform`;

SET @cleanup_previous_time_zone = @@SESSION.time_zone;
SET time_zone = '+05:30';
-- Recover safely if an earlier execution stopped before its cleanup footer.
SET FOREIGN_KEY_CHECKS = 1;

-- Current development databases may already have retired some legacy tables.
-- Route every truncate through this helper so a missing table is skipped.
DROP PROCEDURE IF EXISTS `cleanup_truncate_if_exists`;
DELIMITER $$
CREATE PROCEDURE `cleanup_truncate_if_exists`(IN cleanup_table_name VARCHAR(128))
BEGIN
  IF EXISTS (
    SELECT 1
    FROM `information_schema`.`TABLES`
    WHERE `TABLE_SCHEMA` = DATABASE()
      AND `TABLE_NAME` = cleanup_table_name
      AND `TABLE_TYPE` = 'BASE TABLE'
  ) THEN
    SET @cleanup_truncate_sql = CONCAT(
      'TRUNCATE TABLE `', REPLACE(cleanup_table_name, '`', '``'), '`'
    );
    PREPARE cleanup_truncate_statement FROM @cleanup_truncate_sql;
    EXECUTE cleanup_truncate_statement;
    DEALLOCATE PREPARE cleanup_truncate_statement;
  END IF;
END$$
DELIMITER ;

SET FOREIGN_KEY_CHECKS = 0;

-- Incoming and issued cheque registers.
CALL `cleanup_truncate_if_exists`('cheque_status_events');
CALL `cleanup_truncate_if_exists`('cheques');
CALL `cleanup_truncate_if_exists`('issued_cheque_status_events');
CALL `cleanup_truncate_if_exists`('issued_cheques');

-- Supplier sales statements and their audit/allocation detail.
CALL `cleanup_truncate_if_exists`('supplier_sale_statement_events');
CALL `cleanup_truncate_if_exists`('supplier_sale_statement_adjustments');
CALL `cleanup_truncate_if_exists`('supplier_sale_statement_manual_lines');
CALL `cleanup_truncate_if_exists`('supplier_sale_statement_allocations');
CALL `cleanup_truncate_if_exists`('supplier_sale_statement_grns');
CALL `cleanup_truncate_if_exists`('supplier_sale_statements');
CALL `cleanup_truncate_if_exists`('supplier_invoice_item_attribution_events');
CALL `cleanup_truncate_if_exists`('supplier_invoice_item_attributions');

-- Supplier settlement, payable and inventory-allocation transactions.
CALL `cleanup_truncate_if_exists`('supplier_payments');
CALL `cleanup_truncate_if_exists`('supplier_settlement_lines');
CALL `cleanup_truncate_if_exists`('supplier_settlements');
CALL `cleanup_truncate_if_exists`('supplier_payable_entries');
CALL `cleanup_truncate_if_exists`('lot_sale_allocations');

-- Refund work-in-progress, finalized refunds and audit trail.
CALL `cleanup_truncate_if_exists`('refund_audit_events');
CALL `cleanup_truncate_if_exists`('refund_payments');
CALL `cleanup_truncate_if_exists`('refund_items');
CALL `cleanup_truncate_if_exists`('refund_draft_items');
CALL `cleanup_truncate_if_exists`('refunds');
CALL `cleanup_truncate_if_exists`('refund_drafts');

-- Sales, pending bills, finalized invoice headers and customer-account effects.
CALL `cleanup_truncate_if_exists`('invoice_customer_assignment_events');
CALL `cleanup_truncate_if_exists`('customer_receivable_entries');
CALL `cleanup_truncate_if_exists`('invoice_headers');
CALL `cleanup_truncate_if_exists`('payments');
CALL `cleanup_truncate_if_exists`('invoice_items');
CALL `cleanup_truncate_if_exists`('invoices');
CALL `cleanup_truncate_if_exists`('bill_draft_items');
CALL `cleanup_truncate_if_exists`('bill_drafts');
CALL `cleanup_truncate_if_exists`('live_bill_headers');
CALL `cleanup_truncate_if_exists`('live_bill_contexts');

-- Goods receiving, inventory lots, measurements and physical stock control.
CALL `cleanup_truncate_if_exists`('inventory_stock_count_lines');
CALL `cleanup_truncate_if_exists`('inventory_stock_counts');
CALL `cleanup_truncate_if_exists`('inventory_measurements');
CALL `cleanup_truncate_if_exists`('inventory_lots');
CALL `cleanup_truncate_if_exists`('goods_receipt_lines');
CALL `cleanup_truncate_if_exists`('goods_receipts');
CALL `cleanup_truncate_if_exists`('stock_movements');

-- Cash-shift operational history. cash_drawers themselves are configuration.
CALL `cleanup_truncate_if_exists`('cash_shift_report_prints');
CALL `cleanup_truncate_if_exists`('cash_shift_reports');
CALL `cleanup_truncate_if_exists`('cash_count_lines');
CALL `cleanup_truncate_if_exists`('cash_counts');
CALL `cleanup_truncate_if_exists`('cash_movements');
CALL `cleanup_truncate_if_exists`('cash_shifts');

-- Local resolutions are activity records; retain the remote inbox connection.
CALL `cleanup_truncate_if_exists`('field_inbox_resolution');

-- Retired transaction/audit tables that can still exist in older development DBs.
CALL `cleanup_truncate_if_exists`('produce_invoice_lines');
CALL `cleanup_truncate_if_exists`('power_tools_events');
CALL `cleanup_truncate_if_exists`('refund_sequences');

-- Login/workstation activity and per-document counters.
CALL `cleanup_truncate_if_exists`('sessions');
CALL `cleanup_truncate_if_exists`('workstation_sessions');
CALL `cleanup_truncate_if_exists`('document_sequences');

-- Business-day audit/control is rebuilt below for the clean starting date.
CALL `cleanup_truncate_if_exists`('business_day_events');
CALL `cleanup_truncate_if_exists`('business_days');

-- CRM/customer masters, including remnants retained by older schemas.
CALL `cleanup_truncate_if_exists`('party_identifiers');
CALL `cleanup_truncate_if_exists`('customer_accounts');
CALL `cleanup_truncate_if_exists`('party_roles');
CALL `cleanup_truncate_if_exists`('parties');
CALL `cleanup_truncate_if_exists`('legacy_customers');
CALL `cleanup_truncate_if_exists`('customers');

-- Keep the business-bank-account sequence because bank masters are preserved,
-- but restart customer/party numbering for the now-empty CRM.
DELETE FROM `master_record_sequences`
WHERE `record_type` IN ('party', 'customer_account', 'party_identifier');

DROP PROCEDURE `cleanup_truncate_if_exists`;

-- Guarantee one usable test item and retain its existing configuration when present.
INSERT INTO `products` (`sku`, `name`, `unit_price`, `stock_qty`)
SELECT '0001', 'Test Item 0001', 0.00, 0.000
WHERE NOT EXISTS (SELECT 1 FROM `products` WHERE `sku` = '0001');

DELETE FROM `products` WHERE `sku` <> '0001';
UPDATE `products`
SET `stock_qty` = 0.000,
    `is_active` = 1
WHERE `sku` = '0001';
ALTER TABLE `products` AUTO_INCREMENT = 1;

-- One clean, open operational day per active location, set to yesterday.
SET @cleanup_billing_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY);

INSERT INTO `business_days`
  (`loc_code`, `business_date`, `status`, `opened_at`, `close_reason`, `summary_snapshot`)
SELECT DISTINCT
  `location_code`, @cleanup_billing_date, 'open', NOW(), NULL, NULL
FROM `pos_workstations`
WHERE `status` = 'active';

-- Always leave relational checks enabled. This also repairs a Workbench
-- connection left with checks disabled by an earlier interrupted cleanup run.
SET FOREIGN_KEY_CHECKS = 1;
SET time_zone = @cleanup_previous_time_zone;

-- Small verification result returned by MySQL after the cleanup.
SELECT
  @cleanup_billing_date AS `clean_billing_date`,
  (SELECT COUNT(*) FROM `business_days` WHERE `status` = 'open') AS `open_business_days`,
  (SELECT COUNT(*) FROM `products`) AS `remaining_products`,
  (SELECT COUNT(*) FROM `products` WHERE `sku` = '0001') AS `sku_0001_present`,
  (SELECT COUNT(*) FROM `customer_accounts`) AS `remaining_customer_accounts`,
  (SELECT COUNT(*) FROM `parties`) AS `remaining_parties`,
  (SELECT COUNT(*) FROM `invoices`) AS `remaining_invoices`,
  (SELECT COUNT(*) FROM `refunds`) AS `remaining_refunds`,
  (SELECT COUNT(*) FROM `goods_receipts`) AS `remaining_grns`;

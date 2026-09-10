-- Sending goods out to another shop is an issue, not a stock count.
--
-- Loads leaving on someone else's lorry were being written off as physical
-- counts, and a count only ever recorded one measure. That is why a lot could
-- read 9 bags and 6,084 kilos at the same time. An issue always carries both
-- measures, names the destination, and keeps the weighbridge ticket beside the
-- goods it weighed.

CREATE TABLE IF NOT EXISTS inventory_issues (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  business_day_id BIGINT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  issue_no INT NOT NULL,
  business_date DATE NOT NULL,
  status ENUM('draft','finalized','void') NOT NULL DEFAULT 'draft',
  destination VARCHAR(160) NOT NULL,
  vehicle_number VARCHAR(60) NULL,
  weighbridge_ticket VARCHAR(80) NULL,
  weighbridge_net_quantity DECIMAL(14,3) NULL,
  weighbridge_charge DECIMAL(12,2) NOT NULL DEFAULT 0,
  weighbridge_expense_entry_id BIGINT UNSIGNED NULL,
  reason VARCHAR(255) NULL,
  issued_by BIGINT UNSIGNED NULL,
  finalized_at TIMESTAMP NULL,
  voided_at TIMESTAMP NULL,
  voided_by BIGINT UNSIGNED NULL,
  void_reason VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_inventory_issues_day FOREIGN KEY (business_day_id) REFERENCES business_days(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_issues_user FOREIGN KEY (issued_by) REFERENCES users(id) ON DELETE RESTRICT,
  UNIQUE KEY uq_inventory_issues_document (loc_code, mac_code, business_date, issue_no),
  KEY idx_inventory_issues_date (loc_code, business_date, status),
  KEY idx_inventory_issues_cloud_sync (cloud_sync_updated_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_issue_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  issue_id BIGINT UNSIGNED NOT NULL,
  loc_code VARCHAR(50) NOT NULL,
  mac_code VARCHAR(50) NOT NULL,
  business_date DATE NOT NULL,
  issue_no INT NOT NULL,
  line_no INT NOT NULL,
  inventory_lot_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  handling_quantity DECIMAL(14,3) NOT NULL,
  base_quantity DECIMAL(14,3) NULL,
  handling_uom_snapshot VARCHAR(60) NULL,
  base_uom_snapshot VARCHAR(60) NULL,
  note VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_inventory_issue_lines_issue FOREIGN KEY (issue_id) REFERENCES inventory_issues(id) ON DELETE CASCADE,
  CONSTRAINT fk_inventory_issue_lines_lot FOREIGN KEY (inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_issue_lines_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  UNIQUE KEY uq_inventory_issue_lines_line (issue_id, line_no),
  KEY idx_inventory_issue_lines_lot (inventory_lot_id),
  KEY idx_inventory_issue_lines_cloud_sync (cloud_sync_updated_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A lot's measurement history needs a word for "this much left on a lorry".
-- Loads that were weighed keep the existing 'weighbridge' reading instead.
ALTER TABLE inventory_measurements
  MODIFY COLUMN measurement_type ENUM(
    'declared','weighbridge','physical_count','loss','damage','supplier_return','correction','issue'
  ) NOT NULL;

-- Recording an outward load is its own action. It moves stock without taking
-- money, so it is not covered by the adjust permission a stocktake uses.
INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('inventory.issue', 'Inventory Send Out');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key = 'inventory.issue'
WHERE r.name IN ('Administrator', 'Supervisor');

-- The weighbridge fee belongs to the goods it weighed, so it needs a category
-- with the goods-related treatment already used by lorry wage and unloading.
INSERT IGNORE INTO expense_categories (category_code, name, default_treatment, help_text, sort_order)
VALUES ('weighbridge', 'Weighbridge fee', 'lot_cost',
        'Paid to weigh a load in or out. Belongs to the goods on that lorry.', 70);

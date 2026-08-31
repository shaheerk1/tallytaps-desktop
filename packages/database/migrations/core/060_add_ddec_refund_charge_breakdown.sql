-- Keep DDEC refunds as direct, auditable amounts.  Charge selection belongs
-- to the draft so a partial return can refund the proportional charge, omit
-- it, or use a deliberately entered amount.
ALTER TABLE refund_draft_items
  ADD COLUMN source_merchandise_total DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER unit_price,
  ADD COLUMN source_bag_charge_total DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER source_merchandise_total,
  ADD COLUMN source_wage_charge_total DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER source_bag_charge_total,
  ADD COLUMN merchandise_total DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER tax,
  ADD COLUMN bag_charge_mode ENUM('proportional', 'exclude', 'custom') NOT NULL DEFAULT 'proportional' AFTER merchandise_total,
  ADD COLUMN bag_charge_total DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER bag_charge_mode,
  ADD COLUMN wage_charge_mode ENUM('proportional', 'exclude', 'custom') NOT NULL DEFAULT 'proportional' AFTER bag_charge_total,
  ADD COLUMN wage_charge_total DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER wage_charge_mode;

ALTER TABLE refunds
  ADD COLUMN merchandise_total DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER subtotal,
  ADD COLUMN bag_charge_total DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER merchandise_total,
  ADD COLUMN wage_charge_total DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER bag_charge_total;

ALTER TABLE refund_items
  ADD COLUMN merchandise_total DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER tax,
  ADD COLUMN bag_charge_mode ENUM('proportional', 'exclude', 'custom') NOT NULL DEFAULT 'proportional' AFTER merchandise_total,
  ADD COLUMN bag_charge_total DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER bag_charge_mode,
  ADD COLUMN wage_charge_mode ENUM('proportional', 'exclude', 'custom') NOT NULL DEFAULT 'proportional' AFTER bag_charge_total,
  ADD COLUMN wage_charge_total DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER wage_charge_mode;

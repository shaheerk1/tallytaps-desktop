-- Removing a GRN that was never used (for example one entered to try things
-- out). Its stock is taken back out and any supplier amount reversed, with
-- ledger entries, and the GRN is kept as 'removed' so the history stays whole.
ALTER TABLE goods_receipts
  MODIFY COLUMN status ENUM('draft','finalized','cancelled','corrected','removed') NOT NULL DEFAULT 'draft',
  ADD COLUMN removed_at DATETIME NULL AFTER finalized_at,
  ADD COLUMN removed_by BIGINT UNSIGNED NULL AFTER removed_at,
  ADD COLUMN removal_reason VARCHAR(255) NULL AFTER removed_by;

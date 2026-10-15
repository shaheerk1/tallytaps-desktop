-- A lot that sells before anybody knows how much of it came.
--
-- Goods arrive on consignment and the shop starts selling the same morning:
-- how many bags, and what they weighed, is not known and sometimes never will
-- be. What is known is the lot they are being sold under. So a delivery note
-- can now be written with no quantities at all, and its lot sells until
-- somebody says it is finished.
--
-- Such a lot has no balance to run down, so three things follow:
--
--   1. it keeps its code at the counter until it is closed, where an ordinary
--      lot loses it on reaching zero;
--   2. it is never picked by itself -- a sale reaches it only by being told its
--      code -- because a lot that never empties would otherwise swallow every
--      sale of that item ahead of the stock that can be counted;
--   3. it keeps no stock, in the same way a purchase record keeps none: there
--      is no number to add to or take from.
--
-- Closing one writes down what it actually sold as what it received, so from
-- then on it reads as an ordinary lot that sold out, and lot costing, supplier
-- statements and the books need no special case for it ever again.
ALTER TABLE inventory_lots
  ADD COLUMN quantity_known TINYINT(1) NOT NULL DEFAULT 1 AFTER stock_tracked,
  ADD COLUMN closed_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN closed_by BIGINT UNSIGNED NULL,
  ADD COLUMN closed_reason VARCHAR(255) NULL;

-- The code a counter can type. It was "while something is left"; it is now
-- "while something is left, or while an open lot has not been closed".
-- A stored generated column cannot be changed in place, and the unique key
-- rests on it, so both come apart and go back together.
ALTER TABLE inventory_lots DROP INDEX uq_inventory_lots_active_tag;
ALTER TABLE inventory_lots DROP COLUMN active_lot_tag;
ALTER TABLE inventory_lots
  ADD COLUMN active_lot_tag VARCHAR(24) GENERATED ALWAYS AS (
    CASE
      WHEN quantity_known = 0 THEN (CASE WHEN closed_at IS NULL THEN UPPER(lot_tag) ELSE NULL END)
      WHEN COALESCE(remaining_handling_quantity, 0) > 0.0005
        OR COALESCE(remaining_base_quantity, 0) > 0.0005
      THEN UPPER(lot_tag)
      ELSE NULL
    END
  ) STORED;
ALTER TABLE inventory_lots
  ADD UNIQUE KEY uq_inventory_lots_active_tag (loc_code, active_lot_tag);

-- A delivery note already said whether it keeps stock. It now also says whether
-- anybody counted what arrived.
ALTER TABLE goods_receipts
  MODIFY COLUMN stock_mode ENUM('stock_receipt','purchase_record','open_lot') NOT NULL DEFAULT 'stock_receipt';

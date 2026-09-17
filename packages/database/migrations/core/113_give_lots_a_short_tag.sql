-- A short, memorable handle for a lot, and a way to say "no lot".
--
-- `lot_code` (SS-DDEC-A-2-6-20260824-3-1) is the lot's permanent identity: every
-- allocation, cost and supplier statement points at the lot itself, and it never
-- changes. It is also far too long for a cashier to type at the counter.
--
-- `lot_tag` is the human handle: KAR1, KAR2, BO1102. It is suggested when the
-- lot is received (the item's own code plus a running number), can be renamed by
-- whoever receives goods, and is only ever used to find a lot. Renaming one can
-- never orphan an old bill line, because lines store the lot, not the text.
--
-- A tag only has to be unique among lots that still hold stock at a location, so
-- a sold-out lot releases its tag for another day. `active_lot_tag` is NULL once
-- the lot is empty, and MySQL allows any number of NULLs in a unique key.
--
-- `unmatched` on a bill line records that the cashier's typed code matched no
-- lot. Such a line deliberately consumes no stock: it is left to be resolved
-- through the existing allocation exceptions, rather than silently eating the
-- oldest lot.

ALTER TABLE inventory_lots
  ADD COLUMN lot_tag VARCHAR(24) NULL AFTER lot_code,
  ADD COLUMN active_lot_tag VARCHAR(24) GENERATED ALWAYS AS (
    CASE
      WHEN COALESCE(remaining_handling_quantity, 0) > 0.0005
        OR COALESCE(remaining_base_quantity, 0) > 0.0005
      THEN UPPER(lot_tag)
      ELSE NULL
    END
  ) STORED;

-- Existing lots get the same shape of tag they would be given today.
UPDATE inventory_lots l
JOIN (
  SELECT il.id,
         CONCAT(
           UPPER(REGEXP_REPLACE(COALESCE(p.sku, 'LOT'), '[^A-Za-z0-9]', '')),
           ROW_NUMBER() OVER (PARTITION BY il.loc_code, il.product_id ORDER BY il.txn_date, il.id)
         ) AS tag
  FROM inventory_lots il
  JOIN products p ON p.id = il.product_id
) numbered ON numbered.id = l.id
SET l.lot_tag = numbered.tag
WHERE l.lot_tag IS NULL;

ALTER TABLE inventory_lots
  ADD UNIQUE KEY uq_inventory_lots_active_tag (loc_code, active_lot_tag);

ALTER TABLE invoice_items
  MODIFY COLUMN allocation_priority_source ENUM('automatic', 'remembered', 'manual', 'tag', 'unmatched') NULL;

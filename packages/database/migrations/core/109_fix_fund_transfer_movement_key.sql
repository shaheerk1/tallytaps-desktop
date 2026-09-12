-- A transfer has two sides, and both are the same document.
--
-- Migration 097 made derived fund movements idempotent with a unique key on
-- (source_type, source_id), so a rebuild could not insert the same movement
-- twice. A fund transfer writes two movements under one transfer number --
-- money out of one fund, money into the other -- so the second side hit that
-- key and the transfer failed. It only ever worked when one side was a till,
-- because a till's side is a cash movement instead.
--
-- The two sides already differ by `entry_no` (1 = out, 2 = in), which is part
-- of the ledger's own origin key, so adding it keeps every movement inserted
-- exactly once while letting both sides of a transfer exist.

ALTER TABLE fund_movements
  DROP INDEX uq_fund_movements_source,
  ADD UNIQUE KEY uq_fund_movements_source (source_type, source_id, entry_no);

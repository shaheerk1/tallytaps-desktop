-- A source event may feed at most one named fund movement. NULL source values
-- remain valid for old/manual rows because MySQL permits multiple NULLs in a
-- unique index.
ALTER TABLE fund_movements
  ADD UNIQUE KEY uq_fund_movements_source (source_type, source_id);

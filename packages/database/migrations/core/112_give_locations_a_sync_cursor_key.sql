-- The archive collector pages every stream by (cloud_sync_updated_at, id).
--
-- `pos_locations` is keyed by its code, so it arrived without an `id` and the
-- collector's cursor query failed with "Unknown column 't.id'" the moment the
-- location stream was reached -- which stops the whole sync run, not just that
-- stream. The cursor is a BIGINT, so a code cannot stand in for it.
--
-- A surrogate key fixes it without disturbing anything: `loc_code` remains the
-- primary key and the value sent to the host, and the new column exists only so
-- the collector has something monotonic to page on.

ALTER TABLE pos_locations
  ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT FIRST,
  ADD UNIQUE KEY uq_pos_locations_id (id);

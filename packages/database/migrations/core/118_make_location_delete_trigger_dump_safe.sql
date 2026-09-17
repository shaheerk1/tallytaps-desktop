-- Recreate the "a location is never deleted" trigger so the database can be
-- backed up and restored.
--
-- Migration 104 wrote this trigger as a single statement with no BEGIN...END.
-- Sent through the migration runner, MySQL stored its body with the trailing
-- semicolon: `SIGNAL ... stays taken.';`. mysqldump then writes it as
-- `... stays taken.'; */;;`, which MySQL cannot parse when the dump is loaded.
-- The restore stops at that line, so every table dumped after pos_locations
-- was silently missing from any backup taken since 104.
--
-- Every other trigger uses BEGIN...END, which stores cleanly. Giving this one
-- the same shape fixes the dump without changing what the trigger does.

DROP TRIGGER IF EXISTS trg_pos_locations_never_deleted;

CREATE TRIGGER trg_pos_locations_never_deleted
BEFORE DELETE ON pos_locations
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A location code is never deleted. Retire the location instead so its code stays taken.';
END;

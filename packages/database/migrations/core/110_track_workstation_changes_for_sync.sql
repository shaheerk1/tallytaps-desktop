-- The monitor should name places, not print codes.
--
-- Locations and workstations now travel to the host with everything else, so a
-- phone can say "Khan Store - Counter 2" instead of "KST01/T1". Every synced
-- table carries `cloud_sync_updated_at`; pos_workstations predates that rule.

ALTER TABLE pos_workstations
  ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);

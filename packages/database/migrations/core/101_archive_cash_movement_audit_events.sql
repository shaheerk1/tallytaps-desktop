ALTER TABLE cash_movement_events
  ADD COLUMN cloud_sync_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) AFTER created_at;

CREATE INDEX idx_cash_movement_event_cloud_sync ON cash_movement_events (cloud_sync_updated_at, id);

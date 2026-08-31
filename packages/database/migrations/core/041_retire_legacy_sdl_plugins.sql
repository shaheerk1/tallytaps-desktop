-- SDL is core-owned. These former SDL packs are retained only as historical
-- plugin records so existing lifecycle/audit rows remain explainable.
INSERT INTO plugin_lifecycle_log (plugin_id, action, from_status, to_status, changed_by, note)
SELECT plugin_id, 'retire_legacy_sdl_plugin', status, 'disabled', 'system',
       'Retired: SDL configuration is now owned by Configuration Studio.'
FROM plugins
WHERE plugin_id IN ('billing-engine', 'ddec-plugin', 'supermarket-plugin')
  AND status <> 'disabled'
  AND NOT EXISTS (
    SELECT 1
    FROM plugin_lifecycle_log log
    WHERE log.plugin_id = plugins.plugin_id
      AND log.action = 'retire_legacy_sdl_plugin'
  );

UPDATE plugins
SET status = 'disabled',
    disabled_at = COALESCE(disabled_at, CURRENT_TIMESTAMP),
    updated_at = CURRENT_TIMESTAMP
WHERE plugin_id IN ('billing-engine', 'ddec-plugin', 'supermarket-plugin')
  AND status <> 'disabled';

-- RevflareKit 1.10.0 renamed two restore events (worker/lib/events.ts, normalizeEvent): closing the Apple sign-in sheet is
-- `restore_cancel` (was `restore_failed` with props.error = "user_cancelled"), a restore without purchases is
-- `restore_nothing_found` (was `restore_success` with props.entitlements = ""). Ingest renames events of older SDKs; this
-- renames the key events stored before. Old events next to one the app tracked itself under the new name (same install,
-- within 10 s: HeadsUp 1.2.6) are duplicates and deleted. Restore events are rare: the (app_id, name, ts) index keeps
-- this to a few rows per app.
DELETE FROM app_events
 WHERE app_id IN (SELECT id FROM apps) AND name = 'restore_failed' AND json_extract(props, '$.error') = 'user_cancelled'
   AND EXISTS (SELECT 1 FROM app_events x WHERE x.app_id = app_events.app_id AND x.install_id = app_events.install_id
               AND x.name = 'restore_cancel' AND x.ts BETWEEN app_events.ts - 10000 AND app_events.ts + 10000);
UPDATE app_events SET name = 'restore_cancel', props = json_remove(props, '$.error')
 WHERE app_id IN (SELECT id FROM apps) AND name = 'restore_failed' AND json_extract(props, '$.error') = 'user_cancelled';
DELETE FROM app_events
 WHERE app_id IN (SELECT id FROM apps) AND name = 'restore_success' AND json_extract(props, '$.entitlements') = ''
   AND EXISTS (SELECT 1 FROM app_events x WHERE x.app_id = app_events.app_id AND x.install_id = app_events.install_id
               AND x.name = 'restore_nothing_found' AND x.ts BETWEEN app_events.ts - 10000 AND app_events.ts + 10000);
UPDATE app_events SET name = 'restore_nothing_found', props = json_remove(props, '$.entitlements')
 WHERE app_id IN (SELECT id FROM apps) AND name = 'restore_success' AND json_extract(props, '$.entitlements') = '';
-- The per-name daily rollup of these four names, rebuilt from the stored events (UTC day of reception).
DELETE FROM app_event_counts
 WHERE app_id IN (SELECT id FROM apps) AND name IN ('restore_failed', 'restore_success', 'restore_cancel', 'restore_nothing_found');
INSERT INTO app_event_counts (app_id, day, name, count, test_count, last)
SELECT app_id, strftime('%Y-%m-%d', received_at / 1000, 'unixepoch'), name,
       SUM(environment = 'production'), SUM(environment <> 'production'), MAX(received_at)
  FROM app_events
 WHERE app_id IN (SELECT id FROM apps) AND name IN ('restore_failed', 'restore_success', 'restore_cancel', 'restore_nothing_found')
 GROUP BY app_id, strftime('%Y-%m-%d', received_at / 1000, 'unixepoch'), name;

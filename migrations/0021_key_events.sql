-- Key events stored exactly (docs/funnels.md#exact-key-events). Analytics Engine samples the events of an app at write
-- time; funnels, experiment exposures, insights and the digest read these events from here instead when the data covers
-- the range. Written by POST /sdk/v1/events after the response (worker/lib/key-events.ts), in addition to Analytics
-- Engine; one row per event, deduplicated by the client event id (SDK retries never double-write).
-- environment: production | sandbox | xcode (readers count production only unless includeTest). props: JSON text.
CREATE TABLE app_events (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  install_id TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  app_version TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  environment TEXT NOT NULL DEFAULT 'production',
  props TEXT NOT NULL DEFAULT '{}',
  placement TEXT NOT NULL DEFAULT '',
  offering TEXT NOT NULL DEFAULT '',
  product TEXT NOT NULL DEFAULT '',
  step TEXT NOT NULL DEFAULT '',
  screen TEXT NOT NULL DEFAULT '',
  variant TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (app_id, id)
) WITHOUT ROWID;
CREATE INDEX idx_app_events_name ON app_events(app_id, name, ts);
CREATE INDEX idx_app_events_install ON app_events(app_id, install_id, ts);

-- Per app and UTC day (of reception): key events stored and whether the day is incomplete (capped: 1 = the daily
-- cap of the app was reached, 2 = the daily background budget of the instance was used up, 3 = a store failed). Readers
-- fall back to Analytics Engine for ranges with incomplete days. Rows older than the retention of the app are deleted
-- with its events.
CREATE TABLE app_event_days (
  app_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  capped INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, day)
) WITHOUT ROWID;

-- Per app, UTC day of reception and event name: key events stored (the events page's counts, without scanning
-- app_events). Production builds in count, sandbox / Xcode builds in test_count; the app's test devices are not split
-- out (the default view subtracts their rows, read through idx_app_events_install). last: latest received_at.
-- Upserted at ingest (one row per distinct name per batch), pruned with app_event_days.
CREATE TABLE app_event_counts (
  app_id TEXT NOT NULL,
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  test_count INTEGER NOT NULL DEFAULT 0,
  last INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, day, name)
) WITHOUT ROWID;

-- apps.key_events: JSON { patterns: [{ p, at }], dailyCap, retentionDays } (NULL = no extra patterns, the default daily
-- cap (min(50,000, background writes a day / 6)), 180 days; a missing / null dailyCap is the default too).
-- apps.key_events_since: first UTC day whose key events are all stored (YYYY-MM-DD; NULL = none yet).
ALTER TABLE apps ADD COLUMN key_events TEXT;
ALTER TABLE apps ADD COLUMN key_events_since TEXT;

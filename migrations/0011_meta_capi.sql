-- Meta Ads (Facebook) integration: purchases go to the Meta Conversions API as app events, matched through the
-- identifiers RevflareKit reports per install (POST /sdk/v1/identifiers: Facebook SDK anonymous id, IDFA, IDFV, ATT
-- status, device info). See worker/lib/meta.ts and docs/meta-ads.md.

-- Per app settings. token: encrypted JSON blob (encryptJson), write-only. config: JSON { sendSandbox, sendWithoutAtt,
-- events: { <type>: { enabled, name } } } (defaults filled in by the code). Counters are kept incrementally so stats
-- never count the queue.
CREATE TABLE meta_integrations (
  app_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  dataset_id TEXT,
  token TEXT,
  test_event_code TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  sent_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER,
  last_error TEXT,
  backfilled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Latest identifiers of each install (upserted, latest wins), with the caller IP and user agent.
CREATE TABLE install_identifiers (
  app_id TEXT NOT NULL,
  install_id TEXT NOT NULL,
  fb_anon_id TEXT,
  idfa TEXT,
  idfv TEXT,
  att_status TEXT NOT NULL,
  bundle_id TEXT,
  app_version TEXT,
  app_build TEXT,
  os_version TEXT,
  device_model TEXT,
  locale TEXT,
  time_zone TEXT,
  extinfo TEXT,
  ip TEXT,
  user_agent TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, install_id)
);

-- Send queue: one row per transaction. status pending | sent | skipped | failed. waits: checks while waiting for the
-- install / its identifiers (backs off); attempts: delivery tries; solo: send alone (its batch was rejected).
-- Finished rows are deleted after 8 days (they only guard against queueing a transaction twice).
CREATE TABLE meta_events (
  app_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  waits INTEGER NOT NULL DEFAULT 0,
  solo INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, transaction_id)
);
CREATE INDEX idx_meta_events_due ON meta_events(next_attempt_at) WHERE status = 'pending';
CREATE INDEX idx_meta_events_app_status ON meta_events(app_id, status);
CREATE INDEX idx_meta_events_created ON meta_events(created_at);

-- Delivery log: the last 100 outcomes per app (trimmed on insert).
CREATE TABLE meta_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  event_type TEXT,
  event_name TEXT,
  event_id TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  response TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_meta_deliveries_app ON meta_deliveries(app_id, id);

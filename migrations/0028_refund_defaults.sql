-- Workspace defaults for refund requests (answers to Apple's CONSUMPTION_REQUEST): apps without their own
-- refund_settings row use them, so a new app answers from its first request. Same columns as refund_settings.
CREATE TABLE refund_defaults (
  workspace_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  consent_attested_at INTEGER,
  consent_attested_by TEXT,
  policy TEXT NOT NULL DEFAULT 'none',
  decline_after_days INTEGER,
  sample_content_provided INTEGER NOT NULL DEFAULT 0,
  consumption_percent REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Refund requests: answers to Apple's CONSUMPTION_REQUEST notifications through Send Consumption Information
-- (PUT /inApps/v2/transactions/consumption/{transactionId}), and prorated refunds in the ledger. See
-- worker/lib/refunds.ts and docs/refund-requests.md.

-- Prorated refunds: Apple's revocationPercentage (milliunits, 40000 = 40 %) of a refunded transaction. NULL with
-- refunded_at set = a full refund. Revenue keeps the part that was not refunded.
ALTER TABLE transactions ADD COLUMN refund_milli INTEGER;

-- A customer can withdraw their consent to share consumption data with Apple (default: consented, per the app's
-- attestation). 0 = their refund requests are never answered.
ALTER TABLE customers ADD COLUMN refund_data_consent INTEGER NOT NULL DEFAULT 1;

-- Per app settings. policy: none | decline_if_delivered_after_days | grant_prorated | grant_full.
-- consumption_percent: optional percentage (0-100) sent for non-subscription products, NULL = omitted.
CREATE TABLE refund_settings (
  app_id TEXT PRIMARY KEY,
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

-- One row per CONSUMPTION_REQUEST that reached Revflare's notification URL (also the log: the last 100 per app are
-- shown; finished rows are deleted after 180 days). status pending | sent | skipped | failed | expired.
-- due_at = received_at + 12 h (Apple's window). product_type / started_at come from the notification's transaction.
CREATE TABLE consumption_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  original_transaction_id TEXT,
  product_id TEXT,
  product_type TEXT,
  started_at INTEGER,
  environment TEXT NOT NULL,
  notification_uid TEXT NOT NULL,
  request_reason TEXT,
  received_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  request_body TEXT,
  http_status INTEGER,
  response TEXT,
  reason TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (app_id, notification_uid)
);
CREATE INDEX idx_consumption_due ON consumption_requests(next_attempt_at) WHERE status = 'pending';
CREATE INDEX idx_consumption_app ON consumption_requests(app_id, id);
CREATE INDEX idx_consumption_received ON consumption_requests(received_at);

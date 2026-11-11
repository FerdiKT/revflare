-- Workers Free plan budget for the Durable Object database (5M rows read, 100k rows written a day): fewer index writes
-- per sale, indexes for the incremental rollups and the forecast, no full-table scans in the sync queues.

-- Transactions: one (app, expiry) index serves incremental rollups and renewal rates; refunds per app.
CREATE INDEX idx_tx_app_expires ON transactions(app_id, expires_at);
DROP INDEX idx_tx_refunded;
CREATE INDEX idx_tx_app_refunded ON transactions(app_id, refunded_at) WHERE refunded_at IS NOT NULL;

-- Events: alerts count recent webhook events per app; nothing lists events per workspace.
DROP INDEX idx_events_ws_time;
CREATE INDEX idx_events_app_received ON events(app_id, received_at);

-- Imported history: read per app through the primary key.
DROP INDEX idx_external_ws;
ALTER TABLE apps ADD COLUMN external_until TEXT;
UPDATE apps SET external_until = (SELECT MAX(day) FROM external_metrics e WHERE e.app_id = apps.id);

-- Customers: new customers / new payers per day come from here; sandbox-only customers do not count.
ALTER TABLE customers ADD COLUMN sandbox INTEGER NOT NULL DEFAULT 0;
UPDATE customers SET sandbox = 1 WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = customers.id AND t.environment = 'Production');
CREATE INDEX idx_customers_app_seen ON customers(app_id, first_seen_at);

ALTER TABLE daily_metrics ADD COLUMN new_payers INTEGER NOT NULL DEFAULT 0;

-- Incremental rollups: the earliest day whose numbers may have changed.
ALTER TABLE rollup_queue ADD COLUMN from_day TEXT;

-- Workspace totals per day (sum of the apps' daily_metrics), kept in step by the rollups: whole-workspace reads read
-- one row a day instead of one per app and day.
CREATE TABLE workspace_daily (
  workspace_id TEXT NOT NULL,
  day TEXT NOT NULL,
  gross_usd REAL NOT NULL DEFAULT 0,
  proceeds_usd REAL NOT NULL DEFAULT 0,
  refunds_usd REAL NOT NULL DEFAULT 0,
  refunds INTEGER NOT NULL DEFAULT 0,
  new_subscriptions INTEGER NOT NULL DEFAULT 0,
  renewals INTEGER NOT NULL DEFAULT 0,
  one_time_purchases INTEGER NOT NULL DEFAULT 0,
  trials_started INTEGER NOT NULL DEFAULT 0,
  trial_conversions INTEGER NOT NULL DEFAULT 0,
  new_customers INTEGER NOT NULL DEFAULT 0,
  new_payers INTEGER NOT NULL DEFAULT 0,
  active_subscriptions INTEGER NOT NULL DEFAULT 0,
  active_trials INTEGER NOT NULL DEFAULT 0,
  mrr_usd REAL NOT NULL DEFAULT 0,
  mrr_proceeds_usd REAL NOT NULL DEFAULT 0,
  mrr_new REAL NOT NULL DEFAULT 0,
  mrr_expansion REAL NOT NULL DEFAULT 0,
  mrr_contraction REAL NOT NULL DEFAULT 0,
  mrr_churn REAL NOT NULL DEFAULT 0,
  mrr_reactivation REAL NOT NULL DEFAULT 0,
  churned_subscriptions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day)
);
CREATE INDEX idx_workspace_daily_gross ON workspace_daily(workspace_id, gross_usd);
INSERT INTO workspace_daily (workspace_id, day, gross_usd, proceeds_usd, refunds_usd, refunds, new_subscriptions, renewals, one_time_purchases, trials_started, trial_conversions, new_customers, new_payers, active_subscriptions, active_trials, mrr_usd, mrr_proceeds_usd, mrr_new, mrr_expansion, mrr_contraction, mrr_churn, mrr_reactivation, churned_subscriptions)
  SELECT workspace_id, day, SUM(gross_usd), SUM(proceeds_usd), SUM(refunds_usd), SUM(refunds), SUM(new_subscriptions), SUM(renewals), SUM(one_time_purchases), SUM(trials_started), SUM(trial_conversions), SUM(new_customers), SUM(new_payers), SUM(active_subscriptions), SUM(active_trials), SUM(mrr_usd), SUM(mrr_proceeds_usd), SUM(mrr_new), SUM(mrr_expansion), SUM(mrr_contraction), SUM(mrr_churn), SUM(mrr_reactivation), SUM(churned_subscriptions) FROM daily_metrics GROUP BY workspace_id, day;

-- Transaction History queue: filled by the ledger, so the sync never scans the transactions table.
INSERT OR IGNORE INTO pending_history (app_id, transaction_id, source, created_at)
  SELECT DISTINCT t.app_id, t.original_transaction_id, 'ledger', CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM transactions t
  WHERE t.source = 'apple' AND t.environment = 'Production'
    AND NOT EXISTS (SELECT 1 FROM apple_history_state h WHERE h.app_id = t.app_id AND h.original_transaction_id = t.original_transaction_id);

-- WidgetKit push token of the device (widget refresh pushes go to it, not to the alert token).
ALTER TABLE devices ADD COLUMN widget_token TEXT;

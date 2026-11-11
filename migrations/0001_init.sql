-- Revflare schema. All times are epoch milliseconds (UTC); days are 'YYYY-MM-DD' (UTC). Money: `*_milli` are store
-- amounts in thousandths of the currency unit (Apple's `price`), `*_usd` are US dollars converted at that day's rate.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Users, workspaces, access ------------------------------------------------------------------------------------

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  -- Instance admin: manages users and sees every workspace.
  is_admin INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Reporting currency shown in the apps (amounts are stored in USD and converted on read).
  currency TEXT NOT NULL DEFAULT 'USD',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- role: owner | admin | viewer (worker/lib/auth.ts)
CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_members_user ON workspace_members(user_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER
);

-- Web sessions (cookie) and device sessions (iOS app, bearer token). id = sha256 of the token.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'web',
  workspace_id TEXT,
  name TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Workspace API keys (CLI, MCP, Adsflare). hash = sha256 of the token.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- Short-lived codes shown as a QR code in the web app; the iOS app trades one for a device session.
CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- iOS devices (push). One row per APNs token.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT,
  name TEXT,
  apns_token TEXT NOT NULL UNIQUE,
  environment TEXT NOT NULL DEFAULT 'production',
  -- Live Activity push token ("today's revenue" in the Dynamic Island), if one is running.
  activity_token TEXT,
  -- JSON: { sales, refunds, renewals, trials, alerts, dailySummary, weeklySummary, minUsd, apps: [ids] | null, quietStart, quietEnd, timezone }
  prefs TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_push_at INTEGER
);
CREATE INDEX idx_devices_user ON devices(user_id);

-- Stores and apps ------------------------------------------------------------------------------------------------

-- Encrypted credentials: kind = appstore_iap (In-App Purchase key: App Store Server API), appstore_connect (API key:
-- apps, Sales and Trends reports), revenuecat (secret API key v2).
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  key_id TEXT,
  issuer_id TEXT,
  -- Extra non-secret settings (JSON), e.g. { vendorNumber } for appstore_connect.
  config TEXT NOT NULL DEFAULT '{}',
  secret TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_credentials_ws ON credentials(workspace_id, kind);

CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'ios',
  bundle_id TEXT,
  apple_app_id TEXT,
  icon_url TEXT,
  -- Secret path segment of the notification URL: /apple/notifications/<notification_key>
  notification_key TEXT NOT NULL UNIQUE,
  -- App Store commission: 15 (Small Business Program) or 30.
  commission_pct INTEGER NOT NULL DEFAULT 15,
  rc_project_id TEXT,
  -- Where Apple sends this app's notifications (from App Store Connect): revflare | other | none | unknown
  notification_url_status TEXT NOT NULL DEFAULT 'unknown',
  notification_url TEXT,
  last_notification_at INTEGER,
  last_history_sync_at INTEGER,
  -- Last signedDate pulled from Notification History (ms), per environment.
  history_synced_until INTEGER,
  -- Earliest day the Notification History backfill reached (YYYY-MM-DD), null until the first full backfill.
  history_backfilled_from TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_apps_bundle ON apps(workspace_id, bundle_id);

CREATE TABLE products (
  app_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  -- auto_renewable | non_consumable | consumable | non_renewing
  type TEXT,
  name TEXT,
  subscription_group TEXT,
  -- ISO 8601 period of one billing cycle (P1W, P1M, P2M, P3M, P6M, P1Y)
  period TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, product_id)
);

-- Customers: one per app account token, else per original transaction id (Apple has no stable customer id).
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  app_account_token TEXT,
  rc_app_user_id TEXT,
  country TEXT,
  first_seen_at INTEGER NOT NULL,
  first_paid_at INTEGER,
  last_seen_at INTEGER NOT NULL,
  total_usd REAL NOT NULL DEFAULT 0,
  total_proceeds_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_customers_app ON customers(app_id, first_paid_at);
CREATE UNIQUE INDEX idx_customers_token ON customers(app_id, app_account_token) WHERE app_account_token IS NOT NULL;

-- One row per store transaction (purchase, renewal, trial start...). The Apple transaction id is the identity:
-- the same sale coming from a notification, the Server API, RevenueCat or a report is stored once.
CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  customer_id TEXT,
  -- apple | revenuecat | manual
  source TEXT NOT NULL,
  store TEXT NOT NULL DEFAULT 'app_store',
  environment TEXT NOT NULL DEFAULT 'Production',
  transaction_id TEXT NOT NULL,
  original_transaction_id TEXT NOT NULL,
  web_order_line_item_id TEXT,
  product_id TEXT NOT NULL,
  product_type TEXT,
  -- trial | intro | purchase (first paid) | renewal | one_time | restore
  kind TEXT NOT NULL,
  offer_type INTEGER,
  offer_id TEXT,
  offer_discount_type TEXT,
  purchased_at INTEGER NOT NULL,
  original_purchased_at INTEGER,
  expires_at INTEGER,
  -- ISO period this transaction pays for (subscriptions)
  period TEXT,
  price_milli INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  country TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  gross_usd REAL NOT NULL DEFAULT 0,
  -- Estimated developer proceeds (VAT and commission removed); replaced by Apple's figure after reconciliation.
  proceeds_usd REAL NOT NULL DEFAULT 0,
  proceeds_reported INTEGER NOT NULL DEFAULT 0,
  refunded_at INTEGER,
  refund_reason INTEGER,
  revoked_at INTEGER,
  is_upgraded INTEGER NOT NULL DEFAULT 0,
  family_shared INTEGER NOT NULL DEFAULT 0,
  app_account_token TEXT,
  -- signedDate of the snapshot stored: older snapshots never overwrite newer ones.
  signed_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_tx_store_id ON transactions(app_id, transaction_id);
CREATE INDEX idx_tx_ws_time ON transactions(workspace_id, purchased_at);
CREATE INDEX idx_tx_app_time ON transactions(app_id, purchased_at);
CREATE INDEX idx_tx_original ON transactions(app_id, original_transaction_id);
CREATE INDEX idx_tx_customer ON transactions(customer_id);
CREATE INDEX idx_tx_refunded ON transactions(workspace_id, refunded_at) WHERE refunded_at IS NOT NULL;

-- Latest state of each subscription (one per original transaction id).
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  customer_id TEXT,
  environment TEXT NOT NULL DEFAULT 'Production',
  original_transaction_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  -- trial | active | grace | billing_retry | expired | revoked | refunded
  status TEXT NOT NULL,
  auto_renew INTEGER NOT NULL DEFAULT 1,
  auto_renew_product_id TEXT,
  -- Apple expiration intent when expired (1 cancelled, 2 billing error, 3 price increase, 4 unavailable, 5 other)
  expiration_reason INTEGER,
  started_at INTEGER NOT NULL,
  current_period_start INTEGER,
  expires_at INTEGER,
  grace_expires_at INTEGER,
  period TEXT,
  price_milli INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  country TEXT,
  -- Monthly recurring revenue of the current price (0 while in trial).
  mrr_usd REAL NOT NULL DEFAULT 0,
  renewal_price_usd REAL,
  last_event_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_subs_original ON subscriptions(app_id, original_transaction_id);
CREATE INDEX idx_subs_ws_status ON subscriptions(workspace_id, status, expires_at);

-- Every notification or imported event (feed). The raw payload is kept in R2 (r2_key).
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  -- Apple notificationUUID (or a synthetic id for imports): Apple retries, we store once.
  uid TEXT NOT NULL,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  subtype TEXT,
  environment TEXT NOT NULL DEFAULT 'Production',
  transaction_id TEXT,
  original_transaction_id TEXT,
  product_id TEXT,
  country TEXT,
  amount_usd REAL,
  signed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  r2_key TEXT
);
CREATE UNIQUE INDEX idx_events_uid ON events(app_id, uid);
CREATE INDEX idx_events_ws_time ON events(workspace_id, signed_at);

-- Money ------------------------------------------------------------------------------------------------------------

-- Units of `currency` per 1 USD on `day`.
CREATE TABLE fx_rates (
  day TEXT NOT NULL,
  currency TEXT NOT NULL,
  per_usd REAL NOT NULL,
  PRIMARY KEY (day, currency)
);

-- Metrics ------------------------------------------------------------------------------------------------------------

-- Per app and UTC day, rebuilt from transactions by worker/lib/rollup.ts (rollup_queue lists apps to rebuild).
CREATE TABLE daily_metrics (
  app_id TEXT NOT NULL,
  day TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
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
  -- End-of-day state
  active_subscriptions INTEGER NOT NULL DEFAULT 0,
  active_trials INTEGER NOT NULL DEFAULT 0,
  mrr_usd REAL NOT NULL DEFAULT 0,
  mrr_proceeds_usd REAL NOT NULL DEFAULT 0,
  -- MRR movement during the day
  mrr_new REAL NOT NULL DEFAULT 0,
  mrr_expansion REAL NOT NULL DEFAULT 0,
  mrr_contraction REAL NOT NULL DEFAULT 0,
  mrr_churn REAL NOT NULL DEFAULT 0,
  mrr_reactivation REAL NOT NULL DEFAULT 0,
  churned_subscriptions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, day)
);
CREATE INDEX idx_daily_ws ON daily_metrics(workspace_id, day);

CREATE TABLE rollup_queue (
  app_id TEXT PRIMARY KEY,
  queued_at INTEGER NOT NULL
);

-- Historical series imported from elsewhere (RevenueCat Charts) for the time before Revflare has transactions.
CREATE TABLE external_metrics (
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  source TEXT NOT NULL,
  metric TEXT NOT NULL,
  day TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (app_id, source, metric, day)
);
CREATE INDEX idx_external_ws ON external_metrics(workspace_id, metric, day);

-- Apple Sales and Trends (daily summary) rows, aggregated per app/product/country/day (reconciliation).
CREATE TABLE sales_reports (
  workspace_id TEXT NOT NULL,
  app_id TEXT,
  day TEXT NOT NULL,
  sku TEXT NOT NULL,
  apple_id TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL,
  product_type TEXT NOT NULL DEFAULT '',
  units INTEGER NOT NULL,
  proceeds_usd REAL NOT NULL,
  customer_price_usd REAL NOT NULL,
  PRIMARY KEY (workspace_id, day, sku, country, product_type)
);
CREATE INDEX idx_sales_app_day ON sales_reports(app_id, day);

-- Goals, jobs, alerts ------------------------------------------------------------------------------------------------

-- metric: revenue | proceeds | mrr; period: month
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  period TEXT NOT NULL DEFAULT 'month',
  target_usd REAL NOT NULL,
  app_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Imports and backfills: kind = apple_history | apple_transactions | revenuecat_api | revenuecat_charts | sales_reports
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  -- queued | running | done | failed | cancelled
  status TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  progress TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_jobs_ws ON jobs(workspace_id, created_at);

-- Raised alerts (deduplicated by key per workspace), shown in the apps and pushed once.
CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  app_id TEXT,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE UNIQUE INDEX idx_alerts_key ON alerts(workspace_id, key);

-- App Store Server API "Get Transaction History" progress per customer (original transaction id).
CREATE TABLE apple_history_state (
  app_id TEXT NOT NULL,
  original_transaction_id TEXT NOT NULL,
  revision TEXT,
  status_checked_at INTEGER,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, original_transaction_id)
);

-- Transaction ids found elsewhere (RevenueCat) waiting for Apple's Get Transaction History.
CREATE TABLE pending_history (
  app_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, transaction_id)
);

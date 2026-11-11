-- Apple Ads attribution through RevflareKit (the in-app Swift package): each install sends its AdServices token and
-- the original transaction ids it sees; Revflare asks Apple which campaign / ad group / keyword brought the install
-- and joins revenue to it.

-- Public key the app embeds to talk to /sdk/v1 (identifies the app, not a secret).
ALTER TABLE apps ADD COLUMN sdk_key TEXT;
UPDATE apps SET sdk_key = 'rfp_' || lower(hex(randomblob(16))) WHERE sdk_key IS NULL;
CREATE UNIQUE INDEX idx_apps_sdk_key ON apps(sdk_key);

-- One row per install (install_id: a UUID the SDK keeps in the keychain; also usable as appAccountToken).
-- status: pending (token not resolved yet) | resolved | failed
CREATE TABLE attributions (
  app_id TEXT NOT NULL,
  install_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  token TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attributed INTEGER NOT NULL DEFAULT 0,
  org_id TEXT,
  campaign_id TEXT,
  ad_group_id TEXT,
  keyword_id TEXT,
  ad_id TEXT,
  country TEXT,
  click_date TEXT,
  conversion_type TEXT,
  claim_type TEXT,
  app_version TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  PRIMARY KEY (app_id, install_id)
);
CREATE INDEX idx_attributions_pending ON attributions(status, updated_at) WHERE status = 'pending';
CREATE INDEX idx_attributions_ws_time ON attributions(workspace_id, created_at) WHERE attributed = 1;

-- Which install made which subscription / purchase (original transaction id).
CREATE TABLE install_links (
  app_id TEXT NOT NULL,
  original_transaction_id TEXT NOT NULL,
  install_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, original_transaction_id)
);
CREATE INDEX idx_install_links_install ON install_links(app_id, install_id);

-- Purchases made with appAccountToken = install id link themselves.
INSERT OR IGNORE INTO install_links (app_id, original_transaction_id, install_id, created_at)
  SELECT app_id, original_transaction_id, lower(app_account_token), CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM transactions WHERE app_account_token IS NOT NULL;

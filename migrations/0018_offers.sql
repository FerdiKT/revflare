-- Promotional offers (worker/lib/offers.ts, docs/offers.md).
-- offer_settings: one row per app. offers: JSON [{ productId, offerId, label, kind: "promotional" | "win_back" }]
-- (only promotional entries are signed, win-back entries only label redemptions). strict = 1: sign only for installs
-- linked to a subscription of the product group.
CREATE TABLE offer_settings (
  app_id TEXT PRIMARY KEY,
  offers TEXT NOT NULL DEFAULT '[]',
  strict INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Log of POST /sdk/v1/offers/sign answers, the last ~1000 per app (seq: per app, trimmed every 50 rows).
-- status: signed | not_allowed | not_configured | not_subscribed. Refusals are sampled: count = answers the row stands for.
CREATE TABLE offer_signatures (
  app_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  install_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (app_id, seq)
);

-- Lapsed subscribers of an app (status + expiry window).
CREATE INDEX idx_subs_app_status ON subscriptions(app_id, status, expires_at);

-- Promotional and win-back redemptions per app (offer stats read only these rows).
CREATE INDEX idx_tx_app_offer ON transactions(app_id, purchased_at) WHERE offer_type IN (2, 4);

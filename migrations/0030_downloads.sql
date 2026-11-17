-- App Store downloads from Apple's Sales and Trends daily summary reports (worker/apple/sales.ts, read by
-- worker/lib/downloads.ts). One row per report day (Apple's, Pacific time), app, country, device, kind and price.
-- apple_id: the app's Apple ID (apps not added to Revflare count in the workspace totals; app_id NULL).
-- kind: first (Product Type 1* / F1) | redownload (3* / F3) | update (7* / F7); paid: 1 when the customer paid for
-- the download (paid app). units: Apple's units (refunds are negative). device: iPhone | iPad | Mac | Apple TV...
CREATE TABLE downloads_daily (
  workspace_id TEXT NOT NULL,
  day TEXT NOT NULL,
  apple_id TEXT NOT NULL,
  app_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0,
  units INTEGER NOT NULL,
  proceeds_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day, apple_id, country, device, kind, paid)
);
CREATE INDEX idx_downloads_app_day ON downloads_daily(app_id, day);

-- Days imported before downloads were kept ("ok") are downloaded again (now "ok2").

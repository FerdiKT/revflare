-- App Store acquisition from the App Analytics reports (Analytics Reports API): impressions, product page views,
-- downloads and purchases per app, day, source type, referrer and campaign token. See worker/apple/analytics.ts.

-- One ONGOING report request per app. state: requested | producing | stopped | failed
-- reports: JSON { "<report kind>": "<Apple report id>" } (kinds in worker/apple/analytics.ts)
CREATE TABLE acquisition_requests (
  app_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  request_id TEXT,
  state TEXT NOT NULL,
  error TEXT,
  reports TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  checked_at INTEGER
);
CREATE INDEX idx_acquisition_requests_ws ON acquisition_requests(workspace_id);

-- Report instances already imported (or skipped), so each is downloaded once.
CREATE TABLE acquisition_instances (
  instance_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  report TEXT NOT NULL,
  processing_date TEXT NOT NULL,
  rows INTEGER NOT NULL DEFAULT 0,
  imported_at INTEGER NOT NULL
);
CREATE INDEX idx_acquisition_instances_app ON acquisition_instances(app_id, report, processing_date);

-- Aggregated daily rows. report: engagement | downloads | purchases; detailed: 0 = the Standard report (complete,
-- by source type; source_info and campaign are empty), 1 = the Detailed report (referrer and campaign, privacy thresholds).
-- A newer instance replaces the rows of an app for the days it contains (per report).
CREATE TABLE acquisition_daily (
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  day TEXT NOT NULL,
  report TEXT NOT NULL,
  detailed INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  source_info TEXT NOT NULL DEFAULT '',
  campaign TEXT NOT NULL DEFAULT '',
  impressions INTEGER NOT NULL DEFAULT 0,
  impressions_unique INTEGER NOT NULL DEFAULT 0,
  page_views INTEGER NOT NULL DEFAULT 0,
  page_views_unique INTEGER NOT NULL DEFAULT 0,
  downloads INTEGER NOT NULL DEFAULT 0,
  redownloads INTEGER NOT NULL DEFAULT 0,
  purchases INTEGER NOT NULL DEFAULT 0,
  proceeds_usd REAL NOT NULL DEFAULT 0,
  sales_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, report, detailed, day, source_type, source_info, campaign)
);
CREATE INDEX idx_acquisition_daily_ws ON acquisition_daily(workspace_id, detailed, day);
CREATE INDEX idx_acquisition_daily_campaign ON acquisition_daily(workspace_id, campaign) WHERE campaign != '';

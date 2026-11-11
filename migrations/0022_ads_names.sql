-- Apple Ads names and test attribution (docs/api.md#apple-ads-names).
-- ads_names: campaign / ad group / keyword names per workspace, filled by PUT /attribution/names (Adsflare, CLI, web
-- import). Reads join it by primary key wherever Apple Ads ids are shown; ids without a name show as "#<id>".
CREATE TABLE ads_names (
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, kind, id)
) WITHOUT ROWID;

-- attributions.test_attribution: 1 when Apple answered its AdServices test payload (campaign / ad group / org id
-- 1234567890, keyword 12323222: development and TestFlight builds). Left out of attributed revenue, coverage, LTV and
-- Meta sending unless a read asks for test data; remote config still sees such installs as apple_ads.
ALTER TABLE attributions ADD COLUMN test_attribution INTEGER NOT NULL DEFAULT 0;
UPDATE attributions SET test_attribution = 1 WHERE campaign_id = '1234567890';

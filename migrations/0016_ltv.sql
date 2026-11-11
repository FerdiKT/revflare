-- LTV by acquisition source (worker/lib/ltv.ts): installs are read by workspace and install time, organic ones too.
-- The full index replaces the partial idx_attributions_ws_time (attributed installs only), which it subsumes.
-- Organic installs have no Apple country: the country of the install's first report (Cloudflare's request.cf.country)
-- is kept apart from Apple's countryOrRegion. installed_at: the install time RevflareKit persisted on the device (its
-- first launch), when it sent one; the first report (created_at) otherwise.
ALTER TABLE attributions ADD COLUMN install_country TEXT;
ALTER TABLE attributions ADD COLUMN installed_at INTEGER;
DROP INDEX IF EXISTS idx_attributions_ws_time;
CREATE INDEX idx_attributions_ws_created ON attributions(workspace_id, created_at);

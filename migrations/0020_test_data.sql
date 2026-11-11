-- Debug vs production data (docs/funnels.md#test-data, docs/ltv.md).
-- attributions.environment: the build RevflareKit reported from on the install's first report: production (App Store),
-- sandbox (TestFlight / development build against the sandbox) or xcode (StoreKit configuration file). NULL: reported
-- before RevflareKit sent it (counted as production). LTV, attributed revenue, coverage and Meta sending count only
-- production installs.
ALTER TABLE attributions ADD COLUMN environment TEXT;

-- Per app: install ids of test devices (JSON list of at most 50 lowercase UUIDs), left out of events, funnels,
-- experiments, LTV and attribution like sandbox data.
ALTER TABLE apps ADD COLUMN test_installs TEXT;

-- Promotional offer signature log: the environment of the request (sandbox and xcode installs may sign too).
ALTER TABLE offer_signatures ADD COLUMN environment TEXT;

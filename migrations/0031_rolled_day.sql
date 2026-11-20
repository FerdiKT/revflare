-- The last UTC day an app's daily_metrics were rebuilt for (worker/lib/rollup.ts rebuildApp). Until every app of a
-- scope is rolled for the new day (the nightly queue at 00:10 UTC, worker/lib/cron.ts), reads take MRR, active
-- subscriptions and trials from the last complete day (worker/lib/metrics.ts stocksAsOf) instead of a missing or
-- partial row. Existing apps are up to date when this runs.
ALTER TABLE apps ADD COLUMN rolled_day TEXT;
UPDATE apps SET rolled_day = date('now') WHERE archived = 0;

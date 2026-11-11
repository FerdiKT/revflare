-- A/B experiments on remote config (worker/lib/experiments.ts, docs/experiments.md).
-- definition: JSON { keys, types: { key: type }, variants: [{ id, name, weight, values }], targeting, traffic, primaryMetric }.
-- status: draft | running | stopped | rolled_out | archived. Running and stopped experiments are compiled into the
-- app's remote config payload (remote_configs.sdk_json): devices keep their assignment until rollout / archive.
-- results: the last computed ExperimentResults JSON (results_at: when); frozen = 1: computed after the stop (final).
-- snapshot_day: UTC day of the last daily exposure snapshot (experiment_daily).
CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  name TEXT NOT NULL,
  hypothesis TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  definition TEXT NOT NULL,
  started_at INTEGER,
  stopped_at INTEGER,
  rolled_out_variant TEXT,
  results TEXT,
  results_at INTEGER,
  frozen INTEGER NOT NULL DEFAULT 0,
  snapshot_day TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_experiments_app ON experiments(app_id, status);
CREATE INDEX idx_experiments_status ON experiments(status, started_at);

-- Exposed installs per variant and UTC day (count of distinct installs that sent experiment_exposure), from the daily
-- cron snapshot: Analytics Engine keeps events 3 months. sample_interval: Analytics Engine's sampling that day (the
-- count is scaled by it; > 1 means approximate).
CREATE TABLE experiment_daily (
  experiment_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  day TEXT NOT NULL,
  exposed INTEGER NOT NULL,
  sample_interval INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (experiment_id, day, variant)
);

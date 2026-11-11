-- Detailed goals (worker/lib/goals.ts): a name, an app scope, more metrics and periods, archive, manual order and a
-- push when reached.
-- metric: revenue | proceeds | mrr | new_subscriptions | trials_started | active_subscriptions | sales (target_usd holds
-- the count for count metrics). period: week (Monday-based) | month | quarter | year | custom (start_day..end_day).
-- scope: all | include (the app_ids JSON list) | exclude (every app of the workspace but app_ids, apps added later count).
-- app_id stays for older code: the single app of an include scope, else NULL.
ALTER TABLE goals ADD COLUMN name TEXT;
ALTER TABLE goals ADD COLUMN scope TEXT NOT NULL DEFAULT 'all';
ALTER TABLE goals ADD COLUMN app_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE goals ADD COLUMN start_day TEXT;
ALTER TABLE goals ADD COLUMN end_day TEXT;
ALTER TABLE goals ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE goals ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE goals ADD COLUMN notify INTEGER NOT NULL DEFAULT 0;
-- First day of the period whose "goal reached" push was sent (once per period).
ALTER TABLE goals ADD COLUMN notified_period TEXT;

-- Existing goals: one app becomes an include scope with that app; the order follows creation.
UPDATE goals SET scope = 'include', app_ids = json_array(app_id) WHERE app_id IS NOT NULL AND scope = 'all';
UPDATE goals SET sort_order = (SELECT COUNT(*) FROM goals g WHERE g.workspace_id = goals.workspace_id AND (g.created_at < goals.created_at OR (g.created_at = goals.created_at AND g.id < goals.id)));

CREATE INDEX idx_goals_workspace ON goals(workspace_id, sort_order);
CREATE INDEX idx_goals_notify ON goals(notify) WHERE notify = 1;

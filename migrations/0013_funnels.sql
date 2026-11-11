-- Funnels over RevflareKit app events (the events themselves live in Workers Analytics Engine, never here).
-- definition: JSON { steps: [{ type: "event", name, filters?: [{ key, value }], label? } | { type: "revenue", kind, label? }],
-- windowSeconds, ordered } (validated by worker/lib/funnels.ts). A few rows per app.
CREATE TABLE funnels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_funnels_app ON funnels(app_id, created_at);
CREATE INDEX idx_funnels_ws ON funnels(workspace_id);

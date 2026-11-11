-- Funnel alerts and the daily digest (worker/lib/insights.ts, docs/funnels.md#alerts).
-- funnels.alerts: JSON { enabled, sensitivity: "high" | "normal" | "low" }; NULL = enabled, normal.
-- funnels.alerts_checked: UTC day (YYYY-MM-DD) of the last daily anomaly / regression check (one write per funnel a day).
-- users.daily_digest_email: 1 = the user wants the daily digest by email (only sent when Email Sending is configured).
ALTER TABLE funnels ADD COLUMN alerts TEXT;
ALTER TABLE funnels ADD COLUMN alerts_checked TEXT;
ALTER TABLE users ADD COLUMN daily_digest_email INTEGER NOT NULL DEFAULT 0;

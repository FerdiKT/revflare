-- Remote config (like Firebase Remote Config): one row per app holding the whole config as JSON (validated by
-- worker/lib/remote-config.ts): an edit is one row read and one row written, a PUT replaces it atomically.
-- config: JSON { conditions: [{ name, color?, rules: [...], unsupported?, expression? }], parameters: [{ key, type,
-- description?, defaultValue? | useInAppDefault, conditionalValues: { condition: value | { useInAppDefault: true } } }] }.
-- sdk_json: the compiled form GET /sdk/v1/config evaluates per device in the Worker (cached, no read per request);
-- version: short hash of config.
CREATE TABLE remote_configs (
  app_id TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  sdk_json TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

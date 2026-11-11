-- Offerings and placements (paywalls configured remotely, like RevenueCat offerings). One row per app holding the
-- whole config as JSON (validated by worker/lib/offerings.ts): an edit is one row read and one row written, a PUT
-- replaces it atomically, and the RevflareKit endpoint GET /sdk/v1/offerings serves the prebuilt `sdk_json` (with `version`, a
-- short hash of it) without building anything.
-- config: JSON { currentOfferingId, offerings: [{ identifier, displayName, metadata, packages: [{ identifier,
-- productId, metadata }], createdAt, updatedAt }], placements: [{ identifier, offeringId }] }.
CREATE TABLE offering_configs (
  app_id TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  sdk_json TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

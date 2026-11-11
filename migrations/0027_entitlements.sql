-- Server-driven entitlements and non-renewing durations (RevflareKit 1.9+, docs/api.md#entitlements). Stored next to
-- the offerings of the app (one row per app): RevflareKit gets them inside GET /sdk/v1/offerings (the prebuilt `sdk_json`),
-- so the SDK read stays one cached row. entitlements: JSON { entitlements: { name: [productId] }, durations:
-- { productId: { unit: day | week | month | year, count } } }; NULL = none set.
ALTER TABLE offering_configs ADD COLUMN entitlements TEXT;
-- One-time transactions by product (a duration set or changed later recomputes the expiry of the stored
-- passes of the product: one index seek). Partial: subscription sales, the bulk of the writes, get no index row.
CREATE INDEX idx_tx_app_product_onetime ON transactions(app_id, product_id) WHERE product_type != 'auto_renewable';

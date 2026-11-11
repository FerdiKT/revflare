-- Google Play (Android) revenue (worker/google/, docs/google-play.md). Android apps are apps rows with platform =
-- 'android' and bundle_id = the package name; their sales are transactions with store = 'play_store' and source =
-- 'google_play' (transaction_id = Play order id, original_transaction_id = the base order id without "..N").
-- Credentials: kind google_play = a Google Cloud service-account JSON key (key_id = private_key_id, issuer_id =
-- client_email, config { projectId, clientEmail }, secret { privateKey }), encrypted like the others.
-- Real-time developer notifications (RTDN) arrive through a Pub/Sub push subscription at
-- POST /google/rtdn/<notification_key> (the same secret path segment Apple's URL uses).

-- Service account Pub/Sub signs its push requests with (OIDC token): when set, the token is verified (401 otherwise).
ALTER TABLE apps ADD COLUMN google_push_account TEXT;
-- Optional credentials row the app uses (several Play developer accounts in one workspace); NULL = the newest google_play key.
ALTER TABLE apps ADD COLUMN google_credential_id TEXT;
-- Last daily voided purchases poll (ms) and the last setup check: JSON { at, ok, error? }.
ALTER TABLE apps ADD COLUMN google_voided_checked_at INTEGER;
ALTER TABLE apps ADD COLUMN google_check TEXT;

-- Play purchase token of each subscription (renewals keep the token; upgrades / downgrades get a new one that
-- links to the old one through linkedPurchaseToken). RevflareKit can report purchase tokens to link installs.
ALTER TABLE subscriptions ADD COLUMN purchase_token TEXT;
CREATE INDEX idx_subs_purchase_token ON subscriptions(app_id, purchase_token) WHERE purchase_token IS NOT NULL;
-- Why a subscription was cancelled (Google Play canceledStateContext): user[:<survey reason>] | system | developer | replacement.
ALTER TABLE subscriptions ADD COLUMN cancel_reason TEXT;

-- Android installs: the Play Install Referrer RevflareKit reports (utm parameters, gclid) and the source derived from
-- it: google_ads (gclid), referral (a utm_source other than Play's organic "google-play"), organic. NULL for iOS installs.
ALTER TABLE attributions ADD COLUMN referrer_source TEXT;
ALTER TABLE attributions ADD COLUMN utm_source TEXT;
ALTER TABLE attributions ADD COLUMN utm_medium TEXT;
ALTER TABLE attributions ADD COLUMN utm_campaign TEXT;
ALTER TABLE attributions ADD COLUMN gclid TEXT;
ALTER TABLE attributions ADD COLUMN referrer_click_at INTEGER;

-- An Android app usually has the same package name as its iOS app's bundle id: bundle ids are unique per platform.
DROP INDEX idx_apps_bundle;
CREATE UNIQUE INDEX idx_apps_bundle ON apps(workspace_id, bundle_id, platform);

-- Cancellations in the transactions feed (GET /transactions?cancellations=true, docs/api.md#transactions): auto-renew
-- turned off (App Store DID_CHANGE_RENEWAL_STATUS / AUTO_RENEW_DISABLED, Google Play SUBSCRIPTION_CANCELED), read by
-- workspace and time. Partial index: only cancellation events get an index row, a sale writes nothing more.
CREATE INDEX idx_events_cancel ON events(workspace_id, signed_at) WHERE (type = 'DID_CHANGE_RENEWAL_STATUS' AND subtype = 'AUTO_RENEW_DISABLED') OR type = 'SUBSCRIPTION_CANCELED';
-- The same events by subscription: when auto-renew was turned off within a purchase period (feed rows cancelledAfterMs,
-- customer timing) is one index seek, whatever the length of the subscription history.
CREATE INDEX idx_events_cancel_original ON events(app_id, original_transaction_id, signed_at) WHERE (type = 'DID_CHANGE_RENEWAL_STATUS' AND subtype = 'AUTO_RENEW_DISABLED') OR type = 'SUBSCRIPTION_CANCELED';

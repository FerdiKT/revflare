-- Customer history (GET /customers/:id `events`, docs/api.md#customers): Apple notifications of a customer's
-- subscriptions and purchases are read by original transaction id, and the date auto-renew was turned off
-- (`autoRenewOffAt`). One more index row per stored event.
CREATE INDEX idx_events_original ON events(app_id, original_transaction_id);

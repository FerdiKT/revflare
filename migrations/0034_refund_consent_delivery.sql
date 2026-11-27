-- Refund requests (worker/lib/refunds.ts): consent recorded in the app and confirmed delivery.
--
-- refund_consents: the customer choice made in the app (RevflareKit Revflare.setRefundDataConsent), per original
-- transaction the device holds (sent with the install report, so a consent given on another device of the same Apple
-- Account covers the purchases that device sees). consent 1 = share consumption data with Apple, 0 = do not.
CREATE TABLE refund_consents (
  app_id TEXT NOT NULL,
  original_transaction_id TEXT NOT NULL,
  install_id TEXT NOT NULL,
  consent INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, original_transaction_id)
) WITHOUT ROWID;

-- purchase_deliveries: purchases RevflareKit RevflareStore reported as delivered (the purchase gave the customer
-- access on the device). deliveryStatus DELIVERED is only sent for these.
CREATE TABLE purchase_deliveries (
  app_id TEXT NOT NULL,
  original_transaction_id TEXT NOT NULL,
  install_id TEXT NOT NULL,
  delivered_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, original_transaction_id)
) WITHOUT ROWID;

-- Whose consent counts: in_app (default) = only customers who agreed in the app (refund_consents); attested = every
-- customer, on the developer attestation that consent was obtained another way (terms of the app), unless withdrawn.
ALTER TABLE refund_settings ADD COLUMN consent_source TEXT NOT NULL DEFAULT 'in_app';
ALTER TABLE refund_defaults ADD COLUMN consent_source TEXT NOT NULL DEFAULT 'in_app';

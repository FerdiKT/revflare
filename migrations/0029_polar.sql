-- Polar (polar.sh, web checkout, merchant of record) revenue (worker/polar/, docs/polar.md). Web apps are apps rows
-- with platform = 'web'; their sales are transactions with store = 'polar' and source = 'polar' (transaction_id = Polar
-- order id, original_transaction_id = the Polar subscription id for subscriptions, else the order id). Webhooks
-- (Standard Webhooks signatures) arrive at POST /polar/webhooks/<notification_key>.

-- Encrypted JSON { webhookSecret?, accessToken? } (worker/lib/crypto.ts encryptJson); NULL = not connected.
ALTER TABLE apps ADD COLUMN polar_secret TEXT;
-- JSON { products: { <Polar product id>: <Revflare product id> }, sandbox: bool, webhookEndpointId?, lastSync? }.
ALTER TABLE apps ADD COLUMN polar_config TEXT;

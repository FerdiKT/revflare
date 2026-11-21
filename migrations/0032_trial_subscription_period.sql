-- Subscriptions that never paid (a trial, or a billing retry after a trial) kept the trial's period (e.g. P3D): they
-- renew at the product's billing period (worker/lib/ledger.ts now stores that). MRR is unaffected (it comes from paid
-- periods); the at-risk value of a billing retry (renewal price / period) was off.
UPDATE subscriptions SET period = (SELECT p.period FROM products p WHERE p.app_id = subscriptions.app_id AND p.product_id = subscriptions.product_id)
WHERE mrr_usd = 0
  AND EXISTS (SELECT 1 FROM products p WHERE p.app_id = subscriptions.app_id AND p.product_id = subscriptions.product_id AND p.period IS NOT NULL AND p.period != COALESCE(subscriptions.period, ''))
  AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.app_id = subscriptions.app_id AND t.original_transaction_id = subscriptions.original_transaction_id AND t.kind != 'trial');

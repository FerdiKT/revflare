# Polar (web checkout)

Websites that sell through [Polar](https://polar.sh) (merchant of record) are **web apps** in Revflare: apps with
`platform = "web"`. Their sales are transactions with `store = "polar"` and `source = "polar"`, so they count in revenue,
proceeds, MRR, actives, the overview, charts, `revflare revenue`, the feed and push notifications next to App Store and
Google Play sales.

## How it works

Polar sends webhooks ([Standard Webhooks](https://www.standardwebhooks.com) signatures) to
`POST /polar/webhooks/<key>` (the app's secret path, shown as the app's `revflareNotificationUrl` / Polar webhook URL).
Each webhook carries the whole order or subscription, so nothing is fetched from Polar to store a sale.

| Polar event | What Revflare does |
| --- | --- |
| `order.paid`, `order.updated` | stores the order (paid / refunded / partially refunded only; drafts and pending orders are ignored) |
| `order.refunded` | the refund (full, or the refunded share of a partial refund), a refund push |
| `subscription.*` (`created`, `updated`, `active`, `canceled`, `uncanceled`, `revoked`, `past_due`) | the subscription's state: auto-renew, cancellation reason, billing retry, expiry; a revocation cuts the last paid period |

Mapping:

- `transaction_id` = the Polar order id; `original_transaction_id` = the Polar subscription id for subscription orders
  (`billing_reason` `subscription_create` / `subscription_cycle`), else the order id. Proration (`subscription_update`)
  and meter charges are one-time revenue (no MRR).
- Product: the Revflare product id mapped to the Polar product (`products` map, e.g. the id the website's events and
  paywall use), else the Polar product id. The product row gets Polar's name and, for subscriptions, its period
  (`recurring_interval` × `recurring_interval_count`).
- Price: the order's **net amount** (after discounts, before tax), in the order's currency (converted to USD like store
  prices). Proceeds: net amount − Polar's `platform_fee_amount`; when an order names no fee, Polar's standard 4% + 40¢ of
  the amount paid. Free trial orders (amount 0 while the subscription is in trial) are trials.
- Customer: the Revflare install id in the checkout metadata (`revflare_install_id`; also `revflare_id`) becomes the
  transaction's `appAccountToken`: the sale links to the install (attribution, funnels, LTV) like a RevflareKit purchase.
  Copy it into Polar checkout metadata when the website creates the checkout.
- Country: the order's billing address. Environment: `Production`, or `Sandbox` when the app's Polar setting `sandbox`
  is on (sandbox.polar.sh).

Webhooks are deduplicated on `webhook-id` (event uid `polar:<webhook-id>`); older snapshots never overwrite newer ones.
Signatures older than 5 minutes are refused. A webhook before the app has a secret answers `503` (Polar retries).

## Setup

1. Add the web app: `revflare apps add-web "My Site" com.example.web` (or `POST /apps { platform: "web", name, bundleId? }`;
   an iOS app without App Store data can be switched with `PATCH /apps/:id { platform: "web" }`).
2. Connect Polar, one of:
   - **Access token (recommended)**: in Polar → Settings → Developers, create an organization access token with
     `webhooks:read`, `webhooks:write` and `orders:read`, then `echo <token> | revflare polar <app> set-token -`. Revflare
     creates the webhook endpoint (format Raw, the events above) itself and keeps its signing secret; the same token
     imports past orders: `revflare polar <app> sync`.
   - **By hand**: Polar → Settings → Webhooks → Add endpoint: URL = the app's webhook URL (`revflare polar <app>`),
     format **Raw**, events above; then `revflare polar <app> set-secret -` with the endpoint's signing secret.
3. Map products to the ids the website uses: `revflare polar <app> map <polar-product-id>=full_version`.
4. The website passes the Revflare install id in the checkout metadata (`metadata: { revflare_install_id }`).

The website may keep reporting `purchase_success` events (funnels): they are events, not revenue; revenue comes only
from Polar's webhooks.

## API

- `GET /apps/:id/polar` (`read`) → `PolarSettings` `{ appId, webhookUrl, connected, hasAccessToken, sandbox, products, webhookEndpointId, lastNotificationAt, lastSync, events }`; `400` for non-web apps.
- `PUT /apps/:id/polar` (`manage`) `{ webhookSecret?: string|null, accessToken?: string|null, products?: { <polar id>: <product id> }, sandbox?: boolean, createWebhook?: boolean }` → `PolarSettings`. Secrets are stored encrypted. With an access token and no secret, Revflare creates (or re-keys) the webhook endpoint in Polar.
- `POST /apps/:id/polar/sync` (`manage`) `{ maxPages? }` → `{ orders, stored, error? }`: imports orders newest first (100 per page, default 5 pages; only mapped products when the map is set).
- `POST /polar/webhooks/:key` (public, Standard Webhooks signature) → `200 { ok, duplicate?, ignored? }`, `401` bad signature, `404` unknown key, `503` no secret yet.

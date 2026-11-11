# Promotional and win-back offers

Apple has two kinds of offers for people who already subscribed (or used to):

- **Promotional offers**: discounts you show in the app (a retention screen, a "come back" paywall). Each purchase
  must carry a signature made with your **In-App Purchase key**, so they need a server. Revflare is that server:
  RevflareKit asks `POST /sdk/v1/offers/sign` and gets the signature back.
- **Win-back offers** (iOS 18+): shown by the App Store and by StoreKit to lapsed subscribers Apple considers eligible.
  They need **no signature** and no server; Revflare only lists them to label their redemptions.

Revflare also shows the audience (lapsed subscribers) and the result (redemptions and revenue per offer).

## Setup

1. **App Store Connect → your subscription → Promotional Offers**: create the offer. Its **Offer Identifier** (e.g.
   `save50`) is the `offerId` used below. Win-back offers live under the subscription's Win-Back Offers.
2. **App Store Connect → Users and Access → Integrations → In-App Purchase**: create a key (or reuse the one Revflare
   already has for Transaction History) and add it in Revflare under **Settings → Store credentials** (In-App Purchase
   key: key id, issuer id, `.p8`). The app needs its bundle id in Revflare.
3. **Revflare → the app → Paywalls and remote config → Offers**: add each (product id, offer id) pair RevflareKit may
   get a signature for, or press **Import from App Store Connect** (needs an App Store Connect API key; imports the
   promotional and win-back offers of the app's subscriptions, the first 15 subscriptions). CLI:
   `revflare offers <app> add com.example.app.annual save50 --label "50 % off"` or `revflare offers <app> import`.
4. In the app, ask RevflareKit for the signed offer and pass it to StoreKit (see `sdk/ios/README.md`).

Until both the key and the bundle id are set, the endpoint answers `409 not_configured`.

## What Revflare signs

`POST /sdk/v1/offers/sign` with header `X-Revflare-Key` and body `{ installId, productId, offerId, appAccountToken? }`
returns `{ productId, offerId, keyId, nonce, timestamp, signature, jws }`:

- `nonce`: a new lowercase UUID per request; `timestamp`: milliseconds.
- `signature` (StoreKit 2 `Product.PurchaseOption.promotionalOffer(offerID:keyID:nonce:signature:timestamp:)`, and
  StoreKit 1 `SKPaymentDiscount`): ECDSA P-256 / SHA-256, DER encoded, base64, over
  `bundleId ⁣ keyId ⁣ productId ⁣ offerId ⁣ appAccountToken ⁣ nonce ⁣ timestamp`, joined with U+2063 (invisible
  separator). `appAccountToken` is lowercase, or empty when the purchase has none: pass the **same** token to StoreKit.
- `jws` (iOS 18.4+, `Product.PurchaseOption.promotionalOffer(_:compactJWS:)`): a compact JWS with header
  `{ "alg": "ES256", "kid": keyId, "typ": "JWT" }` and claims
  `{ "iss": issuerId, "iat": seconds, "aud": "promotional-offer", "bid": bundleId, "nonce", "productId", "offerIdentifier" }`
  plus `"appAccountToken"` (lowercase) when the app sends one, so the JWS binds to it like the legacy signature (no
  `exp`: Apple sets the expiry from `iat`).

Signatures are made per request and never stored; the log keeps who asked for what (below). RevflareKit sends the
build's `environment` (`production`, `sandbox`, `xcode`) in the body: sandbox and Xcode builds are signed too (testing
needs it) and the log row records the environment (`revflare offers <app> log` column BUILD).

## Security model

The SDK key ships inside the app, so anyone can find it and call the endpoint: it is public by design. A signature
only lets someone buy **your** offer at **your** price through the App Store, so the risk is people getting a discount
you meant for others. Revflare limits that with:

- **Allowlist**: only (product, offer) pairs listed as `promotional` for the app are signed (`403 offer_not_allowed`
  otherwise). Win-back entries are never signed.
- **Rate limits**: 10 signatures an hour per install and 1000 an hour per app (`429` with `Retry-After`). They are
  counted in each Worker isolate's memory (no database cost), so they are per isolate: with traffic spread over several
  isolates the real ceiling is a multiple of these numbers, and an isolate restart resets them. Treat them as a brake on
  abuse, not an exact quota.
- **Strict mode** (optional, per app): sign only when the install is linked to a subscription (current or lapsed) in the
  product's subscription group, or to any subscription of the app when the group is unknown. Installs link through
  purchases made with `appAccountToken` = the install id, or the transactions RevflareKit reports. Turn it on when the
  offer is only for (former) subscribers; new installs get `403`.
- **Log**: every signature (`signed`) and a sample of refusals (`not_allowed`, `not_configured`, `not_subscribed`: the
  first 20 an hour per app and isolate, then 1 in 50, with the number of answers the row stands for), about the last
  1000 rows per app (web, `revflare offers <app> log`, `GET /apps/:id/offers/log`). Rate-limited answers are not logged.

Apple adds its own checks: the customer must be eligible for the offer, and each nonce works once.

## Lapsed subscribers

`GET /apps/:id/lapsed?days=90` (web: Offers → Lapsed subscribers, `revflare offers <app> lapsed --days 90`, MCP
`get_lapsed_subscribers`): Production subscriptions that **expired** in the window with **auto-renew off**, counted by
product, and the latest 200 with the customer, expiry date, country and the customer's total paid. Subscriptions in a
grace period or billing retry are still subscribers and are not included; refunded and revoked ones neither, nor
customers who have a current subscription in the app (another plan, or they came back).

## Redemptions

Apple tags each transaction with its `offerType`: 1 introductory, 2 promotional, 3 offer code, 4 win-back, and the
offer identifier. Revflare stores both; the feed and customer pages show a **Promotional**, **Offer code** or
**Win-back** badge. `GET /apps/:id/offers/stats?range=90d` (web: Offers → Redemptions, `revflare offers <app> stats`,
MCP `get_offers`) counts promotional and win-back purchases per offer in the range, with customers, revenue and
proceeds (refunds taken out), labelled from the allowlist.

## Cost (Cloudflare Free plan)

Signing reads nothing from the database while the isolate's cache is warm (app, allowlist and key for 60 s; changes
made in Revflare apply at once in that isolate, elsewhere within a minute), except one indexed read in strict mode.
Logging is background work (it counts toward the daily background budget, `worker/lib/budget.ts`): a logged answer
writes its row and the budget counter (about 2 rows), the log is trimmed every 50 rows, refusals past the first 20 an
hour cost a write only 1 time in 50, and once the day's background budget is used up nothing is logged (signing still
works). Deleting or adding an In-App Purchase key applies at once in that isolate, elsewhere within a minute. Lapsed and redemption reads use indexes on the app's expired
subscriptions and its offer transactions, and are cached until the data changes.

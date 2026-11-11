# Google Play (Android apps)

Revflare tracks Google Play sales next to App Store sales: an Android app is an app with `platform = android` (its
`bundleId` is the package name) and its sales land in the same transactions, subscriptions, customers, metrics, feed,
pushes and Meta sending as iOS sales (`store = play_store`, `source = google_play`).

Google Play sends **real-time developer notifications (RTDN)** through Google Cloud Pub/Sub. They only say that a
purchase changed, so Revflare completes each one with the **Google Play Developer API** (read-only): the purchase's
state (`purchases.subscriptionsv2` / `purchases.productsv2`) and its **orders** (Orders API: price paid, tax, buyer
country, refunds and the exact developer proceeds). Code: `worker/google/`.

## Setup

1. **Add the app**: Revflare → Apps → *Add Android app* (name + package name), or
   `revflare apps add-android "Example" com.example.app`. Its Google Play page shows the **RTDN push URL**
   (`https://<your revflare>/google/rtdn/<secret key>`: keep it secret).
2. **Google Cloud project**: pick or create a project at console.cloud.google.com and enable the **Google Play Android
   Developer API** (APIs & Services → Library).
3. **Service account + key**: IAM & Admin → Service accounts → *Create service account* (no project roles needed) →
   Keys → *Add key* → JSON. Paste the JSON on the app's Google Play page (or
   `revflare google-play <app> set-credential key.json`). It is stored encrypted like the App Store keys; one key can
   serve every app of the Play developer account (an app can also have its own).
4. **Play Console → Users and permissions** → *Invite new users*: the service account's email, with the app (or the
   account) permissions **View app information (read-only)** and **View financial data, orders, and cancellation
   survey responses**. Permissions can take a few minutes (sometimes longer) to apply. *Test* on the Google Play page
   then answers OK (`revflare google-play <app> test`).
5. **Pub/Sub topic**: Pub/Sub → Topics → *Create topic* (e.g. `play-rtdn`). On the topic → Permissions → *Add principal*
   `google-play-developer-notifications@system.gserviceaccount.com` with the role **Pub/Sub Publisher**.
6. **Push subscription**: on the topic → *Create subscription* → delivery type **Push**, endpoint = the RTDN push URL.
   Turn on **Enable authentication** with a service account (e.g. a dedicated `rtdn-push@<project>.iam.gserviceaccount.com`;
   the audience can stay empty = the endpoint URL). The project's Pub/Sub service agent
   (`service-<project number>@gcp-sa-pubsub.iam.gserviceaccount.com`) needs **Service Account Token Creator** on that
   account (Google sets it on new projects). Enter that account as **Push service account** on the Google Play page
   (`revflare google-play <app> set-push-account <email>`): from then on every push must carry a valid OIDC token
   (401 otherwise). Without it the secret URL key alone protects the endpoint.
7. **Play Console → Monetize with Play → Monetization setup → Real-time developer notifications**: topic name
   `projects/<project id>/topics/<topic>`, notifications for subscriptions, voided purchases and (optional) one-time
   products, then **Send test notification**. Revflare raises an info alert "Google Play test notification received"
   (and a push to the iOS app).

## RevflareKit Android

RevflareKit for Android links purchases to installs like the iOS SDK: purchases made with
`setObfuscatedAccountId(<install id>)` link themselves (`obfuscatedExternalAccountId`, like `appAccountToken`), and the
SDK reports `POST /sdk/v1/report` with `platform: "android"`, the install's `orderIds` (base order ids; renewal
suffixes are stripped) and/or `purchaseTokens`, and the **Play Install Referrer** once
(`installReferrer: { referrer, clickTs, installTs }`). The referrer gives the install's acquisition source for LTV, the
feed and remote config: `google_ads` (a `gclid`), `referral` (a `utm_source` other than Play's organic `google-play`),
else `organic`; `utm_source`, `utm_medium`, `utm_campaign` and `gclid` are kept on the install. Debuggable builds
report `environment: "debug"` (test data like Xcode builds: nothing linked). `POST /sdk/v1/identifiers` takes `gaid`
(Meta's `madid`) and `limitAdTracking`; Meta events of Android apps use extinfo `a2` and no `vendor_id`. API details:
[api.md](api.md#apple-ads-attribution-revflarekit).

## How a notification is processed

`POST /google/rtdn/:key` (Pub/Sub push: `{ message: { data: base64(DeveloperNotification), messageId }, subscription }`)
runs in one database call:

1. The app is found by the secret key; with a push service account the OIDC token is verified (RS256 against Google's
   certificates `https://www.googleapis.com/oauth2/v3/certs`, cached per their Cache-Control; issuer
   `accounts.google.com`; audience = the push URL; email = the push service account, verified; not expired).
2. Deduplicated on `messageId` (event uid `gp:<messageId>`): Pub/Sub redeliveries cost one indexed read and no Google call.
3. The service account signs a JWT (RS256, WebCrypto) traded at `oauth2.googleapis.com/token` for an access token
   (`androidpublisher` scope), kept in the database object for up to 55 minutes.
4. Subscriptions: `subscriptionsv2.get` (state, line item, `latestSuccessfulOrderId`, `linkedPurchaseToken`,
   `obfuscatedExternalAccountId`, test purchase), then `orders.batchget` for the latest order and any earlier orders of
   the chain Revflare has not seen (up to 12, e.g. renewals before setup). One-time products: `productsv2.get` +
   `orders.get`. Voided purchases: `orders.get` of the voided order.
5. The orders go through the ledger (like Apple's transactions), the subscription state is updated, the raw
   notification and API answers are kept in R2 (`raw/google/<app>/<yyyy>/<mm>/<messageId>.json`), pushes and Meta
   events follow.

Answers: `200` (processed, duplicate, or ignored: pending purchase, unknown token, pending refund review, a malformed
body (logged), another package's notification (logged, and a `google_play_package` alert once a day): Pub/Sub would
retry anything else for 7 days), `401` (OIDC), `503` (no service account yet, Google 401/403/5xx: Pub/Sub
retries with backoff for up to 7 days, so nothing is lost while setup is finished).

## Mapping

| Google Play | Revflare |
|---|---|
| order id `GPA.1234-5678-9012-34567` (renewals `..0`, `..1`, …) | `transaction_id`; `original_transaction_id` = the base order id (no `..N`) |
| subscription id + base plan | `product_id` = `<subscription id>:<base plan id>` (e.g. `premium:monthly`), product group = subscription id |
| order `servicePeriodStartTime` / `EndTime` | `purchased_at` / `expires_at` (period: P1W, P1M, P1Y… from the service period) |
| offer phase `freeTrial` | kind `trial` (price 0); the first paid order after it is a `conversion` |
| offer phase `introductoryPrice` | offer type 1 (introductory), `PAY_AS_YOU_GO` |
| first paid order / later orders | `new` / `renewal`; one-time products `one_time` |
| order `total` (tax included) + currency | price; gross in USD at the day's rate |
| `developerRevenueInBuyerCurrency` | proceeds (exact, after tax and Google's fee; `proceeds_reported = 1`) |
| `buyerAddress.buyerCountry` (else `regionCode`) | country |
| `testPurchase` / `testPurchaseContext.fopType = TEST` | environment `Sandbox` |
| `obfuscatedExternalAccountId` (a UUID) | the RevflareKit install (like `appAccountToken`) |
| `SUBSCRIPTION_STATE_ACTIVE` | `active` (`trial` while in the free trial) |
| `CANCELED` | `active` with auto-renew off until expiry (then `expired`); `cancel_reason` user[:survey reason] / system / developer / replacement |
| `IN_GRACE_PERIOD` / `ON_HOLD` | `grace` / `billing_retry` |
| `PAUSED` | `expired` with auto-renew on (no MRR while paused) |
| `EXPIRED` | `expired` |
| `SUBSCRIPTION_REVOKED`, voided purchase, order `REFUNDED` | refunded (the subscription `refunded`) |
| order `PARTIALLY_REFUNDED` (partial refund events) | prorated refund: `refund_milli` = refunded share of the total |
| `linkedPurchaseToken` (upgrade, downgrade, re-signup) | a new chain (`new`); the replaced subscription ends at the new purchase (`replacement`), same customer |
| `SUBSCRIPTION_STATE_PENDING` / pending one-time purchase | nothing stored until paid |

When the Orders API is not available (the financial permission is missing), the subscription's recurring price (before
tax) is used and proceeds are estimated with the app's commission (Play's service fee: 15% on subscriptions by
default; set 30 for one-time products above $1M a year), until the permission works. Only free trials count as free then: an
introductory price is not in the subscription's data (its offer phase names no amount), so the recurring price stands in
for it (an estimate, like the proceeds; `proceeds_reported` = 0).

**Refunds RTDN missed**: once a day (03:00–06:00 UTC, within the background budget) Revflare lists each Android app's
voided purchases of the last days (`voidedpurchases.list`, subscriptions included) and refunds the matching orders;
*Check refunds now* on the Google Play page (`revflare google-play <app> voided`) does it at once.

## Limits

- **No history import yet**: sales count from the moment notifications flow (plus earlier renewals of the same
  subscriptions, fetched as gaps). Importing older sales from Play's financial reports may come later.
- Multi-line-item subscriptions (bundles) use their first line item.
- Pending refund reviews (`pendingRefundReviewNotification`) are logged only.
- App Store features stay iOS only: Apple Ads attribution, refund requests (Apple's CONSUMPTION_REQUEST), promotional /
  win-back offer signing, App Store Connect import and reports, App Analytics acquisition (the API answers 400 for
  Android apps).
- Play test subscriptions renew every few minutes (licence testers): they are `Sandbox` and stay out of the numbers.

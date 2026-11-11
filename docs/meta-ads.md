# Meta Ads (Conversions API)

Revflare sends your app's purchases server-side to Meta's [Conversions API for app events](https://developers.facebook.com/docs/marketing-api/conversions-api/app-events),
so Meta Ads optimizes campaigns on real trials, trial conversions and renewals, with their value. It works like
RevenueCat's Meta Ads integration, from your own Revflare server.

## How it works

1. **The app reports its identifiers.** [RevflareKit](../sdk/ios/README.md#meta-facebook-ads) sends the install's ad
   identifiers to `POST /sdk/v1/identifiers`: the Facebook SDK's anonymous id, the IDFA (only when the user allowed
   tracking), the IDFV, the App Tracking Transparency (ATT) status and device info (Meta's `extinfo`). Revflare keeps
   the latest values per install, with the request's IP address and user agent.
2. **Apple reports the purchase.** Every purchase, trial and renewal reaches Revflare from Apple (App Store Server
   Notifications, or Notification History polling when the notifications go to another service) and becomes a ledger
   transaction. Renewals arrive while the app is closed too, so Meta also gets the renewals of users who never open
   the app again.
3. **Revflare links the purchase to the install** through `appAccountToken` (StoreKit 2 purchases made with
   `.appAccountToken(Revflare.installId)`) or RevflareKit's transaction reports (the original transaction ids the
   install owns; this also covers renewals and apps that buy through RevenueCat).
4. **The cron sends it** (every 5 minutes): one Conversions API request per app with up to 100 events.

Identifiers and links can arrive a few minutes after the purchase (first launch, slow network): events wait up to
24 hours for them before they are skipped.

## Setup

1. Meta Events Manager: create or pick the app's dataset; **Settings → Conversions API → Generate access token**.
   Copy the dataset id and the token.
2. Revflare: the app's page → **Integrations → Meta Ads** (or `revflare meta <app> set --dataset-id <id> --token - --enable`
   with the token on stdin). The token is stored encrypted and never shown again. Turning the integration on the first
   time queues the purchases of the last 7 days.
3. The app: add RevflareKit and opt in to the Meta identifiers (see [sdk/ios/README.md](../sdk/ios/README.md#meta-facebook-ads)):
   `Revflare.setMetaAnonymousID(AppEvents.shared.anonymousID)` after configuring the Facebook SDK, and ask for ATT
   (then `Revflare.collectDeviceIdentifiers()`) before purchases if you want IDFA matching.
4. Turn off the Facebook SDK's automatic purchase logging (see [Deduplication](#deduplication-with-the-facebook-sdk)).
5. Send a test event (below), then watch the delivery log after the next real purchase.

## Events

| Ledger transaction | Event type | Default Meta event | Value |
| --- | --- | --- | --- |
| Free trial starts | `trial_started` | `StartTrial` | 0 |
| First paid period, no trial | `initial_purchase` | `Subscribe` | price paid (USD) |
| First paid period after a trial | `trial_converted` | `Subscribe` | price paid (USD) |
| Every later paid period | `renewal` | `Subscribe` | price paid (USD) |
| Consumable, non-consumable, non-renewing | `non_subscription_purchase` | `Purchase` | price paid (USD) |

Each type can be turned off and renamed (for example `renewal` → a custom event `Renewal`; names: letters, digits,
`_`, `-`, spaces, at most 40 characters). Refunds, cancellations and expirations are not sent; refunded purchases are
skipped. Values are what the customer paid, converted to USD with the day's rate, before Apple's commission; the
currency is always `USD`.

Every event carries `event_id` = `order_id` = `<Apple transaction id>_<event type>` (e.g. `2000000123456789_renewal`):
retries and backfills can never count a purchase twice. `event_time` is the purchase time and `action_source` is
`app`. Each event also sends:

- `user_data`: `anon_id` (Facebook SDK anonymous id), `madid` (IDFA), `external_id` (SHA-256 of the Revflare customer
  id), the install's IP address and user agent;
- `app_data`: `advertiser_tracking_enabled` (1 only when ATT is authorized), `application_tracking_enabled: 1`,
  `vendor_id` (IDFV), `extinfo` (the SDK's array, or one built from the reported device info);
- `custom_data`: `currency`, `value`, `order_id`, `content_type: "product"`, `content_ids` / `contents` (the App Store
  product id).

## Required identifiers and ATT

Meta needs `anon_id` or `madid` to match an event to an ad. An install without either is skipped ("No anon_id
(Facebook SDK) and no IDFA").

By default only installs whose ATT status is **authorized** are sent ("ATT not authorized (denied)" otherwise). Turn
on **Send without ATT consent** to also send the others: they go with `advertiser_tracking_enabled: 0` and without the
IDFA, so Meta treats them as not trackable. Whether sending them fits your privacy policy and App Store privacy
label is your decision.

Sandbox purchases are skipped unless **Send Sandbox purchases** is on (useful while testing; use a test event code so
they do not mix with real data).

Meta refuses events older than 7 days: anything older is skipped, and the backfill only covers the last 7 days.

## Deduplication with the Facebook SDK

Revflare sends the purchases, so the Facebook SDK must not send them as well: Meta cannot match its events to
Revflare's (different event ids) and would count each purchase twice. Turn off automatic in-app purchase logging
(the Facebook app's settings: "Log in-app events automatically" / implicit purchase logging) and do not log purchases
yourself with `AppEvents.shared.logPurchase`. Keep the SDK's install and activation events: Meta attributes installs
with them.

## Testing

1. Events Manager → the dataset → **Test events**: copy the test event code into Revflare's settings.
2. **Send test event** (or `revflare meta <app> test`): one synthetic `initial_purchase` event goes to Meta with the
   test code and Meta's answer is shown. It appears under Test events within a minute.
3. While a test event code is set, **every** event goes with it and shows only under Test events (Meta does not use
   them for ads). Make a Sandbox purchase with **Send Sandbox purchases** on to see a real one end to end, then clear
   the test code and turn Sandbox off.
4. Purchases of test installs (RevflareKit `sandbox` / `xcode` builds, the app's test devices) are skipped too
   ("Test install") unless **Send Sandbox purchases** is on. Xcode builds' identifiers are not stored.

## Troubleshooting

The delivery log (the integration page, `revflare meta <app> log`, MCP `get_meta_delivery_log`) keeps the last 100
outcomes per app:

| Log | Meaning / fix |
| --- | --- |
| sent, HTTP 200 | Meta accepted it (`events_received`, `fbtrace_id` in the response). |
| skipped: No install linked to this purchase within 24 h | Buy with `.appAccountToken(Revflare.installId)`, or keep RevflareKit's transaction reports on. |
| skipped: The install sent no identifiers within 24 h | The app does not call the RevflareKit opt-in, or an old app version. |
| skipped: ATT not authorized (…) | The user did not allow tracking; see "Send without ATT consent". |
| skipped: No anon_id … and no IDFA | Call `Revflare.setMetaAnonymousID` with the Facebook SDK's anonymous id. |
| skipped: Sandbox transaction | Turn on Send Sandbox purchases to send them. |
| skipped: Older than Meta's 7-day window | Too old for Meta; nothing to do. |
| skipped: … events are turned off | The event type is off in the settings. |
| failed, HTTP 400 / 401 / 403 | Meta's message is in the log (invalid token, missing permission, bad parameter). Fix it, then **Backfill last 7 days**. |

Pending events (stats) wait for their install, or for a retry: Meta's 429 / 5xx answers and network errors are retried
after 1 min, 5 min, 15 min, 1 h, 2 h, 4 h and 6 h (8 tries), then fail. When Meta rejects a batch because of one bad
event, Revflare sends that batch's events one by one, so only the bad one fails. **Backfill last 7 days** queues failed
and skipped purchases of the last 7 days again; sent ones are never sent twice.

## Privacy

With this integration, the IDFA (with consent), IDFV, Facebook anonymous id, IP address, user agent and device info of
your users go from the app to your Revflare server and from there to Meta, with what they bought. That is
third-party advertising data: declare it in the App Store privacy label (for example **Identifiers → Device ID** and
**Purchases → Purchase History**, used for **Third-Party Advertising**, and as tracking when the IDFA is shared), cover
it in your privacy policy, and ask for consent where your users' law requires it. Revflare never sends names or email
addresses; `external_id` is a SHA-256 hash of an internal id. Turning the integration off stops sending at once.

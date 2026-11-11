# Apple refund requests

When a customer asks Apple for a refund of an In-App Purchase (any product type: consumable, non-consumable,
non-renewing or auto-renewable subscription), the App Store sends your server a `CONSUMPTION_REQUEST` notification. For
the next **12 hours** it accepts information about that purchase through the App Store Server API
([Send Consumption Information](https://developer.apple.com/documentation/appstoreserverapi/send-consumption-information)).
Apple weighs it, with many other factors, when it decides the refund. Without an answer Apple only has the customer's
side.

Revflare can answer these requests for you, per app. It is **off by default**.

## What Apple receives

`PUT /inApps/v2/transactions/consumption/{transactionId}` (production or sandbox host, signed with the workspace's
In-App Purchase key), body `ConsumptionRequest`:

| Field | Value |
| --- | --- |
| `customerConsented` | always `true` (Revflare only answers when consent was confirmed, see below) |
| `deliveryStatus` | always `DELIVERED`: Revflare cannot know about delivery problems in your app |
| `sampleContentProvided` | your setting (a free trial, a sample or a description of the content was offered before purchase) |
| `refundPreference` | from the policy below, or left out |
| `consumptionPercentage` | your optional "consumed %" setting × 1000 (milliunits), for consumables, non-consumables and non-renewing subscriptions; **never** for auto-renewable subscriptions (Apple computes it from the elapsed time) |

Nothing else is sent: no identifiers, play time, account age or lifetime spend (the old v1 fields are not used).

### Refund preference (policy)

- **No preference** (default): only the facts above; Apple decides.
- **Decline when older than N days**: `DECLINE` when the purchase (for a subscription: its first purchase) is at
  least N days old, otherwise no preference. Use it when long-time use makes a refund request unlikely to be an
  accident.
- **Grant a prorated refund**: `GRANT_PRORATED`. For auto-renewable subscriptions Apple computes the share. Other
  products need a consumed percentage strictly between 0 and 100 %; without one, no preference is sent.
- **Grant a full refund**: `GRANT_FULL`.

The preference is one factor among many: Apple can decide otherwise.

## Consent (required by Apple)

Apple only accepts consumption information with the customer's **valid consent** (freely given, specific, informed,
unambiguous), and you are solely responsible for obtaining it. App Tracking Transparency does not count: it is a
different thing. To turn answers on, a member with the `manage` permission must confirm *"I obtained my customers'
consent to share consumption data with Apple, as Apple requires"*; Revflare stores who confirmed it and when.

Customers can withdraw their consent at any time: open the customer in Revflare and choose **Withdraw consent**
(or `PUT /api/v1/customers/:id/refund-consent { "consent": false }`). Their requests are then skipped and logged as
such.

**Privacy label**: if you answer refund requests, disclose in your App Store privacy answers the data you share with
Apple for this purpose (purchase / usage data used for app functionality: refund handling). Apple keeps it only to
review the refund request; customers who want it deleted can ask Apple directly.

## Which requests Revflare answers

Every request Revflare sees in time, whichever way it arrives (one row per notification id):

- Apple delivers it to the app's **Revflare notification URL**: answered at once, also when Revflare forwards the
  notifications to another server (`forwardNotificationUrl`). The other server (RevenueCat) only answers when it is
  set up to; an unanswered request is a lost argument, Apple asks again about every 8 hours and then decides alone.
- Notifications go to another server and Revflare polls Notification History: requests signed less than 12 hours ago
  are queued and answered by the cron; older polled ones are history only.

If another server answers too, Apple gets two answers with the same facts; turn one of them off if that matters.

Requests are answered right after the notification arrives, then retried by the cron (every 5 minutes) on `429`,
`5xx` and network errors, and while the In-App Purchase key or the app's bundle id is missing (after 1, 5, 15, 30
minutes, 1, 2 and 4 hours, or a `429`'s `Retry-After` when longer) as long as the 12 hours last; after that they are
`expired`. Other errors (`400` invalid body, `401` key problem, `404` unknown transaction) fail with Apple's
message. A request is skipped when answers are off, the consent attestation is missing, the customer withdrew consent
or it comes from Xcode / local StoreKit testing.

**Alerts**: a production request that goes unanswered (answers off or no attestation, Apple refused the answer, the
12 hours passed, or the key / bundle id is missing while retrying) raises a `refund_request_unanswered` alert (one per
app and day, shown on the Overview and in Alerts); the next accepted answer resolves it. With `STUDIOFLARE_URL` and
the secret `STUDIOFLARE_API_KEY` (a Studioflare team key; optional `STUDIOFLARE_TEAM`) set, each new alert is also
posted as a note on that Studioflare team's timeline.

## Workspace defaults

`revflare refunds defaults set --attest-consent --enable --policy decline` (or `PUT /integrations/refunds/defaults`)
sets the settings every App Store app without its own settings uses, new apps included. An app's own settings win;
`revflare refunds <app> set --use-defaults` drops them.

## Setup

1. The app's notifications must come to Revflare (the app's page → **Notifications**), and the workspace needs the
   In-App Purchase key (the same key that reads transactions).
2. The app's page → **Integrations → Refund requests**: tick the consent attestation, pick a preference, optionally
   "Sample content provided" and "Consumed %", and turn it on.
3. Check the log: each request with the product, Apple's HTTP status (`202` = accepted), Apple's answer and the reason
   for skips and failures.

CLI: `revflare refunds <app>` (status), `revflare refunds <app> set --attest-consent --enable --policy decline-after
--days 30`, `revflare refunds <app> log`. MCP: `get_refund_requests` (read-only).

## Prorated refunds in the numbers

When Apple grants a prorated refund, the refunded transaction carries `revocationType: REFUND_PRORATED` and
`revocationPercentage` (milliunits). Revflare keeps the part that was not refunded as revenue and proceeds (and in the
customer's total) and counts only the refunded part as refunded amount; the refund still counts as one refund.
Transactions show `refundPercentage` (e.g. `40`). A full refund (`REFUND_FULL`, or no percentage) takes everything back
as before.

## Limits

- Revflare cannot tell whether a purchase was delivered or how much was used: `deliveryStatus` is always `DELIVERED`
  and the consumed percentage is a fixed per-app value. If your app can fail to deliver content, keep the preference
  at *No preference*.
- Requests that arrived while answers were off are not answered later.
- The log keeps the last 100 requests per app on screen; rows are deleted after 180 days.

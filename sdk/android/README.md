# RevflareKit for Android

Install attribution and purchase links for [Revflare](../../README.md), the self-hosted in-app purchase revenue
tracker, plus offerings, funnel events, remote config and an optional Google Play Billing purchases / entitlements
layer (`RevflareStore`) for apps that want to drop RevenueCat. The Android counterpart of the iOS SDK in
[`sdk/ios`](../ios/README.md): same server, same wire formats, same names where Android allows.

Version **1.9.1** (`Revflare.VERSION`, same as iOS). See [Changes](#changes).

- Android 7.0+ (minSdk 24), Kotlin, coroutines. Play Billing Library 9.1.0, Play Install Referrer 2.2. No Facebook
  SDK, no Google Play services requirement (the advertising id is optional).
- `configure` reads only RevflareKit's small SharedPreferences file and install-id file on the calling thread (so the
  install id, cached remote config and attribution are ready when it returns; wrap it in
  `StrictMode.allowThreadDiskReads()` under a strict disk-read policy). Network, Play Billing, Install Referrer and
  the event queue run in the background.
- Attribution only **reads** Play Billing: it never acknowledges, consumes or buys. Safe next to RevenueCat.
- [Purchases](#purchases-revflarestore) (`RevflareStore`) is opt-in: it buys, acknowledges and consumes, so it
  replaces RevenueCat in an app; it must not run next to it.
- [Offerings](#offerings-and-paywalls), [events and funnels](#events-and-funnels), [remote config](#remote-config)
  with experiments and acquisition-source targeting, [test data](#test-and-debug-data) flagged by environment, and
  the opt-in [Meta (Facebook) ads](#meta-facebook-ads) identifiers.

Before an Android app shows revenue, the server needs the app's Google Play setup (service account, real-time
developer notifications): see [docs/google-play.md](../../docs/google-play.md).

## Installation

### GitHub Packages (now)

RevflareKit is published to GitHub Packages (`https://maven.pkg.github.com/FerdiKT/RevflareKit-Android`) as
`io.github.ferdikt:revflarekit:1.9.1`. GitHub Packages needs credentials even for reading: a GitHub user and a
personal access token (classic) with `read:packages`.

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven {
            url = uri("https://maven.pkg.github.com/FerdiKT/RevflareKit-Android")
            credentials {
                username = providers.gradleProperty("gpr.user").orNull ?: System.getenv("GITHUB_ACTOR")
                password = providers.gradleProperty("gpr.key").orNull ?: System.getenv("GITHUB_TOKEN")
            }
        }
    }
}
```

```properties
# ~/.gradle/gradle.properties (never in the app's repository)
gpr.user=your-github-user
gpr.key=ghp_...
```

```kotlin
// app/build.gradle.kts
dependencies {
    implementation("io.github.ferdikt:revflarekit:1.9.1")
    // Optional, only for Meta ads matching: lets RevflareKit read the Google advertising id.
    // implementation("com.google.android.gms:play-services-ads-identifier:18.3.0")
}
```

`revflarekit` brings Play Billing (`com.android.billingclient:billing:9.1.0`, as an `api` dependency), Play Install
Referrer, kotlinx-coroutines and `androidx.lifecycle:lifecycle-process`. An app that already uses Play Billing 9.x
keeps its own version (Gradle picks the newest).

### Maven Central (later)

The same coordinates will move to Maven Central; then the `maven { … }` block and the token are no longer needed.

### Publishing (maintainers)

`./gradlew :revflarekit:publishReleasePublicationToGitHubPackagesRepository` with `GITHUB_ACTOR` / `GITHUB_TOKEN`
(`write:packages`) set. The version is in `revflarekit/build.gradle.kts` and `Revflare.VERSION`; keep them equal to
the iOS version.

## Setup

Get the app's SDK key (`rfp_…`, not a secret) in Revflare web → Apps → the Android app, or `revflare sdk-key <app>`.

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Revflare.remoteConfig.setDefaults(mapOf("paywall_style" to "soft"))   // optional, before configure
        Revflare.configure(this, sdkKey = "rfp_…", server = "https://revflare.example.com")
    }
}
```

`configure` returns at once; later calls are ignored. `Revflare.debugLogging = true` prints what it does to Logcat
(tag `RevflareKit`); configuration errors (unknown SDK key) are always logged.

### What it does

1. **Install referrer.** On the first launch it reads the [Play Install Referrer](https://developer.android.com/google/play/installreferrer)
   once (retried with backoff when the Play Store service is unavailable, given up after 24 hours) and sends it to
   `POST /sdk/v1/report` with a random install id. Revflare derives the source from it: `google_ads` (a `gclid`),
   `referral` (a `utm_source` other than Play's own) or `organic`. The referrer is included in every report until
   the server accepted one. While the server answers `unknown`, RevflareKit asks again 1, 5, 15 and 60 minutes later,
   then every 3 hours, up to 24 hours: `Revflare.attribution` / `Revflare.attributionFlow`.
2. **Purchase links.** At launch, on foreground (at most once a minute) and on Play purchase updates it reads
   `queryPurchasesAsync` (subscriptions and in-app products) and reports, for purchases it has not reported yet, the
   base order ids (`GPA.1234-5678-9012-34567`, the renewal suffix `..N` stripped) and the purchase tokens, in batches
   of 90. Revflare already has the purchases from Google Play (real-time developer notifications); the link puts
   their revenue on the install's source. Reported tokens are remembered.
3. **Install id.** `Revflare.installId` is a random UUID (lowercase), created once, kept in RevflareKit's
   SharedPreferences (`app.revflare.kit`) with a copy in `noBackupFilesDir`. A copy restored by Auto Backup onto
   another device is detected (the no-backup copy is missing) and RevflareKit starts over as a new install. A
   reinstall gets a new id (Android has no keychain that survives uninstall). Before `configure`, use
   `Revflare.installId(context)`.

To skip even the reset, exclude RevflareKit's preferences from backups: use the library's rules as they are

```xml
<application
    android:fullBackupContent="@xml/revflarekit_backup_rules"
    android:dataExtractionRules="@xml/revflarekit_data_extraction_rules" … >
```

or add `<exclude domain="sharedpref" path="app.revflare.kit.xml" />` to the app's own rules (in `full-backup-content`,
and in `cloud-backup` and `device-transfer` of `data-extraction-rules`). The event queue lives in `noBackupFilesDir`
and is never backed up.

### App using RevenueCat

Keep RevenueCat, add `Revflare.configure` only. RevflareKit reads purchases, never acknowledges them, and links them
by order id and purchase token. Optional: `Revflare.syncPurchases()` after a RevenueCat purchase links it at once
instead of at the next foreground.

## Purchases (RevflareStore)

For apps without RevenueCat: Play Billing purchases, entitlements, restore, a small replacement for `Purchases`.

```kotlin
// Application.onCreate, after Revflare.configure
val store = Revflare.configurePurchases(
    entitlements = mapOf("pro" to listOf("pro_subscription", "pro_lifetime")),
    consumables = setOf("coins_100"),          // optional: consumed after purchase, never an entitlement
    // Consumables bought outside a purchase flow (a pending purchase completed later, also while the app was closed):
    // grant them here; the store consumes each one after this returns (a throw retries at the next refresh).
    onConsumablePurchased = { purchase -> wallet.grantCoins(purchase.purchaseToken, 100 * purchase.quantity) },
)
```

- Products come from the offerings set in Revflare (loaded at start and on foreground, `useOfferings = true`) plus
  the entitlement products and `productIds`. Subscription product ids may name a base plan: `pro_subscription:annual`.
- `store.entitlements: StateFlow<CustomerEntitlements>`, `store.isActive("pro")`, `store.entitlement("pro")`,
  `store.hasLoadedEntitlements` (avoid showing a paywall to a subscriber at launch), `store.products`,
  `store.offerings`, `store.isPurchasing`.
- Entitlements come from `queryPurchasesAsync`: `PURCHASED` subscriptions Play still returns (including the billing
  grace period) and one-time products. Pending purchases and suspended subscriptions (account hold, paused) give no
  access; consumables never do. A lifetime purchase wins over a subscription, a subscription over a
  [non-renewing pass](#non-renewing-passes). Play does not give subscription expiration dates on the device
  (`expirationTime` is null for them); `EntitlementInfo.willRenew` is Play's `isAutoRenewing`.

```kotlin
// Buy (from a coroutine; the purchase sheet needs an Activity)
when (val outcome = store.purchase(activity, pkg, placement = "onboarding")) {
    is RevflareStore.PurchaseOutcome.Purchased -> showThanks()
    is RevflareStore.PurchaseOutcome.Pending -> showPendingNotice()   // cash / slow card: unlocked when paid
    RevflareStore.PurchaseOutcome.UserCancelled -> Unit
}
// errors: RevflareBillingException (code: "network_error", "item_already_owned", "billing_unavailable"…)

store.restore()   // re-queries Play (purchases of the same Google account on other devices) and links them
```

What the store does for you:

- sets `setObfuscatedAccountId(installId)` on every purchase, so Revflare links it to the install at once;
- **acknowledges** subscriptions and non-consumables as soon as they are `PURCHASED` (Play refunds purchases not
  acknowledged within 3 days), at purchase, on Play updates (pending purchases that complete, purchases made outside
  the app) and at every refresh (launch, foreground) for anything left unacknowledged;
- **consumes** the products listed in `consumables`: bought through `store.purchase` (grant them on `Purchased`), or
  found later (a pending purchase that completed, also while the app was closed): those go to `onConsumablePurchased`
  first, then are consumed. Grant idempotently by `purchaseToken` (a purchase whose consumption failed comes back
  after a restart). Without `onConsumablePurchased` they stay unconsumed (blocking a new purchase of the product) until
  the app grants them and calls `store.consume(purchase)`;
- records `purchase_start` / `purchase_success` / `purchase_cancel` / `purchase_pending` / `purchase_failed` and
  `restore_start` / `restore_success` / `restore_failed`.

### Server-driven entitlements

Entitlements and pass durations can also be set in Revflare (web → the app → Offerings → Entitlements, or `revflare entitlements <app>`):
a new paid product works without an app update. They arrive with the offerings (`GET /sdk/v1/offerings`, same ETag
cache; older servers leave them out) as `RevflareOfferings.entitlements` and `RevflareOfferings.nonRenewingDurations`.

The rule behind every choice: **a server configuration never takes access away from a paying user.**

- **Mapping**: the effective `store.mapping` (also `store.mappingFlow`) is the union, per entitlement, of the app's
  `entitlements` (`store.localMapping`, always applied, offline too) and the server's. The server only adds products.
- **Durations**: the effective `store.nonRenewingDurations` are the app's (`store.localNonRenewingDurations`) plus the
  server's for products the app does **not** declare. Products the app declares (`entitlements`, `productIds`,
  `consumables`: `store.declaredProductIds`) never take a server duration unless the app also sets a local one in
  `nonRenewingDurations` (then the local one applies): a duration set in Revflare by mistake can't turn a lifetime
  product the app shipped with into an expiring pass, and local **consumables always stay consumables**.
- **Lifetime products**: Google Play does not tell a lifetime one-time product from a pass, and Revflare can't either
  (Play reports both as one-time). Never give a duration to a lifetime product; the dashboard warns about it.
- The server's part is kept on the device (RevflareKit's SharedPreferences) and applied when the store starts, before
  the first entitlement check: a pass bought earlier is recognized at launch, offline too. A server answer without
  the fields clears it (the app's own configuration stays).
- Products referenced by the server entitlements or durations are loaded with the offerings (also when on no
  paywall) and added to `store.products` / `store.productIds`; entitlements are recomputed when the configuration
  changes. With `useOfferings = false` the store still fetches the offerings answer for this (without exposing
  `store.offerings`): since 1.9 that is one request to the Revflare server at start and on foreground (cached 5
  minutes, then a 304 when unchanged).
- A 1.9 app against a Revflare server older than 1.9 gets no server map: the app's own configuration applies alone.

### Non-renewing passes

A pass ("3 days of Pro") is a **one-time** (`inapp`) Play product with a duration:

```kotlin
val store = Revflare.configurePurchases(
    entitlements = mapOf("pro" to listOf("com.example.monthly", "com.example.pass_3day")),
    // Required here: the pass is declared above, so a duration set in Revflare would not apply to it.
    nonRenewingDurations = mapOf("com.example.pass_3day" to NonRenewingDuration.days(3)),
)
store.entitlement("pro")?.expirationTime   // pass end (ms since 1970), null for lifetime / subscriptions
```

- `NonRenewingDuration.days(n)` / `weeks(n)` / `months(n)` / `years(n)`; `duration.end(fromMillis)` in UTC: days and
  weeks are exact multiples of 24 hours, months and years are calendar steps clamped to the month's last day
  (Jan 31 + 1 month = Feb 28 / 29). Same rules as iOS and the server.
- **Stacking**: a repeat purchase extends from the later of its purchase time and the current expiry
  (`end = max(purchaseTime, previous end) + duration`, per product id). A pass grants access while now is before its
  end. `EntitlementInfo.isLifetime` is false for a pass (`isNonRenewing` true); for one entitlement a lifetime
  purchase beats a subscription, which beats a pass; between passes the later end wins.
- A product with a **local** duration is a pass, never a consumable, even when also listed in `consumables` (the
  app's durations win over the app's consumables). A server duration never applies to a local consumable.
- **Play behaviour**: Play gives no expiry for one-time products, never returns a consumed one again, and refuses to
  sell a one-time product the user still owns. So the store acknowledges passes (not consumes them; they stay
  restorable while owned) and records every `PURCHASED` pass in a local ledger (RevflareKit's SharedPreferences). It
  consumes a pass **only right before the same pass is bought again** (Play requires it; the ledger keeps counting
  the consumed one), never because it ended: consuming is irreversible, so an ended pass simply stays owned (and
  gives no access) until the next purchase of it.
- **Refunds**: on every successful purchase query the ledger is checked against Play (never when Play can't answer).
  A pass in the ledger that Play no longer returns and the store did not consume was refunded, revoked or cleared
  (test purchases): it stops counting. Passes the store consumed count only while Play still returns a purchase of
  the same product (the latest pass anchors the chain); when Play returns none, the product's whole chain is dropped
  (1.9.1: covers cleared test purchases and a refunded latest pass). Tradeoff: refunding the latest pass also removes
  the earlier stacked time of that product on the device. Exception: when the latest pass is itself one the store
  consumed (a re-buy consumed it and was then cancelled or failed), Play's silence is expected and the chain stays.
- **Refresh at the end**: the store schedules a refresh at the next pass end (and refreshes on foreground as
  always), so `entitlements` changes on time.
- **Stacked passes live on the device**: the stacked remainder of earlier passes is computed from the local ledger
  (Play does not return consumed purchases). On a new device or after a reinstall only the latest pass (the one still
  owned) is restorable, from its own purchase time; earlier stacked time is lost there. A single pass is always
  restorable. The server keeps every pass (purchases are reported as usual).
- **Device vs dashboard expiry**: the dashboard stores purchase + duration per pass (no stacking), so a stacked pass
  can end later on the device than in the dashboard. A refunded pass in a stack stops counting, so the passes bought
  after it start, and end, earlier.

Attribution-only apps (no `configurePurchases`) never acknowledge or consume: RevenueCat or the app's own billing
code stays in charge.

Promotional offer signing and win-back offers are App Store features: not on Android (Play's developer-determined
offers and offer tags are selected through `RevflarePackage.subscriptionOffers`).

## Offerings and paywalls

Offerings are set in Revflare (web → the app → Offerings, or `revflare offerings`): which products each paywall
shows, in which order, with free-form metadata, and which offering each placement uses.

```kotlin
val offerings = Revflare.offerings()                       // suspend; throws RevflareOfferingsException
val offering = offerings.offering("onboarding")             // placement → offering, else the current one
for (pkg in offering?.packages.orEmpty()) {
    val phase = pkg.defaultOffer?.pricingPhases?.pricingPhaseList?.firstOrNull()
    val price = phase?.formattedPrice ?: pkg.product.oneTimePurchaseOfferDetails?.formattedPrice
    val badge = pkg.metadata["badge"]?.stringValue
}
offering?.annual; offering?.monthly; offering?.lifetime     // $annual, $monthly, $lifetime…
```

- A package's product id is `productId` (one-time products, or a subscription's first auto-renewing base plan) or
  `subscriptionId:basePlanId`. `pkg.product` is the Play `ProductDetails`; `pkg.subscriptionOffers` are the base
  plan's offers Play says the user is eligible for; `pkg.defaultOffer` / `pkg.offerToken` is the one bought by
  default: the longest free trial, else the cheapest intro price, else the base plan (offers tagged
  `revflare-ignore` are skipped). Pass another token to `store.purchase(activity, pkg, offerToken = …)`.
- Packages whose product Play can't load (wrong id, app not installed from a Play test track) are left out and
  logged once.
- Cached on the device: `CACHED_OR_FETCHED` (default) returns a copy under 5 minutes old at once; `FETCH_CURRENT`
  always asks (a 304 with the ETag when unchanged); network failures fall back to the cached copy.

## Events and funnels

Same events as iOS (`POST /sdk/v1/events`, identical body), for the funnels in Revflare:

| Event | When |
| --- | --- |
| `first_open` | First launch of the install. |
| `app_open`, `session_start` | Every launch (`configure`); `session_start` again after 30 minutes or more in the background. |
| `app_background` | The app goes to the background (`ProcessLifecycleOwner`, flushes the queue). |
| `purchase_*`, `restore_*` | From `RevflareStore` (`product`, `offering`, `package`, `placement`, `base_plan`, `offer`; `error` on failures). |
| `paywall_view`, `paywall_close` | `Revflare.trackPaywallView(placement, offering)` / `trackPaywallClose(…)`. |
| `experiment_exposure` | First read of an experiment's parameter (see [remote config](#remote-config)). |

```kotlin
Revflare.track("onboarding_step", mapOf("step" to 2, "name" to "notifications"))
Revflare.trackPaywallView(placement = "onboarding", offering = offering)
Revflare.analyticsEnabled = false   // user opted out: queue deleted, nothing recorded until true again
```

Names: 1-64 characters of `A-Z a-z 0-9 _ . : -`; at most 10 properties, keys 1-40 characters of `A-Z a-z 0-9 _ . -`,
values strings (cut to 100), numbers, booleans, UUIDs, dates, enums. Never personal data. Queued in
`noBackupFilesDir/app.revflare.kit/events.jsonl` (at most 1,000), sent at launch, every 30 s while pending, at 50
queued and on background, at most 200 per request; 429 / 5xx / network errors back off (5 s doubling to 10 min, or
`Retry-After`), other 4xx drop the batch.

## Remote config

```kotlin
val config = Revflare.remoteConfig
config.setDefaults(mapOf("paywall_style" to "soft", "max_free" to 3))   // before configure
config.string("paywall_style"); config.int("max_free"); config.bool("new_onboarding"); config.double("ratio")
config.json("paywall")?.get("title")?.stringValue
config.info.collect { … }                      // StateFlow: isLoaded, version, conditions, country, experiments…
config.fetchAndActivate(timeoutMs = 3000)      // suspend; e.g. before a paywall that depends on the source
config.fetch(); config.activate()
config.autoFetch = false                       // before configure: fetch only when asked
config.minimumFetchIntervalMs = 0              // debug builds: see changes at once
```

Same behaviour as iOS: values activated last are applied at once on the next launch (offline too), `configure`
fetches and activates in the background, foreground refetches after `minimumFetchIntervalMs` (1 hour), ETag / 304,
getters never fail (remote → defaults → the `default` argument). Requests (`GET /sdk/v1/config`) carry `installId`,
`appVersion`, `appBuild`, `osVersion`, `locale`, `storefront` (the Play billing country from
`BillingClient.getBillingConfigAsync`, left out when unknown), `source` / `campaign` (acquisition), `environment` and
`sdk`. A new install's first fetch waits up to 3 s for the first attribution answer; when the source becomes known
later, values are fetched into the pending slot and applied at the next activate / foreground / launch.

**Experiments**: `config.experiments`, `config.variant("exp_paywall")`. Reading any parameter of an enrolled
experiment (whatever the value's source) records `experiment_exposure` once per install, experiment and variant;
apps that branch on `variant(...)` call `config.trackExposure("exp_paywall")`.

## Test and debug data

Every request carries `environment`: `debug` for debuggable builds, else `production`
(`RevflareEnvironment.AUTOMATIC`). Pass `RevflareEnvironment.SANDBOX` to `configure` for internal test builds signed
for release. Test purchases (license testers) are flagged by the server from Google Play's data. Revflare keeps
`debug` / `sandbox` data out of its numbers by default.

## Meta (Facebook) ads

Opt-in, like iOS: only after the app's own consent flow.

```kotlin
Revflare.setMetaAnonymousID(AppEventsLogger.getAnonymousAppDeviceGUID(context))   // with the Facebook SDK
// or, without it:
Revflare.collectDeviceIdentifiers()
```

RevflareKit then sends `POST /sdk/v1/identifiers` (again only when something changed):

```json
{ "installId": "…", "platform": "android", "fbAnonId": "XZ…" , "gaid": "38400000-…" , "attStatus": "authorized",
  "bundleId": "com.example.app", "appVersion": "1.2.0", "appBuild": "42", "osVersion": "15", "deviceModel": "Pixel 9",
  "locale": "en_US", "timeZone": "Europe/Istanbul", "environment": "production",
  "extinfo": ["a2", "com.example.app", "42", "1.2.0", "15", "Pixel 9", "en_US", "GMT+03:00", "carrier", "1080",
              "2400", "2.63", "8", "128", "64", "Europe/Istanbul"] }
```

`gaid` is the Google advertising id, sent only when the app includes `play-services-ads-identifier` (which adds the
`AD_ID` permission) and the user did not limit ad tracking / delete the id. `attStatus` keeps the iOS field name:
`authorized` (id available), `denied` (ad tracking limited), `unavailable` (library not included). `extinfo` follows
Meta's Android layout (`a2`, package, version code, version name, OS, model, locale, time zone abbreviation, carrier,
screen width / height in pixels, density, CPU cores, total / free storage GB, time zone).

## Privacy and Google Play Data safety

Everything goes only to the Revflare server you configure. Without the Meta opt-in RevflareKit sends no advertising
id, Android id, account, email, location or contacts.

| Request | Data |
| --- | --- |
| `POST /sdk/v1/report` | Random install id, app version, first-run time, the Play install referrer (`referrer` string with utm / gclid, click and install times in seconds), Play order ids and purchase tokens. |
| `GET /sdk/v1/config` | Install id, app version / build, OS version, locale, Play billing country, acquisition source. |
| `GET /sdk/v1/offerings` | App version. |
| `POST /sdk/v1/events` | Event names, times, session id, the properties the app passes, app version / build, OS version, locale. |
| `POST /sdk/v1/identifiers` | Only after opt-in: see [Meta](#meta-facebook-ads). |

A careful reading of the Data safety form (your call):

- **Data collected**: *App activity → App interactions* (events) and *Purchase history* (order ids, purchase tokens),
  for *Analytics*; *Device or other IDs* (the random install id), for *Analytics*. With the Meta opt-in add
  *Device or other IDs* (advertising id) for *Advertising or marketing*, and declare that data is **shared** with Meta
  (Revflare sends purchases to Meta's Conversions API).
- **Shared**: no (without the Meta opt-in): it goes to your own server, a service provider acting for you.
- **Encrypted in transit**: yes (HTTPS server). **Deletion**: on request, from your Revflare server.
- Apps that turn events off (`analyticsEnabled = false` before `configure`) drop *App interactions*.

## Parity with iOS

| Feature | iOS (RevflareKit) | Android |
| --- | --- | --- |
| Configure | `Revflare.configure(sdkKey:server:environment:)` | `Revflare.configure(context, sdkKey, server, environment)` |
| Install id | Keychain (survives reinstall) | SharedPreferences + no-backup copy (new id on reinstall) |
| Acquisition | Apple Ads (AdServices token) | Play Install Referrer (`google_ads`, `referral`, `organic`) |
| Purchase links | original transaction ids | base order ids + purchase tokens |
| Purchase → install link | `appAccountToken` | `obfuscatedAccountId` |
| Store | `RevflareStore` (StoreKit 2, finishes transactions) | `RevflareStore` (Play Billing 9, acknowledges / consumes) |
| Entitlements | `@Published customer` | `StateFlow<CustomerEntitlements>` |
| Expiration dates on device | yes | non-renewing passes only (computed; Play exposes none) |
| Server-driven entitlements, non-renewing durations | yes (1.9.0) | yes (1.9.0) |
| Offerings / placements / metadata | yes | yes (+ base plans and offers) |
| Events / funnels | yes | yes (identical wire format) |
| Remote config, experiments, source targeting | yes | yes (`storefront` = Play billing country) |
| Environment | `production` / `sandbox` / `xcode` | `production` / `sandbox` / `debug` |
| Meta identifiers | IDFA, IDFV, ATT status, `i2` extinfo | GAID (optional), limit-ad-tracking status, `a2` extinfo |
| Promotional offer signing | yes | no (App Store only) |
| Win-back offers | yes (iOS 18) | no (App Store only) |
| Apple Ads attribution | yes | no |

## API

```kotlin
object Revflare {
    const val VERSION: String
    var debugLogging: Boolean
    fun configure(context: Context, sdkKey: String, server: String, environment: RevflareEnvironment = AUTOMATIC)
    val isConfigured: Boolean
    val installId: String                       // after configure
    fun installId(context: Context): String
    val environment: RevflareEnvironment
    val attribution: RevflareAttribution; val attributionFlow: StateFlow<RevflareAttribution>
    val remoteConfig: RevflareRemoteConfig
    val store: RevflareStore?
    fun configurePurchases(entitlements, productIds = [], consumables = [], useOfferings = true, onConsumablePurchased = null): RevflareStore
    fun configurePurchases(entitlements, productIds = [], consumables = [], useOfferings = true,
                           nonRenewingDurations: Map<String, NonRenewingDuration>, onConsumablePurchased = null): RevflareStore
    suspend fun offerings(fetchPolicy = CACHED_OR_FETCHED): RevflareOfferings
    fun syncPurchases()
    fun setMetaAnonymousID(id: String); fun collectDeviceIdentifiers()
    fun track(name: String, properties: Map<String, Any?> = emptyMap())
    fun trackPaywallView(placement: String? = null, offering: RevflareOffering? = null)
    fun trackPaywallClose(placement: String? = null, offering: RevflareOffering? = null)
    var analyticsEnabled: Boolean
}
```

## Development

```sh
cd sdk/android
echo "sdk.dir=$ANDROID_HOME" > local.properties     # or export ANDROID_HOME
./gradlew :revflarekit:testDebugUnitTest :revflarekit:assembleRelease
```

JDK 17, compileSdk 35. JVM unit tests (no device) cover the report state machine (referrer once, batching, order id
normalisation, polling, identifiers), the event queue, remote config (cache, ETag, experiments), offerings mapping and
offer selection, the store's purchase flow (acknowledge / consume / pending), server-driven entitlements and
non-renewing passes (merge rules, durations, stacking, refunds, expiry refresh) and the exact JSON bodies, with fakes
for the transport, the clock, storage and Play Billing.

## Changes

### 1.9.1

- The pass ledger is validated against Play's purchases on every successful query: consumed passes count only while
  Play still returns a purchase of their product, so cleared test purchases or a refunded latest pass drop the whole
  chain of that product (earlier stacked time on the device included; a latest pass the store itself consumed before
  a cancelled re-buy keeps its chain). Nothing is dropped when Play can't answer.

### 1.9.0

- Server-driven entitlements: `RevflareOfferings.entitlements` / `nonRenewingDurations` from `GET /sdk/v1/offerings`,
  merged with the app's configuration (union per entitlement; server durations only for products the app does not
  declare, `store.declaredProductIds`; local consumables always stay consumables), kept on the device and applied at
  launch; referenced products are loaded with the offerings. Stores with `useOfferings = false` now make one request
  to the Revflare server at start and on foreground for them. Against a pre-1.9 server the server map is simply absent.
- Non-renewing passes: `NonRenewingDuration`, `configurePurchases(…, nonRenewingDurations = …)`, a local pass ledger,
  stacking, consumption only right before a repeat purchase of the same pass (never on expiry), refund exclusion, a
  refresh at the pass end. Stacked time lives on the device (a new device restores the latest pass only); device
  expiry of stacked passes can be later than the dashboard's.
- `EntitlementInfo.expirationTime` and `isNonRenewing`; `isLifetime` is false for passes.
  `CustomerEntitlements.expirationTimes` and a `compute(…, nonRenewingDurations, passHistory, now)` overload.
- `RevflareStore.mapping` is now the effective mapping (`localMapping` keeps the app's); new `mappingFlow`,
  `nonRenewingDurations`, `localNonRenewingDurations`, `declaredProductIds`.

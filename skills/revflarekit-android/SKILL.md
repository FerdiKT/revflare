---
name: revflarekit-android
description: Integrate RevflareKit for Android (the Revflare Android SDK, Kotlin library in the Revflare repo at sdk/android, Maven io.github.ferdikt:revflarekit) into an Android app. Use when the user wants to add Revflare / RevflareKit to an Android app, set up Play Install Referrer attribution (Google Ads / referral / organic) for Revflare, link Google Play purchases to installs (order ids, purchase tokens, obfuscatedAccountId), replace RevenueCat with RevflareStore on Android (Play Billing 9 purchases, entitlements, acknowledge / consume, restore, paywall, non-renewing passes with durations, server-driven entitlements set in Revflare), use remote offerings / placements on Android paywalls (base plans and offers), instrument funnel events (Revflare.track, paywall views, analytics opt-out), use remote config / A/B experiments / targeting by acquisition source on Android, handle debug / sandbox data (RevflareEnvironment), keep RevenueCat but add Revflare attribution on Android, set up the Meta (Facebook) Ads integration on Android (setMetaAnonymousID, collectDeviceIdentifiers, advertising id), update an Android app to a new RevflareKit version, or answer Google Play Data safety questions about RevflareKit.
---

# RevflareKit in an Android app

RevflareKit for Android talks only to the user's own Revflare server. Source of truth for its API:
`sdk/android/README.md` in the Revflare repo (`/Volumes/KIOXIA/Projects/revflare` on the user's machine, or a clone of
github.com/FerdiKT/revflare); the Kotlin sources are in `sdk/android/revflarekit/src/main/kotlin/app/revflare/kit/`.
Read them when something here is unclear; this skill is kept in sync with them (current version: **1.9.1**, same as
iOS). For iOS apps use the `revflarekit` skill.

Independent parts, pick what the app needs:

| Part | Call | What it does |
| --- | --- | --- |
| Attribution (always) | `Revflare.configure(context, sdkKey, server)` | Play Install Referrer once + links the app's Play purchases (order ids, purchase tokens) to the install. Only reads Play Billing: safe next to RevenueCat. |
| Purchases (optional) | `Revflare.configurePurchases(entitlements, …)` → `RevflareStore` | Play Billing 9 store: products, purchase, restore, entitlements. **Acknowledges and consumes purchases: never together with RevenueCat.** |
| Offerings (optional) | `Revflare.offerings()` / `store.offering("placement")` | Paywall products (with base plans / offers), order and metadata set in Revflare, cached on the device. |
| Events (on by default) | `Revflare.track(name, props)`, `Revflare.trackPaywallView(placement, offering)` | Funnel events; automatic `first_open` / `app_open` / `session_start` / `app_background` and RevflareStore purchase events. Off with `Revflare.analyticsEnabled = false`. |
| Remote config (on by default) | `Revflare.remoteConfig.string("key")`, `.bool` / `.int` / `.long` / `.double` / `.json` | Parameters resolved per device by conditions (country, app version, language, % rollout, acquisition source), cached. Experiments record exposures themselves. |
| Meta Ads (optional, opt-in) | `Revflare.setMetaAnonymousID(id)` / `Revflare.collectDeviceIdentifiers()` | Device identifiers so Revflare can send purchases to Meta's Conversions API. Only after consent. |

Not on Android: Apple Ads attribution, promotional offer signing, win-back offers (App Store features).

## 1. Before editing

- Find the app module (`app/build.gradle(.kts)`), its `applicationId`, `minSdk` (RevflareKit needs 24+), the
  `Application` class (create one if missing and register it in the manifest), and how it buys today:
  `grep -rn "BillingClient\|Purchases.configure\|com.revenuecat\|launchBillingFlow" --include=*.kt --include=*.java`.
- Get the Android app's SDK key (`rfp_…`, not a secret): `revflare sdk-key <app name or package name>` (see the
  `revflare` skill), or Revflare web → Apps → the Android app. The server URL is the user's Revflare instance
  (`revflare whoami`). Never invent keys. The Android app must exist in Revflare with its Google Play setup
  (`docs/google-play.md`: service account, real-time developer notifications), or no revenue shows.
- Check the app's other branches / uncommitted work before changing purchase code; ask before replacing RevenueCat.

## 2. Add the dependency

GitHub Packages for now (Maven Central later, same coordinates). Reading needs a GitHub token with `read:packages`,
kept out of the repository (`~/.gradle/gradle.properties`: `gpr.user=…`, `gpr.key=ghp_…`):

```kotlin
// settings.gradle.kts → dependencyResolutionManagement.repositories
maven {
    url = uri("https://maven.pkg.github.com/FerdiKT/RevflareKit-Android")
    credentials {
        username = providers.gradleProperty("gpr.user").orNull ?: System.getenv("GITHUB_ACTOR")
        password = providers.gradleProperty("gpr.key").orNull ?: System.getenv("GITHUB_TOKEN")
    }
}

// app/build.gradle.kts
dependencies {
    implementation("io.github.ferdikt:revflarekit:1.9.1")
}
```

If the user can't use GitHub Packages yet: `cd sdk/android && ./gradlew :revflarekit:publishToMavenLocal` in the
Revflare repo and `mavenLocal()` in the app's repositories (local development only). The library brings Play
Billing 9.1.0 (`api`), Play Install Referrer 2.2, coroutines and lifecycle-process; an app on Play Billing 8 or
older must move to 9.x (check its billing code still compiles: `queryProductDetailsAsync` returns a
`QueryProductDetailsResult`).

## 3. Attribution (every app)

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Revflare.configure(this, sdkKey = "rfp_…", server = "https://<revflare-host>")
    }
}
```

- With RevenueCat or the app's own Play Billing code: just `configure` (it never acknowledges); optionally
  `Revflare.syncPurchases()` after a successful purchase. Apps with their own billing code can also pass
  `Revflare.installId` to `BillingFlowParams.Builder.setObfuscatedAccountId(...)` (if they don't already use it for
  their own user id), which links the purchase on the server at once.
- Debug: `Revflare.debugLogging = true`, Logcat tag `RevflareKit`.
- Test data: don't wrap `configure` / `track` in `if (BuildConfig.DEBUG)`. Debuggable builds report
  `environment = debug`, others `production`; Revflare keeps `debug` / `sandbox` out of its numbers by default. Internal
  release-signed test builds: `Revflare.configure(…, environment = RevflareEnvironment.SANDBOX)`. Testers on Play
  builds: add their `Revflare.installId` under Revflare web → the app → Excluded install ids.
- `Revflare.attribution` / `attributionFlow`: `source` `GOOGLE_ADS` / `REFERRAL` / `ORGANIC` / `UNKNOWN` (`rawSource`
  keeps unknown strings), `campaignId`. Resolved from the Play Install Referrer by the server, usually at the first
  report.
- Backups: the install id is detected and reset when Auto Backup restores it elsewhere. To avoid even that, add
  `<exclude domain="sharedpref" path="app.revflare.kit.xml" />` to the app's backup rules, or, if it has none, use
  `android:fullBackupContent="@xml/revflarekit_backup_rules"` and
  `android:dataExtractionRules="@xml/revflarekit_data_extraction_rules"`.
- Install referrer testing: install from a Play test track through a link like
  `https://play.google.com/store/apps/details?id=<package>&referrer=utm_source%3Dtest%26utm_campaign%3Dqa`.

## 4. Replacing RevenueCat with RevflareStore (only when the user asks)

1. Read the RevenueCat setup (offerings, packages → Play product ids and base plans, entitlements). Recreate the
   offerings in Revflare (section 5); package product ids are `subscriptionId:basePlanId` or a one-time product id.
2. In `Application.onCreate`, after `configure`:
   `val store = Revflare.configurePurchases(entitlements = mapOf("pro" to listOf("pro_sub", "pro_lifetime")), consumables = setOf(...))`.
   Products come from the offerings (`useOfferings = true`) plus the entitlement products and `productIds`. Apps with
   consumables also pass `onConsumablePurchased = { purchase -> grant(purchase) }`: consumables bought outside a
   purchase flow (pending purchases completing later, even while the app was closed) are handed to it, then consumed
   (grant idempotently by `purchaseToken`; without it they stay unconsumed until the app calls `store.consume`).
   Consumables bought through `store.purchase` are granted on `Purchased`, not through the handler.
3. Map calls: `Purchases.sharedInstance.awaitOfferings()` → `Revflare.offerings()` / `store.offerings`;
   `offerings.current` → same; `getCurrentOfferingForPlacement` → `offering("placement")`; `availablePackages` →
   `packages`; `package.product` → `pkg.product` (`ProductDetails`) with `pkg.defaultOffer` / `pkg.subscriptionOffers`
   for prices; `awaitPurchase(PurchaseParams(activity, package))` → `store.purchase(activity, pkg, placement = …)`
   (`Purchased` / `UserCancelled` / `Pending`, errors `RevflareBillingException`); `customerInfo.entitlements.active`
   → `store.entitlements` (StateFlow) / `store.isActive("pro")`; `awaitRestore()` → `store.restore()`. Wait for
   `store.hasLoadedEntitlements` before deciding to show a paywall. The paywall is the app's own UI.
4. Non-renewing products (RevenueCat "non-subscription" passes, e.g. 3 days of Pro) are one-time Play products with
   a duration: `configurePurchases(entitlements = mapOf("pro" to listOf("com.example.monthly", "com.example.pass_3day")),
   nonRenewingDurations = mapOf("com.example.pass_3day" to NonRenewingDuration.days(3)))` (`days` / `weeks` /
   `months` / `years`, UTC, months clamp to the month's end). Repeat purchases stack (`max(purchase, current end) +
   duration`); `store.entitlement("pro")?.expirationTime` is the end, `isLifetime` is false. The store acknowledges a
   pass, keeps a local ledger, consumes an owned pass **only right before the same pass is bought again** (Play
   requires it; never on expiry: consuming is irreversible), excludes refunded passes (gone from Play without the
   store consuming them; later passes in the stack move earlier), and since **1.9.1** counts consumed passes only
   while Play still returns a purchase of the same product (cleared test purchases or a refunded latest pass drop the
   product's whole chain on the device; a latest pass the store consumed before a cancelled re-buy keeps it; nothing
   is dropped when Play can't answer) and refreshes at the end. A product with a local
   duration is never a consumable. A pass the app declares needs its duration here (a Revflare duration does not
   apply to declared products). Limitation to tell the user: the stacked remainder lives on the device; on a new
   device or after a reinstall only the latest (still-owned) pass is restorable. Device expiry of stacked passes can
   be later than the dashboard's (purchase + duration per pass).
5. Remove the RevenueCat dependency, API key and `Purchases.configure`; existing subscribers keep access (Play
   returns their purchases, nothing to migrate).
6. Test on a device with a license tester account and the app installed from a Play internal test track: prices
   load, purchase unlocks and is acknowledged (no refund after 3 days), cancel does nothing, pending (slow test card)
   unlocks once approved, restore works.

## 5. Offerings and placements

- Set offerings / placements in Revflare web → the app → Offerings, or `revflare offerings` (see the `revflare`
  skill). Package product ids: `pro_sub:annual`, `pro_sub:monthly`, `pro_lifetime`.
- `val offering = Revflare.offerings().offering("onboarding")` (suspend; `store.offering("onboarding")` with the
  store) → `offering.packages`, `offering.annual`, `pkg.metadata["badge"]?.stringValue`, `offering.metadata`.
- Price: `pkg.defaultOffer?.pricingPhases?.pricingPhaseList` (free trial phase first) or
  `pkg.product.oneTimePurchaseOfferDetails?.formattedPrice`. The default offer is the longest free trial, else the
  cheapest intro price, else the base plan; tag an offer `revflare-ignore` in the Play Console to skip it. Never
  promise a trial the default offer does not have (Play only returns offers the user is eligible for).
- Packages whose product Play can't load are dropped (logged once): check ids, base plan ids, and that the build is
  installed from Play.

Server-driven entitlements (1.9.0): entitlements and pass durations set in Revflare (web → the app → Offerings →
Entitlements, or `revflare entitlements <app>`) arrive with the offerings and are merged: mapping = union per
entitlement of the app's and the server's (the app's always applies, offline too; the server only adds), durations =
the app's plus the server's for products the app does **not** declare. Rule: **a server configuration never takes
access away from a paying user**: products the app declares (`entitlements`, `productIds`, `consumables`:
`store.declaredProductIds`) never take a server duration unless the app sets a local one, and local consumables always
stay consumables. Play doesn't tell lifetime one-time products from passes: never give a lifetime product a duration
in Revflare (the dashboard warns). The server part is kept on the device and applied at launch; referenced products
are loaded automatically (with `useOfferings = false` that is one request to the Revflare server at start and on
foreground). So a new paid product only needs the Play Console + Revflare, no app update, as long as the app shows
products generically (e.g. from offerings). `store.mapping` / `store.nonRenewingDurations` are the effective values;
`store.localMapping` the app's. A 1.9 app against a pre-1.9 server gets no server map (local configuration only).

## 6. Events and funnels

```kotlin
Revflare.track("onboarding_step", mapOf("step" to 2, "name" to "notifications"))
Revflare.trackPaywallView(placement = "onboarding", offering = offering)      // when the paywall appears
Revflare.trackPaywallClose(placement = "onboarding", offering = offering)     // closed without buying
Revflare.analyticsEnabled = false                                            // the app's analytics opt-out switch
```

Names 1-64 of `A-Z a-z 0-9 _ . : -`, ≤ 10 properties, no personal data. Purchase events come from RevflareStore
only; apps on RevenueCat track them themselves if they want them in funnels. Define funnels in Revflare web → the
app → Funnels.

## 7. Remote config, experiments, source targeting

```kotlin
Revflare.remoteConfig.setDefaults(mapOf("paywall_style" to "soft"))   // before configure
val style = Revflare.remoteConfig.string("paywall_style")
lifecycleScope.launch { Revflare.remoteConfig.fetchAndActivate(timeoutMs = 3000) }   // e.g. before the paywall
```

- Values activated last apply at once at launch (offline too); `configure` fetches and activates in the background;
  `remoteConfig.info` (StateFlow) has `isLoaded`, `version`, `conditions`, `experiments`, `attribution`.
- Conditions can target `source` (`google_ads`, `referral`, `organic`) and `campaign`, plus country (Play billing
  country), app version, language, % rollout, environment. A hard paywall for Google Ads installs: a condition on
  source in Revflare, read the parameter where the paywall shows.
- Experiments: reading a parameter of an enrolled experiment records `experiment_exposure` once; read it where the
  user sees the variant. Branching on `remoteConfig.variant("exp_id")` → call `trackExposure("exp_id")`.
- Migrating from Firebase Remote Config: `getString/getBoolean/getLong/getDouble` → `string/bool/long/double`,
  `setDefaultsAsync(map)` → `setDefaults(map)`, `fetchAndActivate()` → same (suspend, never throws).

## 8. Meta (Facebook) Ads (only when the user wants Meta campaigns optimized on purchases)

Server side: Revflare web → the app → Integrations → Meta Ads, or `revflare meta <app> set ...`. App side, after the
app's own consent flow:

```kotlin
Revflare.setMetaAnonymousID(AppEventsLogger.getAnonymousAppDeviceGUID(context))   // app with the Facebook SDK
Revflare.collectDeviceIdentifiers()                                             // or without it
```

- For advertising-id matching add `com.google.android.gms:play-services-ads-identifier` to the app (it adds the
  `AD_ID` permission, which must then be declared in the Play Console's advertising id form). Without it RevflareKit
  sends `attStatus: unavailable` and no `gaid`.
- If the app has the Facebook SDK: turn off its automatic purchase logging (`AutoLogAppEventsEnabled=false` in the
  manifest meta-data, or Meta dashboard → Log In-App Events Automatically = No), otherwise purchases count twice.
- Purchases must be tied to the install (RevflareStore, or `syncPurchases` / `obfuscatedAccountId`).
- Never call the opt-ins for users who declined. Verify with `revflare meta <app> test`, then `revflare meta <app> log`.

## 9. Google Play Data safety answers

- Attribution / purchases / install id: *Purchase history* and *Device or other IDs* (the random install id),
  collected for *Analytics*, not shared (it goes to the developer's own server), encrypted in transit.
- Events (unless `analyticsEnabled = false` before `configure`): *App activity → App interactions*, for *Analytics*.
- Remote config / offerings: no new data type (app version, OS, locale, billing country, the install id).
- With the Meta opt-in: *Device or other IDs* (advertising id) for *Advertising or marketing*, **shared** with Meta;
  the advertising id declaration in the Play Console says "yes, for advertising".
- The install referrer is used to measure the developer's own campaigns (analytics), not to track across apps.

## 10. Finish

- Build (`./gradlew :app:assembleDebug`), run on a device with `Revflare.debugLogging = true`: Logcat shows the
  install report, the config fetch and the first events.
- `revflare attribution --app <app>` shows coverage once installs report; funnels fill as events arrive.
- Mention the RevflareKit version the app now uses. When RevflareKit for Android changes, update this skill and
  `sdk/android/README.md` together (and keep the version equal to iOS's).

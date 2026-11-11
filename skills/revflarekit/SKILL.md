---
name: revflarekit
description: Integrate RevflareKit (the Revflare iOS SDK, Swift package in the Revflare repo at sdk/ios) into an iOS app. Use when the user wants to add Revflare / RevflareKit to an app, set up Apple Ads attribution for Revflare, link purchases to installs (appAccountToken), replace RevenueCat with RevflareStore (StoreKit 2 purchases, entitlements, paywall, restore), use remote offerings / placements on paywalls (Revflare.offerings, like RevenueCat offerings), server-driven entitlements and non-renewing pass durations (a new product unlocking pro without an app update, nonRenewingDurations), instrument events for funnels (Revflare.track, onboarding steps, paywall views, analytics opt-out), use remote config (Revflare.remoteConfig, feature flags, A/B variants, A/B experiments with exposure tracking) target remote config by acquisition source (Apple Ads campaign vs organic, e.g. hard paywall for Apple Ads; Revflare.attribution), handle test / debug data (Revflare.environment: Xcode, TestFlight sandbox, production) or migrate from Firebase Remote Config, add promotional offers (server-signed) or iOS 18 win-back offers for lapsed subscribers, keep RevenueCat but add Revflare attribution, set up the Meta (Facebook) Ads integration on the app side (setMetaAnonymousID, collectDeviceIdentifiers, ATT), update an app to a new RevflareKit version, or answer App Store privacy questions about RevflareKit.
---

# RevflareKit in an iOS app

RevflareKit talks only to the user's own Revflare server. Source of truth for its API: `sdk/ios/README.md` in the
Revflare repo (`/Volumes/KIOXIA/Projects/revflare` on the user's machine, or a clone of github.com/FerdiKT/revflare).
Read it when something here is unclear; this skill is kept in sync with it (current version: **1.9.2**).

Independent parts, pick what the app needs:

| Part | Call | What it does |
| --- | --- | --- |
| Attribution (always) | `Revflare.configure(sdkKey:server:)` | Apple Ads token + links the app's purchases to the install. Only reads StoreKit: safe next to RevenueCat. |
| Purchases (optional) | `Revflare.configurePurchases(productIds:entitlements:nonRenewingDurations:)` → `RevflareStore` | StoreKit 2 store: products, purchase, restore, entitlements (merged with the ones set in Revflare, 1.9+), pass durations. **Owns and finishes transactions: never together with RevenueCat.** |
| Offerings (optional) | `Revflare.offerings()` / `store.offering(forPlacement:)` | Paywall products, order and metadata set in Revflare, fetched at runtime (cached, works offline after the first fetch). Works with RevflareStore or alone. |
| Events (on by default) | `Revflare.track(_:properties:)`, `Revflare.trackPaywallView(placement:offering:)` | App-usage events for the funnels in Revflare; automatic `first_open` / `app_open` / `session_start` / `app_background` and RevflareStore purchase events. Off with `Revflare.analyticsEnabled = false`. |
| Remote config (on by default) | `Revflare.remoteConfig.string("key")`, `.bool` / `.int` / `.double` / `.decode` | Parameters set in Revflare, resolved per device by conditions (country, app version, language, % rollout, acquisition source 1.8+), cached on the device. Replaces Firebase Remote Config. A/B experiments (1.7+) on its parameters record exposures themselves. |
| Offers (optional, RevflareStore) | `store.purchase(_:promotionalOffer:)`, `store.purchase(_:winBackOffer:)` | Promotional offers signed by the Revflare server (In-App Purchase key) and iOS 18 win-back offers, for lapsed subscribers (`store.isLapsed(entitlement:)`). |
| Meta Ads (optional, opt-in) | `Revflare.setMetaAnonymousID(_:)` / `Revflare.collectDeviceIdentifiers()` | Sends device identifiers to Revflare so Revflare can send purchases to Meta's Conversions API. Tracking data: only after consent. |

## 1. Before editing

- Find the app's project (`project.yml` for XcodeGen, else the `.xcodeproj`), its bundle id, and how it buys today:
  `grep -rn "import RevenueCat\|Purchases.configure\|product.purchase\|Transaction.updates" --include=*.swift`.
- Get the app's SDK key (`rfp_…`, not a secret): `revflare sdk-key <app name or bundle id>` (see the `revflare`
  skill), or Revflare web → Apps → the app → Apple Ads attribution. The server URL is the user's Revflare instance
  (`revflare whoami` shows it). Never invent keys.
- Check the app's other branches / uncommitted work before changing purchase code; ask before replacing RevenueCat.

## 2. Add the package

RevflareKit is its own Swift package: `https://github.com/FerdiKT/RevflareKit` (private mirror of `sdk/ios`, tags =
`Revflare.version`; Xcode needs a GitHub account with access — Xcode → Settings → Accounts).

```yaml
# project.yml (XcodeGen)
packages:
  RevflareKit:
    url: https://github.com/FerdiKT/RevflareKit
    from: 1.9.2
targets:
  MyApp:
    dependencies:
      - package: RevflareKit
```

Then `xcodegen generate`. Plain Xcode: File → Add Package Dependencies… → the URL above. Apps that still use a local
path (`path: ../revflare/sdk/ios`) or a vendored copy should switch to the URL when they are next touched. Changing
RevflareKit itself: edit `sdk/ios` in the Revflare repo (local path while developing), bump `Revflare.version`, then
`scripts/publish-revflarekit.sh` (the workflow does it on push) publishes and tags the mirror.

## 3. Attribution (every app)

```swift
import RevflareKit

// App.init() or application(_:didFinishLaunchingWithOptions:) — once
Revflare.configure(sdkKey: "rfp_…", server: URL(string: "https://<revflare-host>")!)
```

- Buying with StoreKit 2 directly: `try await product.purchase(options: Revflare.purchaseOptions)` (appAccountToken =
  install id → linked immediately). If the app already uses appAccountToken for its own user id, keep it.
- With RevenueCat: just `configure`; optionally `Revflare.syncPurchases()` after a successful purchase.
- Debug: `Revflare.debugLogging = true` before `configure`; Console filter `app.revflare.kit`.
- **Test and debug data (1.8+): don't branch analytics on `DEBUG` any more.** Configure RevflareKit and `track` in
  every build: each request carries `environment` (`xcode` for Simulator / debugger attached / Xcode StoreKit
  transactions, `sandbox` for TestFlight and sandbox accounts (receipt `sandboxReceipt`), else `production`;
  detected on the device, no network, no `AppTransaction.shared` prompt). Revflare excludes `sandbox` / `xcode` from
  its analytics by default (web toggle "Include test data"). Remove existing `#if DEBUG` guards around
  `Revflare.configure` / `track` when updating an app. Force it only when detection can't know (internal non-TestFlight
  build): `Revflare.configure(sdkKey:server:environment: .sandbox)` (`.automatic` default, `.production`, `.sandbox`,
  `.xcode`); `Revflare.environment` gives the resolved value. Testers on App Store builds: add their install id
  (`Revflare.installId`, e.g. on a debug screen) under Revflare web → the app → Excluded install ids.
- `Revflare.attribution` (1.8+, read only): `RevflareAttribution` with `source` `.appleAds` / `.organic` / `.unknown`
  and `campaignId` / `adGroupId` / `keywordId`; `Revflare.attributionDidChangeNotification`. `unknown` until Apple
  answers (RevflareKit re-asks 1, 5, 15, 60 min, then every 3 h, up to 24 h).

## 4. Replacing RevenueCat with RevflareStore (only when the user asks)

1. Read the RevenueCat setup: offerings/packages → product ids, entitlements → products (`revenuecat offerings list`,
   `revenuecat products list`, `revenuecat entitlements list`). If the app uses offerings, recreate them (section 5).
2. `@StateObject private var store = Revflare.configurePurchases(entitlements: ["pro": [...]])` (products come from
   the offerings) or `configurePurchases(productIds: [...], entitlements: [...])` (fixed list) at launch, after
   `Revflare.configure`, then `.environmentObject(store)`.
3. Map calls (README "Migrating from RevenueCat" table): `Purchases.shared.offerings()` → `Revflare.offerings()` /
   `store.offerings`; `offerings.current` → same; `currentOffering(forPlacement:)` / `getCurrentOffering(forPlacement:)`
   → `offering(forPlacement:)`; `availablePackages` → `packages`; `package.storeProduct` → `package.product`;
   `purchase(package:)` → `try await store.purchase(package)` (`.purchased` / `.userCancelled` / `.pending`);
   `entitlements.active["pro"]` → `store.isActive("pro")`; `restorePurchases()` → `try await store.restore()`; intro
   offers → `store.eligibleIntroOffer(for:)`; lifetime → `store.entitlement(named:)?.isLifetime`. Paywall is the
   app's own SwiftUI view (RevenueCatUI has no equivalent).
4. Remove the RevenueCat package, API key, `import RevenueCat` / `RevenueCatUI`; existing customers keep access
   (StoreKit 2 `currentEntitlements`, no restore needed).
5. Test with a StoreKit configuration file: prices, purchase unlocks, cancel does nothing, restore works.
6. Afterwards (user's consent): point App Store Server Notifications at Revflare, or keep RevenueCat's URL and set
   Revflare's forwarding; update the App Privacy answers.

## 5. Offerings and placements (paywalls changed without an app update)

1. Create them on the server: Revflare web → Apps → the app → Offerings, or the CLI:
   `revflare offerings <app> list | show <id> | apply <file.json> | current <id> | placements`. An offering = id,
   display name, packages (`$weekly`, `$monthly`, `$annual`, `$lifetime`... or custom ids → App Store product ids, in
   display order) and free-form JSON metadata; placements (`onboarding`, `settings`...) map to an offering or to
   none (= current). Product ids must exist in App Store Connect (and the StoreKit configuration file for tests).
2. In the app (needs `Revflare.configure` first):

   ```swift
   // With RevflareStore: store.offerings loads at start/foreground for configurePurchases(entitlements:) stores;
   // configurePurchases(productIds:...) stores load them only on await store.loadOfferings().
   let offering = store.offering(forPlacement: "onboarding")      // placement → its offering, else current
   ForEach(offering?.packages ?? []) { package in                  // server order; unavailable products left out
       Text(package.product.displayPrice)                           // package.metadata["badge"]?.stringValue
   }
   try await store.purchase(package)

   // Without RevflareStore:
   let offerings = try await Revflare.offerings()                   // .cachedOrFetched (5 min) or .fetchCurrent
   try await package.product.purchase(options: Revflare.purchaseOptions)
   ```

   Metadata: `offering.metadata["title"]?.stringValue`, `offering.metadata("key", as: T.self)`,
   `try offering.decodeMetadata(MyConfig.self)`. Shortcuts: `offering.annual`, `.weekly`, `.lifetime`,
   `package(identifier:)`.
3. Offline: the last good answer is cached on the device (ETag / 304) and used when the server can't be reached; on
   a first launch offline `Revflare.offerings()` throws: show a retry (`loadOfferings(fetchPolicy: .fetchCurrent)`).
4. Several paywalls = several placements; never hard-code product ids in a paywall that uses offerings.

## 5b. Server-driven entitlements and passes (1.9+): new products without an app update

- Revflare (web → the app → Offerings → Entitlements, `revflare entitlements <app> set|add-product|remove-product|rm|
  duration`, MCP `set_entitlements`) holds entitlement → product ids and non-renewing durations. `RevflareStore` gets
  them inside the offerings answer, merges them with the app's map (union per entitlement: the server only adds;
  `store.mapping`, the app's part in `store.localMapping`), keeps them on the device per server + SDK key (applied at
  launch, offline too) and loads their products. `configurePurchases(productIds:entitlements:)` stores do this with
  one cached request at start / foreground and do **not** load offerings or add offering packages to
  `store.products` (as in 1.8). So a new product (e.g. a 3-day pass) is sold by adding it in App Store Connect, to an
  offering and to `pro` in Revflare: no app update.
- Rule: **a server configuration never takes access away from a paying user.** Hence:
  - durations apply **only to non-renewing subscriptions**; non-consumables are always lifetime (the server also
    refuses durations for known non-consumable / auto-renewable products);
  - **app-declared products are protected**: a server duration never applies to a product the app lists in
    `productIds:` / `entitlements:` (`store.declaredProductIds`) unless the app also sets a local duration for it in
    `nonRenewingDurations:` (then the local one applies). Server durations are for new products added in Revflare.
- Passes = `Non-Renewing Subscription`: StoreKit gives no expiry, so without a duration they are lifetime. A pass the
  app declares needs its duration in the app: `configurePurchases(..., nonRenewingDurations:
  ["com.example.app.pass_3day": .days(3)])`; a pass added later only in Revflare takes the Revflare duration
  (`revflare entitlements <app> duration <id> 3d`). Then `entitlement(named:)?.expirationDate` = purchase + duration
  (UTC calendar), `isLifetime == false`, repeat purchases **stack** (from the later of purchase / current expiry;
  history read once and cached until a transaction update / purchase / restore or until
  `Transaction.currentEntitlements` shows another latest pass transaction), refunds excluded (passes after a
  refunded one move earlier), access ends on time (timer + foreground). Since **1.9.1** a pass product counts only
  while `Transaction.currentEntitlements` has a transaction of it: deleted transactions (Xcode "Delete transactions")
  or a refund whose update never reached the app end the pass on the next refresh / foreground. Apps on 1.9.0 that
  sell passes should update to 1.9.1 (1.9.0 kept granting after deleted / refunded passes). A lifetime purchase wins over a pass.
- **Remove app-side workarounds** when updating an app to 1.9 (own pass timers, "pass counts as lifetime" fixes,
  `purchaseDate + duration` checks): read `store.entitlement(named: "pro")` (`isLifetime`, `expirationDate`) directly.
- Server: Revflare stores purchase + duration as each pass's expiry (no stacking there, so a stacked pass can end later
  on the device than in the dashboard; recomputed for past sales); passes stay one-time revenue (never MRR). A 1.9 app
  against a pre-1.9 server gets no server map and uses its own map and durations only.

## 6. Events and funnels

Revflare's funnels ("where users drop off") come from events RevflareKit sends to the user's server (stored in
Workers Analytics Engine, tied to the random install id; not tracking). After `Revflare.configure`, these are
automatic: `first_open` (once per install; apps updating from ≤ 1.3 get none), `app_open` (each launch),
`session_start` (launch, or back after ≥ 30 min in background), `app_background`, and with RevflareStore
`purchase_start` / `purchase_success` / `purchase_cancel` / `purchase_pending` / `purchase_failed` (`error`),
`restore_start` / `restore_success` / `restore_failed` (props `product`, `offering`, `package`, `placement`).

What to instrument (ask the user which flows matter; don't spray events everywhere):

1. **Onboarding steps**, with stable names: one event + a step prop
   (`Revflare.track("onboarding_step", properties: ["step": 2, "name": "notifications"])`) or one name per step
   (`onboarding_1_welcome`, `onboarding_2_notifications`, …). Track when the step is *shown* (`onAppear`), plus a
   final `onboarding_complete`.
2. **Paywall views** with the placement: `Revflare.trackPaywallView(placement: "onboarding", offering: offering)` in
   the paywall's `onAppear` (RevflareKit can't detect paywalls); `trackPaywallClose` when dismissed without buying.
   With RevflareStore pass the placement to the purchase: `try await store.purchase(package, placement: "onboarding")`.
   Apps buying through RevenueCat / their own StoreKit code: `Revflare.track("purchase_start", properties: [...])`
   etc. around their purchase call, same names, so the same funnels work.
3. **Key feature usage** that predicts conversion or retention (`export_pdf`, `scan_completed`, `signup` with
   `method`).

Naming: `snake_case`, verb or noun_verb, 1-64 chars of `A-Z a-z 0-9 _ . : -`; never rename a shipped event (funnels
match names; old versions keep sending the old one). Props: ≤ 10, keys `A-Z a-z 0-9 _ . -` ≤ 40, values become
strings ≤ 100 chars (numbers / bools are converted, arrays / dicts dropped). **No personal data** (names, emails,
free text, user ids) in names or props. `Revflare.debugLogging = true` shows dropped events.

Opt-out: if the app has an analytics consent / "share analytics" switch, bind it to `Revflare.analyticsEnabled`
(persisted; `false` deletes the queue and stops collecting). Set it before `configure` for users who already
declined.

Then define the funnel on the server: Revflare web → the app → **Funnels**, or the CLI `revflare funnels` (see the
`revflare` skill): ordered steps = event names (optionally a prop filter such as `step = 2` or
`placement = onboarding`). Events appear within a minute of a flush (launch, every 30 s, 50 queued, background).

## 7. Remote config (feature flags, A/B variants, Firebase Remote Config replacement)

Parameters (key, type string / number / boolean / json, default value, conditional values picked by ordered
conditions: country = App Store storefront (else IP country), app version, language, percentage rollout) live on the
server: Revflare web → the app → **Remote config**, or `revflare config <app> ...`. App side:

```swift
// App.init, before configure (configure then fetches + activates in the background):
Revflare.remoteConfig.setDefaults(["onboarding_version": "v1", "max_free_accounts": 1, "show_sale": false])
Revflare.configure(sdkKey: "rfp_…", server: URL(string: "https://<revflare-host>")!)

// Anywhere on the main actor (getters never fail: remote → setDefaults → default: argument):
let config = Revflare.remoteConfig                    // @MainActor ObservableObject: @ObservedObject in views
config.string("onboarding_version"); config.bool("show_sale"); config.int("max_free_accounts", default: 1)
config.decode("paywall", as: PaywallConfig.self)      // json params (or strings holding JSON)
config["paywall"]?["title"]?.stringValue; config.source(for: "k")   // .remote / .default / .static
```

- Last activated values persist on the device and apply at once at the next launch (offline OK). One fetch per
  launch (ETag / 304), and on foreground when older than `minimumFetchInterval` (1 h; `0` in DEBUG to iterate).
- First screen depends on a value (onboarding variant)? Show a splash until `config.isLoaded` (true when cached values
  were applied or the first fetch attempt ended) or `await config.fetchAndActivate(timeout: 3)` (joins the launch
  fetch, never throws; `true` when the server answered in time).
- No mid-session changes wanted: `autoFetch = false` before `configure`, then `activate()` at launch + `fetch()` in
  the background (applied next launch).
- A/B experiments (1.7+): set up in Revflare web → the app → **Experiments** (parameters, variants with values,
  split, audience). The server resolves the device's variant into the values; the app just reads the parameters.
  The first read (any getter / subscript / decode) of an enrolled experiment's parameter tracks `experiment_exposure`
  whatever the value's source (the control may keep the `setDefaults` / `default:` value; it counts the same)
  (`experiment: "exp_paywall1"`, `variant: "exp_paywall1:b"`), once per install + experiment + variant (persisted;
  re-sent after a re-assignment; nothing while `analyticsEnabled` is false). **Read the parameter where the user
  sees the variant** (paywall `onAppear`, the onboarding step), never at launch to precompute, or results are
  diluted. Branching without reading a parameter:
  `if config.variant(forExperiment: "exp_onboarding") == "short" { config.trackExposure(experiment: "exp_onboarding"); ... }`.
  Also `config.experiments` (`[RevflareExperiment]`: id, variant, keys; `@Published`) and `config.experiment(id)`.
  Results per variant (conversion, revenue, retention; purchases joined by install id, no extra props) in Revflare
  web → the app → Experiments.
- Targeting by acquisition source (1.8+): config requests carry `source` (`apple_ads` / `organic` / `unknown`) and
  the Apple Ads `campaign` / `adGroup` / `keyword` ids, so a conditional value can target e.g. **Source in
  [apple_ads]** (optionally a campaign) → `paywall_mode = hard`. App side: `setDefaults(["paywall_mode": "soft"])`
  (the soft default also covers `unknown`: first launch before Apple answered) and `await
  config.fetchAndActivate(timeout: 3)` right before showing the paywall. A new install's first fetch waits up to 3 s
  for the first attribution answer; when the source resolves later, RevflareKit refetches into the pending slot
  (never changes values on screen): applied by `fetchAndActivate` / `activate()`, the next foreground (autoFetch) or
  the next launch. `config.attribution` is the `@Published` copy.
- Funnels split by variant: send it with events:
  `Revflare.track("onboarding_complete", properties: ["variant": config.string("paywall_variant")])`.
  `config.conditions` lists the matched condition names.

**Migrating from Firebase Remote Config** (ask before removing Firebase):

1. Export the console config: `firebase remoteconfig:get --project <firebase-project-id> -o rc.json` (needs
   `firebase login`), then `revflare config <app> import-firebase rc.json`; review the conditions in Revflare web → the app → Remote config.
2. Find the app's usage: `grep -rn "RemoteConfig\|remoteConfig\|configValue(forKey" --include=*.swift` (often a
   `RemoteConfigService` wrapper). Keep the wrapper's interface and swap its body:
   `RemoteConfig.remoteConfig()` → `Revflare.remoteConfig`; `setDefaults(fromPlist:)` → `setDefaults(plistNamed:)`;
   `fetchAndActivate { status, _ in }` → `await Revflare.remoteConfig.fetchAndActivate()` (or rely on `configure`);
   `configValue(forKey: k).stringValue` / `.boolValue` / `.numberValue.intValue` / `.jsonValue` →
   `string(k)` / `bool(k)` / `int(k)` / `json(k)` or `decode(k, as:)`; `lastFetchStatus` / `lastFetchTime` →
   `lastFetchStatus` / `lastFetchDate`; `addOnConfigUpdateListener` → observe `Revflare.remoteConfig`
   (`@ObservedObject` / `objectWillChange`). Calls are `@MainActor`: hop with `await MainActor.run { }` from
   background code.
3. Remove the `FirebaseRemoteConfig` product (SPM / Podfile / project.yml). If nothing else uses Firebase (Analytics,
   Crashlytics, Messaging, Auth...), also remove `FirebaseApp.configure()`, `GoogleService-Info.plist` and the
   Firebase package, and update the App Privacy answers.
4. Build; run once with `Revflare.debugLogging = true` and check `Remote config: fetched version …` in the log.

## 8. Promotional and win-back offers (1.6+, lapsed subscribers)

1. App Store Connect: create the offer on the subscription (promotional offer id, e.g. `comeback50`; or a win-back
   offer, iOS 18+, with its eligibility rules).
2. Promotional offers only (win-back needs no signature): upload the **In-App Purchase key** (`.p8` + key id, App
   Store Connect → Users and Access → Integrations → In-App Purchase) and allowlist the product id + offer id pairs in
   Revflare web → the app → **Offers**. Missing key → `RevflareOfferError.notConfigured` (409); pair not allowlisted
   → `.notAllowed` (403); `.rateLimited(retryAfter:)` (429).
3. App side, with RevflareStore:

   ```swift
   guard store.isLapsed(entitlement: "pro") else { return }       // expired, no access, NOT in grace / billing retry
   if #available(iOS 18.0, *), let offer = await store.winBackOffers(for: product).first {
       try await store.purchase(product, winBackOffer: offer, placement: "winback")
   } else if let offer = await store.promotionalOffers(for: product)   // [] unless they have/had a sub in the group
                 .first(where: { $0.id == Revflare.remoteConfig.string("winback_offer") }) {
       try await store.purchase(product, promotionalOffer: offer.id!, placement: "winback")   // signs (≤ 10 s), buys
   }
   ```

   Also for packages (`store.purchase(package, promotionalOffer:)`). Without RevflareStore:
   `let sig = try await Revflare.promotionalOfferSignature(productId:offerId:)` then
   `product.purchase(options: sig.purchaseOptions())` (includes the signed appAccountToken; never add another one).
- Customers in billing grace / retry are still subscribers: show "update your payment method" (link
  `https://apps.apple.com/account/subscriptions`), not a discount. Choose the offer via remote config so it changes
  without an app update.
- The purchase option is the JWS form with the iOS 26 SDK (Xcode 26+, back-deployed to iOS 15), else legacy; nothing to
  do in the app. Events carry `offer` and `offer_type` (`promotional` / `win_back`): funnels / revenue can split on them.
- Test promotional offers in sandbox / TestFlight (the server signs with the real key); a StoreKit configuration file
  needs its own key and won't accept the server's signature.

## 9. Meta (Facebook) Ads (only when the user wants Meta campaigns optimized on purchases)

Server side: Revflare web → the app → Integrations → Meta Ads (dataset id + Conversions API token), or
`revflare meta <app> set ...`. App side:

```swift
// After the app's own consent flow (and after configuring the Facebook SDK, if the app has it):
Revflare.setMetaAnonymousID(AppEvents.shared.anonymousID)

// After the App Tracking Transparency prompt completes (ask before purchases for IDFA matching;
// Info.plist NSUserTrackingUsageDescription):
_ = await ATTrackingManager.requestTrackingAuthorization()
Revflare.collectDeviceIdentifiers()   // also the opt-in for apps without the Facebook SDK
```

- If the app has the Facebook SDK: turn off its automatic purchase logging (`Settings.shared.isAutoLogAppEventsEnabled
  = false` or Meta dashboard → Log In-App Events Automatically = No), otherwise purchases count twice.
- Purchases must be tied to the install (`Revflare.purchaseOptions` or the attribution part above).
- Without the Facebook SDK, Meta can only match users who allowed tracking (IDFA); say so to the user.
- Never call the Meta opt-ins for users who declined. Privacy label: Identifiers (Device ID, User ID) and Purchases
  used for Third-Party Advertising and tracking.
- Verify: `revflare meta <app> test` (with a test event code), then `revflare meta <app> log` after a sandbox or real
  purchase (skip reasons explain missing identifiers / ATT).

## 10. App Store privacy answers

- Attribution / purchases only: data goes to the developer's own server for analytics, not tracking. If the app
  already declares Purchases → Purchase History for analytics, nothing new; otherwise Purchase History (+ Device ID if
  the install id is counted as one) for Analytics, not linked to tracking.
- Events (1.4+, on unless `analyticsEnabled = false`): add **Usage Data → Product Interaction** for Analytics, not
  linked to tracking (app-usage analytics tied to the random install id, sent only to the developer's server).
- With the Meta opt-in: tracking data (see section 9). Offerings send nothing about the user (SDK key + app version).
- Remote config (1.5+) sends the install id, app version / build, OS version, locale and storefront country to the
  developer's server to pick values: no new data type beyond what events / attribution already declare.
- 1.5.1 adds the time RevflareKit first ran on the device (`installedAt`) to its reports (install time for LTV by
  acquisition source): no new data type; nothing to change in the app.
- 1.6.0 promotional offers send the install id, product / offer ids and appAccountToken to the developer's server to
  sign the offer (only when buying with one): no new data type.
- 1.7.0 experiments add one event (`experiment_exposure`) to the existing usage events: no new data type.
- 1.8.0 adds the build `environment` (production / sandbox / xcode) to requests and the acquisition source (resolved
  by the developer's server) to config requests: no new data type, privacy answers unchanged.
- 1.9.0 (server entitlements, pass durations) reads the existing offerings endpoint only: no new data type. 1.9.1
  (pass history validated against current transactions) changes nothing collected.

## 11. Finish

- Build the app (`xcodebuild ... build`), run on a device if possible, check the Console log for the first report.
- `revflare attribution --app <app>` shows coverage once installs report (after release); funnels fill as events
  arrive (Revflare web → the app → Funnels).
- Mention the RevflareKit version the app now uses. When RevflareKit changes, update this skill and
  `sdk/ios/README.md` together.

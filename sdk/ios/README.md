# RevflareKit

Apple Ads attribution for [Revflare](../../README.md), the self-hosted in-app purchase revenue tracker, and an
optional StoreKit 2 purchases / entitlements layer (`RevflareStore`) for apps that want to drop RevenueCat.

Add the package, call `Revflare.configure(sdkKey:server:)` once at launch with the app's SDK key and your Revflare
server, and Revflare shows revenue per Apple Ads campaign, ad group and keyword (Revflare web → Apple Ads, `revflare` CLI, MCP `get_attributed_revenue`).

Version **1.9.2** (`Revflare.version`). [Changes](#changes).

- iOS 15+ (also builds for macOS 12+). No dependencies. No UI, no permission prompt.
- Never blocks the main thread: everything runs in the background, in one actor.
- Attribution never finishes, restores or buys anything: StoreKit is only read. Safe next to RevenueCat.
- [Purchases](#purchases) (`RevflareStore`) is opt-in: it buys, restores and finishes transactions, so it replaces
  RevenueCat in an app; it must not run next to it.
- [Offerings and paywalls](#offerings-and-paywalls): which products each paywall shows, set in Revflare and fetched
  at runtime (like RevenueCat offerings), so paywalls change without an app update.
- [Events and funnels](#events-and-funnels): app-usage events (onboarding steps, paywall views, purchases) tied to
  the random install id, for the funnels in Revflare. On by default, off with `Revflare.analyticsEnabled = false`.
- [Remote config](#remote-config): parameters set in Revflare with values chosen per device by conditions (country,
  app version, language, percentage rollout), cached on the device. Replaces Firebase Remote Config.
  [Experiments](#experiments) (1.7): A/B tests on those parameters, with exposures recorded automatically.
  [Targeting by acquisition source](#targeting-by-acquisition-source) (1.8): Apple Ads campaign / ad group / keyword
  or organic as conditions (e.g. a hard paywall for Apple Ads installs).
- [Test and debug data](#test-and-debug-data) (1.8): every request says whether it comes from Xcode, TestFlight /
  sandbox or production, so Revflare keeps test data out of its numbers; no more `#if DEBUG` around analytics.
- [Server-driven entitlements and passes](#server-driven-entitlements-and-passes) (1.9): which products unlock an
  entitlement and how long a non-renewing pass lasts, set in Revflare: a new paid product needs no app update.
- [Promotional and win-back offers](#promotional-and-win-back-offers) (1.6): promotional offers signed by your
  Revflare server with the app's In-App Purchase key, and iOS 18 win-back offers, for lapsed subscribers.

## What it does

1. **Attribution token.** On the first launch it asks AdServices for the install's attribution token
   (`AAAttribution.attributionToken()`) and sends it to `POST /sdk/v1/report` with a random install id. Revflare asks
   Apple which campaign / ad group / keyword brought the install (or that it was organic). Network errors are retried
   with backoff (1, 2, 4… minutes, at most 6 h) on later launches and foregrounds; the token is sent once the server
   has taken it (`pending`: the server keeps asking Apple on its own; `resolved`; `failed`), and given up 24 hours
   after the first attempt, when it has expired. The answer also carries the resolved `source` (`apple_ads`,
   `organic`, or `unknown` while Apple has not answered) and the campaign / ad group / keyword ids. While it is
   `unknown`, RevflareKit asks again with a token-less report (install id only) 1, 5, 15 and 60 minutes later, then
   every 3 hours, up to 24 hours after the first launch (at launch / foreground passes, and in-process for the short
   delays), and stops as soon as the source is known: `Revflare.attribution`.
2. **Purchase links.** At launch, when the app comes to the foreground (at most once a minute) and when StoreKit's
   `Transaction.updates` yields, it reads StoreKit 2 `Transaction.all` and `Transaction.currentEntitlements` (verified
   transactions the user bought, not family-shared ones), and reports the original transaction ids it has not
   reported yet, in batches of 90. Revflare already has the purchases from App Store Server Notifications; the link
   puts their revenue on the install's campaign. Reported ids are remembered in UserDefaults.
3. **Install id.** `Revflare.installId` is a random UUID created once and kept in the keychain (this device only, not
   synced to iCloud) with a UserDefaults copy. Keychain items currently survive deleting and reinstalling the app on
   iOS, so a reinstall keeps its id. Apps that buy with StoreKit 2 can pass it as `appAccountToken`, which links the
   purchase on the server immediately.

## Privacy

What RevflareKit sends, only to the Revflare server you configure (your own server; nothing goes to a third party):

| Field | What it is |
| --- | --- |
| `installId` | A random UUID made by RevflareKit. Not the IDFA, not the IDFV, not derived from the device or the user. |
| `attributionToken` | Apple's AdServices attribution token, once per install. |
| `originalTransactionIds` | The App Store original transaction ids of purchases made in this app. |
| `appVersion` | `CFBundleShortVersionString`. |
| `installedAt` | When RevflareKit first ran on the device (the install time for LTV by acquisition source). |
| Remote config (`GET /sdk/v1/config`) | The install id, app version / build, OS version, locale and App Store storefront country, to resolve the parameters' conditions. Turn off with `Revflare.remoteConfig.autoFetch = false` (and no `fetch` calls). |
| Events (`POST /sdk/v1/events`) | App-usage analytics for funnels: event names, times, a random session id, the properties the app passes, app version / build, OS version and locale, tied to the random install id. Not used for tracking. Off with `Revflare.analyticsEnabled = false`. See [Events and funnels](#events-and-funnels). |

Only after the app opts in with `Revflare.setMetaAnonymousID` or `Revflare.collectDeviceIdentifiers` (see
[Meta (Facebook) ads](#meta-facebook-ads)), a separate request (`POST /sdk/v1/identifiers`) carries device identifiers
for Meta matching. Without that opt-in, RevflareKit collects no name, email, IDFA, IDFV, location or device
identifiers.
`Revflare.offerings()` only sends the SDK key and the app version (`GET /sdk/v1/offerings`).
[Remote config](#remote-config) (`GET /sdk/v1/config`, at launch and on foreground) sends the random install id (for
percentage rollouts), the app version and build, the OS version, the locale and the App Store storefront country, so
the server can pick the values; nothing else.
[Promotional offers](#promotional-and-win-back-offers) (`POST /sdk/v1/offers/sign`, only when the app buys with one)
send the install id, the product and offer ids and the purchase's `appAccountToken` (the install id by default).
Every request also says which `environment` the build runs in (`production`, `sandbox`, `xcode`) and the config
request carries the install's acquisition source (which Revflare resolved itself from the token): neither is a new
data type. (Like any HTTP request, the server sees the request's IP address.)

What Apple documents:

- The AdServices framework is Apple's privacy-preserving attribution for Apple Ads. Requesting the token **does not
  require App Tracking Transparency permission**, and RevflareKit never asks for it. When the user has not allowed
  tracking, Apple returns its standard attribution data; a few fields (detailed attribution) are only returned when
  the user has allowed tracking.
- Apple does not publish a dedicated App Store privacy label rule for AdServices. The App Store privacy questions
  are about data *you* (and your partners) collect from the app; that includes data sent to your own server.

How to answer the App Store privacy questions is your call. A careful reading: the install id together with purchase
ids is used for your own analytics (measuring your ads), it is not used for tracking across other companies' apps or
websites, and it is not used for advertising. If you already declare **Purchases → Purchase History** for analytics
(most apps that use RevenueCat or a revenue tracker do), RevflareKit adds nothing new; otherwise consider declaring
**Purchases → Purchase History** and **Identifiers → Device ID** (if you count an install id as such) for
*Analytics*, *not used for tracking*. Do **not** answer "used to track you": no data is linked with third-party data.
The [events](#events-and-funnels) add **Usage Data → Product Interaction** for *Analytics*, *not linked to tracking*
(unless the app turns them off).
This changes if the app opts in to [Meta (Facebook) ads](#meta-facebook-ads): see its privacy notes.

## Installation (Swift Package Manager)

RevflareKit is published as its own Swift package, **https://github.com/FerdiKT/RevflareKit** (a read-only mirror of
`sdk/ios` in the Revflare repository, tagged with `Revflare.version`). The mirror is private for now: Xcode needs a
GitHub account with access to it (Xcode → Settings → Accounts), and Xcode Cloud / CI need access granted to that
repository.

- **Xcode:** File → Add Package Dependencies… → `https://github.com/FerdiKT/RevflareKit` → Up to Next Major from
  `1.9.2`, then add the `RevflareKit` library to the app target.
- **XcodeGen** (`project.yml`):

  ```yaml
  packages:
    RevflareKit:
      url: https://github.com/FerdiKT/RevflareKit
      from: 1.9.2
  targets:
    MyApp:
      dependencies:
        - package: RevflareKit
  ```

- **Package.swift:**

  ```swift
  .package(url: "https://github.com/FerdiKT/RevflareKit", from: "1.9.2")
  // target dependency: .product(name: "RevflareKit", package: "RevflareKit")
  ```

Working on RevflareKit itself: use a local path to a clone of Revflare instead (`path: ../revflare/sdk/ios` in
XcodeGen, Add Local… in Xcode) and send changes to the Revflare repository; `scripts/publish-revflarekit.sh` (and the
`revflarekit-publish` workflow) push `sdk/ios` to the mirror and tag new versions.

License: [MIT](LICENSE) (the Revflare server is source available under the PolyForm Noncommercial License with commercial licenses; the SDK that ships inside apps is MIT and free for any use).

## The SDK key

Revflare web → **Apps** → the app → **Apple Ads attribution**. The key (`rfp_…`) identifies the app; it is not a
secret (it can only add reports for that app). Rotating it there stops installs of builds that embed the old key from
reporting. The CLI shows it too: `revflare sdk-key <app>`.

## Integration

### SwiftUI app with StoreKit 2

```swift
import SwiftUI
import StoreKit
import RevflareKit

@main
struct MyApp: App {
    init() {
        Revflare.configure(sdkKey: "rfp_…", server: URL(string: "https://revflare.example.com")!)
    }

    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

// Where the app buys: link the purchase to this install right away.
func buy(_ product: Product) async throws {
    let result = try await product.purchase(options: Revflare.purchaseOptions)
    // or: options: [.appAccountToken(Revflare.installId), …other options]
    if case .success(let verification) = result, case .verified(let transaction) = verification {
        // unlock content…
        await transaction.finish()
    }
}
```

If the app already uses `appAccountToken` for its own user id, keep it: the purchase is still linked through its
original transaction id (step 2 above).

### UIKit app

```swift
import UIKit
import RevflareKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        Revflare.configure(sdkKey: "rfp_…", server: URL(string: "https://revflare.example.com")!)
        return true
    }
}
```

### App using RevenueCat

```swift
import SwiftUI
import RevenueCat
import RevflareKit

@main
struct MyApp: App {
    init() {
        Purchases.configure(withAPIKey: "appl_…")
        Revflare.configure(sdkKey: "rfp_…", server: URL(string: "https://revflare.example.com")!)
    }

    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
```

That is all: RevenueCat keeps buying and finishing transactions; RevflareKit only reads StoreKit 2's transaction
list and reports the original transaction ids. A purchase made in this session is linked at the next foreground or
launch; call `Revflare.syncPurchases()` after a successful purchase to link it at once (optional).

## Meta (Facebook) ads

Revflare can send each purchase to Meta's Conversions API as an app event (StartTrial, Subscribe, Purchase with the
sale's value), so Meta Ads sees the revenue of the installs its ads brought. To match a purchase to the ad, Meta needs
device identifiers that only the app can read. This part of RevflareKit is **opt-in**: nothing is collected or sent
until the app calls `Revflare.setMetaAnonymousID(_:)` or `Revflare.collectDeviceIdentifiers()`. RevflareKit does not
depend on the Facebook SDK.

### Setup

1. **Server:** in Revflare web → the app → **Integrations → Meta Ads**, enter the Meta dataset (pixel) id and a
   Conversions API access token (optionally a test event code).
2. **Anonymous id:** after configuring the Facebook SDK (and the user's consent, see [Privacy](#privacy-1)):

   ```swift
   import FacebookCore
   import RevflareKit

   Revflare.setMetaAnonymousID(AppEvents.shared.anonymousID)
   ```

3. **App Tracking Transparency:** for IDFA-level matching, ask with `ATTrackingManager.requestTrackingAuthorization`
   (add `NSUserTrackingUsageDescription` to Info.plist) **before** the user buys, and call
   `Revflare.collectDeviceIdentifiers()` right after the prompt completes, so the IDFA goes out at once:

   ```swift
   import AppTrackingTransparency
   import RevflareKit

   let status = await ATTrackingManager.requestTrackingAuthorization()
   Revflare.collectDeviceIdentifiers()   // also works alone, without a Facebook anonymous id
   ```

   RevflareKit never shows the ATT prompt; it only reads the status, and the IDFA only when the status is
   `authorized`. It also re-checks at launch, on foreground and on transaction updates, and reports again when the
   anonymous id, the IDFA, the IDFV, the ATT status, the app version / build, the OS version or the locale change.
4. **Frameworks:** RevflareKit imports AdSupport and AppTrackingTransparency itself (system frameworks, present on
   every supported iOS version, linked automatically by Swift Package Manager): nothing to add to the target. Linking
   them does nothing by itself; they are only read after the opt-in.

What is sent, to `POST /sdk/v1/identifiers` on your Revflare server (same `X-Revflare-Key` header as the report):

```json
{
  "installId": "0f8fad5b-d9cb-469f-a165-70867728950e",
  "fbAnonId": "XZ5A1B2C3D-0000-4000-8000-000000000001",
  "idfa": null,
  "idfv": "7C9E6679-7425-40DE-944B-E07FC1F90AE7",
  "attStatus": "denied",
  "bundleId": "com.example.app",
  "appVersion": "1.0",
  "appBuild": "1",
  "osVersion": "18.1",
  "deviceModel": "iPhone15,2",
  "locale": "en_US",
  "timeZone": "Europe/Istanbul",
  "extinfo": ["i2", "com.example.app", "1.0", "1", "18.1", "iPhone15,2", "en_US", "GMT+3", "", "393", "852", "3.00", "6", "119", "42", "Europe/Istanbul"]
}
```

`fbAnonId` is null without `setMetaAnonymousID`; `idfa` is null unless `attStatus` is `authorized` (`authorized`,
`denied`, `restricted`, `notDetermined`, `unavailable`); `extinfo` is Meta's device info array. Failures are retried
with backoff on their own and never hold back the attribution token or the purchase links. RevflareKit never logs the
IDFA or IDFV.

### No double counting

Revflare sends the purchases, so the Facebook SDK must not: turn off its automatic in-app purchase logging with
`Settings.shared.isAutoLogAppEventsEnabled = false` (or in the Meta app dashboard → Settings → Platform → **Log In-App
Events Automatically** = No). You may still call `AppEvents.shared.activateApp()` for installs and sessions.

### Purchases must be tied to the install

Revflare can only send a purchase to Meta when it knows which install made it: buy with `Revflare.purchaseOptions`
(`appAccountToken` = install id), or keep RevflareKit's transaction reports (`Revflare.configure`, optionally
`Revflare.syncPurchases()` after a purchase).

### Privacy

- Sent to Meta for ads, these identifiers (and the purchases) are **tracking data** under Apple's definition. Call
  `setMetaAnonymousID` / `collectDeviceIdentifiers` only after the app's own consent flow (and App Tracking
  Transparency where required), and **do not call them for users who declined**.
- The App Store privacy label must declare **Identifiers → Device ID** (and **User ID** for the Facebook anonymous
  id) and **Purchases → Purchase History** as used for **Third-Party Advertising** and **used to track you**.
- The identifiers go to your Revflare server, and from there to Meta with each purchase event.

## Purchases

`RevflareStore` is a small StoreKit 2 store: products, purchase, restore and entitlements, computed on the device
from `Transaction.currentEntitlements` and the subscription statuses. Revflare (App Store Server Notifications) is the
dashboard; no third-party server is involved.

> **One transaction owner per app.** The store listens to `Transaction.updates` for the app's lifetime and **finishes**
> every verified transaction. Do not use it in an app that also uses RevenueCat (or another purchase SDK): keep the
> attribution-only mode there (`Revflare.configure` alone).

### Setup

```swift
import SwiftUI
import RevflareKit

@main
struct MyApp: App {
    // Create the store once, at launch, so it receives every transaction update.
    @StateObject private var store = Revflare.configurePurchases(
        productIds: ["com.example.app.weekly", "com.example.app.annual", "com.example.app.lifetime"],
        entitlements: ["pro": ["com.example.app.weekly", "com.example.app.annual", "com.example.app.lifetime"]]
    )

    init() {
        Revflare.configure(sdkKey: "rfp_…", server: URL(string: "https://revflare.example.com")!)
    }

    var body: some Scene {
        WindowGroup { ContentView().environmentObject(store) }
    }
}
```

`Revflare.configurePurchases` returns the same store on every call and keeps it in `Revflare.store`;
`RevflareStore(productIds:entitlements:)` makes an independent one. At start the store finishes transactions left
unfinished, reads the entitlements (`hasLoadedEntitlements` turns true) and loads the products.

What counts as active:

- non-consumables: always (until refunded); a duration never applies to them;
- non-renewing products: like non-consumables unless they have a duration (a pass): then until purchase + duration,
  repeat purchases stacking (see [Server-driven entitlements and passes](#server-driven-entitlements-and-passes));
- subscriptions: until `expirationDate`, and during a **billing grace period** (`isInGracePeriod`) even after it;
  billing retry without grace, expiry, refund (revocation) and upgrade end access;
- Family Sharing purchases count (`ownership == .familyShared`);
- consumables never.

The store refreshes after every purchase, restore and transaction update, when the app comes to the foreground and when
the next subscription or pass expires while the app is open.

### Server-driven entitlements and passes

Since 1.9 the entitlement map and the durations of non-renewing products can also be set in Revflare (web → the app →
Offerings → Entitlements, `revflare entitlements <app> …`, MCP `set_entitlements`). The store gets them inside the
offerings answer (`GET /sdk/v1/offerings`, same cache and ETag), so a product added in App Store Connect can be sold and
unlock `pro` **without an app update**: add it to an offering and to the entitlement in Revflare.

The rule behind every choice: **a server configuration never takes access away from a paying user.**

- **Merge**: `store.mapping` = the app's own map (`entitlements:`) ∪ Revflare's, per entitlement. The server only adds
  products; the app's map always applies, also offline and with servers before 1.9 (a 1.9 app against an older server
  simply gets no server map); `store.localMapping` is the app's part alone.
- **App-declared products are protected**: a duration set in Revflare never applies to a product the app declares
  itself (`productIds:` or `entitlements:`, `store.declaredProductIds`) unless the app also gives it a local duration
  in `nonRenewingDurations:` (then the local one applies, never the server's). Server durations are for new products
  added in Revflare only.
- **Only non-renewing subscriptions take a duration**: non-consumables are always lifetime (even with a duration set
  by mistake), subscriptions keep their own expiry. Revflare refuses durations for products it knows are
  non-consumable or auto-renewable.
- **Products**: the products of the server entitlements and durations are loaded with the others (`store.products`,
  `store.product(id:)`). A store made with `configurePurchases(productIds:entitlements:)` reads the server part with
  one cached request at start and on foreground (once `Revflare.configure(sdkKey:server:)` was called; without an SDK
  key it stays quiet) and does **not** load the offerings or add their packages to `store.products` (as in 1.8; call
  `await store.loadOfferings()` for that). A store made with `configurePurchases(entitlements:)` loads the offerings
  as before and gets the server part with them.
- **Offline**: the last server mapping and durations are kept on the device (per server + SDK key) and applied at
  launch before the first entitlement check. When they change, the entitlements are recomputed at once.
- **Passes** (`Non-Renewing Subscription` in App Store Connect): StoreKit gives them no expiration date, so without a
  duration they count as lifetime (`isLifetime == true`). With one (in the app with `nonRenewingDurations:`, or set in
  Revflare for a product the app does not declare):
  - `expirationDate` = purchase + duration on the UTC calendar (a day is 24 h; months and years clamp to the month's
    last day), `isLifetime == false`, `willRenew == false`;
  - repeat purchases **stack**: each starts at the later of its purchase and the current expiry (buying a 3-day pass
    on day 1 of an active one gives access until day 6), computed from the `Transaction.all` history of the product
    (read once and cached until a transaction update, purchase or restore, or until `Transaction.currentEntitlements`
    shows a different latest transaction for the pass; 1.9.1);
  - a pass product's history counts only while `Transaction.currentEntitlements` still has a transaction of it: a pass
    whose transactions are gone (StoreKit testing "Delete transactions", a refund or revocation whose update never
    reached the app) stops granting on the next refresh (also on foreground). If StoreKit drops a refunded latest pass
    without showing an earlier one, the earlier stacked passes of that product stop counting too;
  - refunded (revoked) passes give nothing and do not extend others: the passes bought after a refunded one in a
    stack move earlier (start and end sooner);
  - access ends on time: the store refreshes at the earliest expiry while the app is open, and on foreground;
  - a lifetime purchase granting the same entitlement wins over a pass.
- **Revflare**: purchases are reported as before; the server stores purchase + duration as each pass's expiry (each
  pass its own period, no stacking server-side; also recomputed for past sales when you set a duration later). So for
  stacked passes the expiry on the device (stacked) can be later than the one in the dashboard (per purchase). Passes
  are one-time revenue there, never MRR.

```swift
let store = Revflare.configurePurchases(
    productIds: ["com.example.app.annual", "com.example.app.pass_3day"],
    entitlements: ["pro": ["com.example.app.annual", "com.example.app.pass_3day"]],
    // Required here: the pass is declared above, so a duration set in Revflare would not apply to it.
    nonRenewingDurations: ["com.example.app.pass_3day": .days(3)]
)
// store.entitlement(named: "pro")?.expirationDate: when the pass (stacked) ends; isLifetime is false.
```

`NonRenewingDuration`: `.days(n)`, `.weeks(n)`, `.months(n)`, `.years(n)`, `end(from:)`.

### Paywall (SwiftUI)

```swift
import SwiftUI
import StoreKit
import RevflareKit

struct PaywallView: View {
    @EnvironmentObject private var store: RevflareStore
    @Environment(\.dismiss) private var dismiss
    @State private var selected: Product?
    @State private var error: String?

    var body: some View {
        VStack(spacing: 16) {
            Text("Go Pro").font(.largeTitle.bold())
            if store.products.isEmpty {
                if store.isLoadingProducts { ProgressView() }
                else { Button("Try again") { Task { await store.loadProducts() } } }
            }
            ForEach(store.products, id: \.id) { product in
                Button { selected = product } label: {
                    HStack {
                        VStack(alignment: .leading) {
                            Text(product.displayName).bold()
                            // Only promise a trial the customer can actually get.
                            if let intro = store.eligibleIntroOffer(for: product), intro.paymentMode == .freeTrial {
                                Text("Free trial, then \(product.displayPrice)")
                            }
                        }
                        Spacer()
                        Text(product.displayPrice)
                    }
                    .padding()
                    .background(selected?.id == product.id ? Color.accentColor.opacity(0.2) : Color.clear,
                                in: RoundedRectangle(cornerRadius: 12))
                }
            }
            Button(store.isPurchasing ? "…" : "Continue") {
                guard let selected else { return }
                Task {
                    do {
                        if try await store.purchase(selected).isPurchased { dismiss() }
                        // .userCancelled: nothing to do; .pending: Ask to Buy, unlocked when approved.
                    } catch {
                        self.error = error.localizedDescription
                    }
                }
            }
            .disabled(selected == nil || store.isPurchasing)
            Button("Restore Purchases") {
                Task {
                    do { try await store.restore() } catch { self.error = error.localizedDescription }
                }
            }
        }
        .padding()
        .onAppear { selected = selected ?? store.products.first }
        .onChange(of: store.isActive("pro")) { isPro in if isPro { dismiss() } }
        .alert("Purchase failed", isPresented: .constant(error != nil)) { Button("OK") { error = nil } } message: { Text(error ?? "") }
    }
}

// Gate content anywhere:
struct ContentView: View {
    @EnvironmentObject private var store: RevflareStore
    var body: some View {
        if store.isActive("pro") { Text("Thanks for being Pro") } else { Text("Free version") }
    }
}
```

Subscription details for a settings screen: `store.subscription(for: productId)` → `expirationDate`, `renewalDate`,
`willAutoRenew`, `autoRenewProductId`, `isInFreeTrial`, `isInIntroOffer`, `isInGracePeriod`, `isInBillingRetry`.
`store.entitlement(named: "pro")` → `productId`, `expirationDate` (nil = lifetime, `isLifetime`), `willRenew`,
`periodType` (`.normal` / `.intro` / `.trial`).

Every purchase is sent with `appAccountToken = Revflare.installId` (pass `appAccountToken:` to use your own user id),
and the attribution link runs after purchases, restores and updates (`Revflare.syncPurchases()`), so revenue joins the
install's Apple Ads campaign at once.

Testing: add a StoreKit configuration file (Xcode → File → New → StoreKit Configuration File, synced with App Store
Connect or with the same product ids) and select it in the scheme (Run → Options → StoreKit Configuration). Avoid
reporting StoreKit test transactions to the production Revflare server: call `Revflare.configure` only in release
builds or point debug builds at another server.

### Migrating from RevenueCat

| RevenueCat | RevflareKit |
| --- | --- |
| `Purchases.configure(withAPIKey:)` | `Revflare.configurePurchases(entitlements:)` (products from the offerings) or `Revflare.configurePurchases(productIds:entitlements:)` (+ `Revflare.configure(sdkKey:server:)`, first) |
| `Purchases.shared.offerings()` | `try await Revflare.offerings()` / `store.offerings` (see [Offerings and paywalls](#offerings-and-paywalls)) |
| `offerings.current` / `offerings["id"]` / `offerings.all` | `offerings.current` / `offerings["id"]` / `offerings.all` |
| `offerings.currentOffering(forPlacement:)` / `getCurrentOffering(forPlacement:)` | `offerings.offering(forPlacement:)` / `store.offering(forPlacement:)` |
| `offering.availablePackages` / `offering.annual` / `offering.package(identifier:)` | `offering.packages` / `offering.annual` / `offering.package(identifier:)` |
| `offering.metadata` / `getMetadataValue(for:default:)` | `offering.metadata` (`RevflareJSON`) / `offering.metadata("key", as: T.self)` / `decodeMetadata(T.self)` |
| `package.storeProduct` / `package.packageType` | `package.product` (StoreKit 2 `Product`) / `package.identifier` (`$annual`...) |
| `package.storeProduct.localizedPriceString` | `package.product.displayPrice` |
| `storeProduct.introductoryDiscount` (+ eligibility check) | `store.eligibleIntroOffer(for: product)` (nil when not eligible) |
| Entitlements (dashboard: entitlement → products) | `entitlements: ["pro": [product ids]]` |
| `Purchases.shared.purchase(package:)` | `try await store.purchase(package)` (or `store.purchase(product)`) → `.purchased` / `.userCancelled` / `.pending` |
| `customerInfo.entitlements.active["pro"]` | `store.activeEntitlements["pro"]` / `store.entitlement(named: "pro")` / `store.isActive("pro")` |
| `entitlement.expirationDate == nil` (lifetime) | `store.entitlement(named: "pro")?.isLifetime` |
| `Purchases.shared.customerInfo()` / `PurchasesDelegate` | `@Published store.customer` (`$customer` publisher), `await store.refresh()` |
| `Purchases.shared.restorePurchases()` | `try await store.restore()` |
| RevenueCatUI `PaywallView` | Your own SwiftUI view (example above) |

Steps:

1. Read the RevenueCat project: offerings → packages → App Store product ids, entitlements → attached products
   (`revenuecat offerings list`, `revenuecat products list`, `revenuecat entitlements list`). Recreate the offerings,
   their metadata and placements in Revflare (web → the app → Offerings, or `revflare offerings <app> apply file.json`).
2. Replace `Purchases.configure` with `Revflare.configurePurchases(entitlements:)` (or
   `configurePurchases(productIds:entitlements:)`) and every RevenueCat call with the table above. Remove the RevenueCat package, its API key and `import RevenueCat` / `RevenueCatUI`.
3. Existing customers keep access: their purchases are App Store transactions, which StoreKit 2 returns in
   `Transaction.currentEntitlements` on every device signed in to the same Apple Account (no restore needed).
4. Point the App Store Server Notifications URL at Revflare (Revflare → Apps → connect notifications) once RevenueCat
   no longer needs it, and review the App Privacy answers (RevenueCat's data collection goes away).
5. Test with a StoreKit configuration file: prices show, purchase unlocks, cancel does nothing, restore works.

## Offerings and paywalls

Offerings (as in RevenueCat) decide **which products a paywall shows**, in which order, with free-form metadata, from
Revflare instead of the app binary:

- **Offering**: an identifier (`default`, `discount`...), a display name, **packages** in display order and JSON
  **metadata** for the paywall (titles, colors, layout keys...).
- **Package**: an identifier (`$weekly`, `$monthly`, `$two_month`, `$three_month`, `$six_month`, `$annual`,
  `$lifetime` or any custom string), an App Store product id and its own metadata (badge, highlight...).
- **Current offering**: the default one.
- **Placements**: the paywall locations of the app (`onboarding`, `settings`, `discount`...), each mapped to an
  offering, or to none (= the current offering).

Set them in Revflare web → **Apps** → the app → **Offerings**, or with the CLI: `revflare offerings <app> list`,
`show <id>`, `apply <file.json>`, `current <id>`, `placements`. Identifiers match `[A-Za-z0-9_.$-]{1,64}`.

### Fetching

```swift
let offerings = try await Revflare.offerings()          // needs Revflare.configure first; no RevflareStore needed
let paywall = offerings.offering(forPlacement: "onboarding")
for package in paywall?.packages ?? [] {
    print(package.identifier, package.product.displayName, package.product.displayPrice)
}
```

- `offerings.current`, `offerings["discount"]`, `offerings.all` (by id), `offerings.ordered` (server order),
  `offerings.version`.
- `offering(forPlacement:)`: the placement's offering; an unknown placement, a placement without an offering, or one
  pointing at a deleted offering gives `current` (nil when there is no current offering).
- `offering.packages` keeps the server's order. All the products of all offerings load in one
  `Product.products(for:)` call and stay in memory. **Packages whose product StoreKit can't load are left out**
  (logged once as an error: check the product id in Revflare / App Store Connect / the StoreKit configuration file).
- `offering.package(identifier:)`, `offering.package(productId:)`, `offering.weekly` / `monthly` / `twoMonth` /
  `threeMonth` / `sixMonth` / `annual` / `lifetime`.
- `package.product` is the StoreKit 2 `Product`; `package.offeringIdentifier` the offering it came from.

### Caching and offline

`GET /sdk/v1/offerings` (header `X-Revflare-Key`, query `appVersion`). The last good answer and its ETag are kept on
the device (UserDefaults, one entry per server + SDK key):

| `fetchPolicy` | Behaviour |
| --- | --- |
| `.cachedOrFetched` (default) | Cached copy at once if under 5 minutes old (and from the same app version); otherwise asks the server. |
| `.fetchCurrent` | Always asks the server. |

Requests send `If-None-Match`, so an unchanged configuration costs a 304. If the server can't be reached (or errors),
both policies **fall back to the cached copy, however old**; with no cached copy they throw `RevflareOfferingsError`
(`.notConfigured`, `.network`, `.unknownSDKKey`, `.server`, `.invalidResponse`, `.productsUnavailable`). Concurrent
calls share one request. A paywall shown offline after a first launch online therefore still works; on the very
first launch offline, show a retry button.

### With RevflareStore

`Revflare.configurePurchases(entitlements:)` makes a store whose products come from the offerings: it loads them at
start and on foreground (`store.offerings`, `isLoadingOfferings`, `offeringsError`) and adds their products to
`store.products`. List in `entitlements` every product that unlocks something (also ones on no paywall: they load
too). A store made with `configurePurchases(productIds:entitlements:)` loads them only when you call
`await store.loadOfferings()` (it only reads the server entitlements and durations on its own, 1.9+).

```swift
@main
struct MyApp: App {
    @StateObject private var store = Revflare.configurePurchases(
        entitlements: ["pro": ["com.example.app.weekly", "com.example.app.annual", "com.example.app.lifetime"]]
    )

    init() {
        Revflare.configure(sdkKey: "rfp_…", server: URL(string: "https://revflare.example.com")!)
    }

    var body: some Scene {
        WindowGroup { ContentView().environmentObject(store) }
    }
}

struct OnboardingPaywall: View {
    @EnvironmentObject private var store: RevflareStore
    @Environment(\.dismiss) private var dismiss
    @State private var selected: RevflarePackage?
    @State private var error: String?

    private var offering: RevflareOffering? { store.offering(forPlacement: "onboarding") }

    var body: some View {
        VStack(spacing: 16) {
            // Metadata set in Revflare: { "title": "Go Pro", "subtitle": "...", "accent": "#FF6A00" }
            Text(offering?.metadata["title"]?.stringValue ?? "Go Pro").font(.largeTitle.bold())
            if let subtitle = offering?.metadata("subtitle", as: String.self) { Text(subtitle) }

            if let offering {
                ForEach(offering.packages) { package in
                    Button { selected = package } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(package.product.displayName).bold()
                                if let intro = store.eligibleIntroOffer(for: package.product), intro.paymentMode == .freeTrial {
                                    Text("Free trial, then \(package.product.displayPrice)")
                                }
                            }
                            Spacer()
                            if let badge = package.metadata["badge"]?.stringValue { Text(badge).font(.caption.bold()) }
                            Text(package.product.displayPrice)
                        }
                        .padding()
                        .background(selected?.id == package.id ? Color.accentColor.opacity(0.2) : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            } else if store.isLoadingOfferings {
                ProgressView()
            } else {
                Button("Try again") { Task { await store.loadOfferings(fetchPolicy: .fetchCurrent) } }
            }

            Button(store.isPurchasing ? "…" : "Continue") {
                guard let selected else { return }
                Task {
                    do { if try await store.purchase(selected).isPurchased { dismiss() } }
                    catch { self.error = error.localizedDescription }
                }
            }
            .disabled(selected == nil || store.isPurchasing)
            Button("Restore Purchases") { Task { try? await store.restore() } }
        }
        .padding()
        .onAppear { selected = selected ?? offering?.annual ?? offering?.packages.first }
        .onChange(of: offering?.id) { _ in selected = offering?.annual ?? offering?.packages.first }
        .alert("Purchase failed", isPresented: .constant(error != nil)) { Button("OK") { error = nil } } message: { Text(error ?? "") }
    }
}
```

**Several paywalls**: one view per placement, or one view taking the placement as a parameter:
`store.offering(forPlacement: "settings")`, `store.offering(forPlacement: "discount")`. Pointing a placement at
another offering in Revflare changes that paywall at the next fetch (foreground, or after 5 minutes), with no app
update; placements you never configured show the current offering.

**Typed metadata**: decode the whole object into your own type.

```swift
struct PaywallConfig: Decodable { var title: String; var features: [String]; var accent: String? }
let config = try offering.decodeMetadata(PaywallConfig.self)
```

`RevflareJSON` is `.string` / `.number` / `.bool` / `.array` / `.object` / `.null`, with `stringValue`,
`numberValue`, `intValue`, `boolValue`, `arrayValue`, `objectValue`, `isNull`, `json["key"]`, `json[0]` and
`decode(T.self)`.

Without RevflareStore (StoreKit 2 or another purchase layer): `let offerings = try await Revflare.offerings()`, then
buy `package.product` with `try await package.product.purchase(options: Revflare.purchaseOptions)`.

## Promotional and win-back offers

Bring back lapsed subscribers (or retain current ones) with a discounted price. Two kinds, both set up in App Store
Connect → the app → Subscriptions → the subscription → Subscription Prices / Offers:

| | Promotional offer | Win-back offer |
| --- | --- | --- |
| iOS | 15+ | 18+ |
| Who | Customers who have or had a subscription in the group (current or lapsed) | Lapsed subscribers Apple deems eligible (rules set in App Store Connect) |
| Signature | Yes: made with the In-App Purchase key, by your Revflare server | No |
| RevflareKit | `store.promotionalOffers(for:)`, `store.purchase(_:promotionalOffer:)` | `store.winBackOffers(for:)`, `store.purchase(_:winBackOffer:)` |

Win-back offers can also be redeemed from the App Store (Streamlined Purchasing): those purchases arrive through
`Transaction.updates`, which `RevflareStore` already handles.

### Setup

1. **App Store Connect**: create the promotional offer (its *Reference Name* and *Promotional Offer Identifier*,
   e.g. `comeback50`) or the win-back offer (eligibility: paid duration, time since lapse...).
2. **In-App Purchase key** (promotional offers only): Users and Access → Integrations → In-App Purchase → generate a
   key, then upload the `.p8` with its key id in Revflare (web → the app → Offers). Without it the server answers 409
   (`RevflareOfferError.notConfigured`).
3. **Allowlist** (promotional offers only): Revflare web → the app → **Offers**: add the product id + offer id pairs
   the app may ask for. Any other pair gets 403 (`RevflareOfferError.notAllowed`), so a tampered app can't redeem an
   offer you did not mean to give.

### Choosing who to show it to

Target **lapsed** subscribers: `store.isLapsed(entitlement: "pro")` / `store.lapsedSubscription(groupID:)` are true /
non-nil when the subscription expired, the customer has no access and is **not** in a billing grace period or billing
retry. Customers in grace / retry are still subscribers whose payment failed: nudge them to update their payment
method (`store.subscription(for:)?.isInBillingRetry`, link to `https://apps.apple.com/account/subscriptions`) instead
of offering a discount. Groups are known once the store loaded their products.

`store.promotionalOffers(for: product)` returns the product's promotional offers only when the customer has or had a
subscription in its group (`Transaction.all` and the group's statuses; local, no network), else `[]`. The groups found
in `Transaction.all` are read once and kept until a new transaction or a restore, so calling it on every paywall is cheap.
`store.winBackOffers(for: product)` (iOS 18+) returns the offers whose ids are in StoreKit's
`renewalInfo.eligibleWinBackOfferIDs`, best first.

### SwiftUI example

Pick the offer with [remote config](#remote-config) (`winback_offer` = `"comeback50"` or `""`), so it changes
without an app update:

```swift
import StoreKit
import SwiftUI
import RevflareKit

struct ComeBackOffer: View {
    @EnvironmentObject var store: RevflareStore
    @ObservedObject var config = Revflare.remoteConfig
    let product: Product                       // e.g. store.product(id: "com.example.app.annual")

    @State private var promotional: Product.SubscriptionOffer?
    @State private var winBack: Product.SubscriptionOffer?   // iOS 18+
    @State private var error: String?

    var body: some View {
        Group {
            if let offer = winBack ?? promotional {
                VStack(spacing: 12) {
                    Text("Welcome back").font(.title.bold())
                    Text("\(offer.displayPrice) for the first \(offer.periodCount) period(s)")
                    Button("Resubscribe") { Task { await buy() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(store.isPurchasing)
                    if let error { Text(error).font(.footnote).foregroundStyle(.secondary) }
                }
                .onAppear { Revflare.trackPaywallView(placement: "winback") }
            }
        }
        .task(id: store.customer) { await load() }
    }

    private func load() async {
        guard store.isLapsed(entitlement: "pro") else { promotional = nil; winBack = nil; return }
        if #available(iOS 18.0, *) { winBack = await store.winBackOffers(for: product).first }
        let offerId = config.string("winback_offer")
        let offers = offerId.isEmpty ? [] : await store.promotionalOffers(for: product)
        promotional = offers.first { $0.id == offerId }
    }

    private func buy() async {
        do {
            if #available(iOS 18.0, *), let winBack {
                try await store.purchase(product, winBackOffer: winBack, placement: "winback")
            } else if let id = promotional?.id {
                try await store.purchase(product, promotionalOffer: id, placement: "winback")
            }
        } catch RevflareOfferError.rateLimited(let retryAfter) {
            error = "Try again in \(Int(retryAfter ?? 60)) s."
        } catch {
            self.error = error.localizedDescription
        }
    }
}
```

`purchase(_:promotionalOffer:)` (also for a `RevflarePackage`) asks the server for a signature in the background
(at most 10 s), builds the purchase option and buys: the JWS form `promotionalOffer(_:compactJWS:)` when the app is
built with the iOS 26 SDK (Swift 6.2+; back-deployed to iOS 15), else the legacy
`promotionalOffer(offerID:keyID:nonce:signature:timestamp:)`. The legacy signature covers the `appAccountToken`, so
the purchase sends exactly the token that was signed (`Revflare.installId` unless you pass one). Purchase events carry
`offer` and `offer_type` (`promotional` / `win_back`); a signing failure is a `purchase_failed` with `error` =
`offer_not_allowed`, `offer_not_configured`, `offer_rate_limited`, `offer_network_error`...

Without RevflareStore: `let signature = try await Revflare.promotionalOfferSignature(productId:offerId:)`, then
`try await product.purchase(options: signature.purchaseOptions())`.

Errors (`RevflareOfferError`): `.notAllowed` (403, not in the allowlist), `.notConfigured` (409, no In-App Purchase
key), `.unknownSDKKey` (404), `.rateLimited(retryAfter:)` (429), `.network`, `.server(status:)`,
`.invalidResponse`, `.sdkNotConfigured` (before `Revflare.configure`). StoreKit's own refusals
(`Product.PurchaseError.ineligibleForOffer`, `.invalidOfferSignature`...) are thrown as they are.

**Privacy**: signing sends the install id, the product and offer ids and the `appAccountToken` to your Revflare
server; nothing new for the App Store privacy answers. Win-back offers send nothing.

## Events and funnels

Revflare shows **funnels** ("where do users drop off between onboarding, paywall and purchase?") from events
RevflareKit collects. They go to your Revflare server (`POST /sdk/v1/events`), which writes them to Cloudflare
Workers Analytics Engine (not to its database). Define the funnels in Revflare web → the app → **Funnels** (or
`revflare funnels`): a funnel is a list of event names (optionally with a property, e.g. `step = 3`), counted per
install.

Install-scoped analytics only: events carry the random install id, never the IDFA, the IDFV or personal data, and
are not used for tracking. Nothing is collected before `Revflare.configure` (custom events tracked earlier wait in
memory), and nothing at all once the app sets `Revflare.analyticsEnabled = false`.

### Automatic events

| Event | When | Properties |
| --- | --- | --- |
| `first_open` | First launch of the install (not for apps updating from RevflareKit 1.3 or older). | |
| `app_open` | Every launch (`Revflare.configure`). | |
| `session_start` | Every launch, and when the app comes back after **30 minutes or more** in the background (new session id). | |
| `app_background` | The app goes to the background. | |
| `purchase_start` | `RevflareStore.purchase(...)` starts. | `product`, `offering`, `package`, `placement` (when known) |
| `purchase_success` | Verified and finished. | same |
| `purchase_cancel` | The user closed the sheet. | same |
| `purchase_pending` | Ask to Buy / SCA. | same |
| `purchase_failed` | StoreKit error or unverified transaction. | same + `error` (`network_error`, `purchase_not_allowed`, `failed_verification`, `NSURLErrorDomain:-1009`...) |
| `restore_start` / `restore_success` / `restore_failed` | `RevflareStore.restore()`. | `entitlements` (active after the restore) / `error` |

Purchase events only come from `RevflareStore`; apps buying through RevenueCat or their own StoreKit code can track
them with `Revflare.track` (Revflare's revenue numbers come from Apple either way). Every event also carries a session
id (a UUID, rotated as above), a client event id and the device time.

### Custom events

```swift
import RevflareKit

// Onboarding: one event with a step property (one funnel step per value)...
Revflare.track("onboarding_step", properties: ["step": 1, "name": "welcome"])
Revflare.track("onboarding_step", properties: ["step": 2, "name": "notifications"])
// ...or one name per step.
Revflare.track("onboarding_3_done")

// Key features.
Revflare.track("export_pdf", properties: ["pages": 12, "format": "a4"])
Revflare.track("signup", properties: ["method": "apple"])
```

`track` is thread-safe and returns at once; it never blocks the main thread. Rules (applied on the device; invalid
events are dropped and logged with `Revflare.debugLogging`):

- name: 1-64 characters of `A-Z a-z 0-9 _ . : -`; keep names stable, funnels match them;
- at most 10 properties; keys 1-40 characters of `A-Z a-z 0-9 _ . -`; values are strings (cut to 100 characters).
  Numbers and booleans are sent as strings (`2`, `2.5`, `true`), `UUID`, `URL`, `Date` (ISO 8601) and `String` enums
  too; other values (arrays, dictionaries...) are dropped. **Never put personal data (names, emails, free text) in
  properties.**

### Paywalls

RevflareKit can't know when a paywall appears; tell it, with the placement and the offering shown:

```swift
struct OnboardingPaywall: View {
    @EnvironmentObject private var store: RevflareStore
    private var offering: RevflareOffering? { store.offering(forPlacement: "onboarding") }

    var body: some View {
        PaywallContent(offering: offering) { package in
            // The purchase events carry the offering, the package and the placement.
            try await store.purchase(package, placement: "onboarding")
        }
        .onAppear { Revflare.trackPaywallView(placement: "onboarding", offering: offering) }
        .onDisappear { if !store.isActive("pro") { Revflare.trackPaywallClose(placement: "onboarding", offering: offering) } }
    }
}
```

A typical funnel: `first_open` → `onboarding_step` (step 1…n) → `paywall_view` (placement `onboarding`) →
`purchase_start` → `purchase_success`.

### Opting out

```swift
Revflare.analyticsEnabled = false   // e.g. from the app's "Share analytics" switch
```

Kept in UserDefaults (default `true`). Turning it off deletes the queued events and stops recording and sending
until it is set back to `true`. Attribution, purchase links and offerings are not affected.

### Delivery

- Events are queued in a file (`Application Support/app.revflare.kit/events.jsonl`, excluded from backups; at most
  1,000 events, the oldest dropped first) and survive the app being killed.
- Sent at launch, every 30 seconds while events are pending, as soon as 50 are queued, and when the app goes to the
  background (with a short background-time request, `ProcessInfo.performExpiringActivity`); at most 200 per request.
- Deleted only after a 200. Any other 4xx except 429 drops the batch (logged once: usually a wrong SDK key); 429,
  5xx and network errors back off (5 s doubling up to 10 minutes, or the server's `Retry-After`).

```json
{
  "installId": "0f8fad5b-d9cb-469f-a165-70867728950e",
  "appVersion": "1.0",
  "appBuild": "1",
  "osVersion": "18.1",
  "locale": "en_US",
  "events": [
    { "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "name": "paywall_view", "ts": 1792400000123,
      "sessionId": "16fd2706-8baf-433b-82eb-8c7fada847da", "props": { "placement": "onboarding", "offering": "default" } }
  ]
}
```

### App Store privacy

Declare **Usage Data → Product Interaction**, used for **Analytics**, **not linked to tracking** (linked to the
user only if you consider the random install id as such; it is not tied to an account or identity by RevflareKit).
Events are not used for tracking or advertising and go to your own server only. Apps that turn the events off
entirely (`analyticsEnabled = false` before `configure`, and never on) have nothing new to declare.

## Remote config

Remote config (like Firebase Remote Config) changes the app's behaviour without an update: **parameters** set in
Revflare, each with a type (`string`, `number`, `boolean`, `json`), a default value and **conditional values**. The
server picks the value for each device from the parameter's conditions, **in order (the first match wins)**:

| Condition | Matches on |
| --- | --- |
| Country | The App Store **storefront** country (sent by RevflareKit), else the country of the request's IP address. |
| App version | `CFBundleShortVersionString` (and the build). |
| Language | The device locale (`zh_CN`: language `zh`). |
| Percentage rollout | A stable bucket of the random install id: the same install stays in the same group (A/B tests). |
| Acquisition source (1.8) | `apple_ads` / `organic` / `unknown`, optionally the Apple Ads campaign, ad group or keyword id. See [Targeting by acquisition source](#targeting-by-acquisition-source). |

Set them in Revflare web → **Apps** → the app → **Remote config**, or with the CLI (`revflare config <app> ...`).
Parameters without a server value use the app's defaults.

### Use

```swift
import RevflareKit

@main
struct MyApp: App {
    init() {
        Revflare.remoteConfig.setDefaults([            // used until (and unless) the server sends a value
            "onboarding_version": "v1",
            "max_free_accounts": 1,
            "show_discounted_paywall": false,
            "paywall": ["title": "Go Pro", "features": ["No ads"]],
        ])
        Revflare.configure(sdkKey: "rfp_…", server: URL(string: "https://revflare.example.com")!)
        // configure fetches and activates the values in the background.
    }

    var body: some Scene { WindowGroup { RootView() } }
}

struct RootView: View {
    @ObservedObject private var config = Revflare.remoteConfig   // re-renders when values change

    var body: some View {
        if config.string("onboarding_version") == "v2" { OnboardingV2() } else { OnboardingV1() }
    }
}
```

Getters never fail and never return nil (except `json` / `decode` / subscript): the **remote** value, else the
**default** from `setDefaults`, else the getter's `default:` argument. Values convert when the types differ (number
`1` → `string` gives `"1"`; `"true"` → `bool` gives `true`; `"42"` → `int` gives 42); a value that can't convert falls
back to the next source.

```swift
let config = Revflare.remoteConfig
config.string("onboarding_version")                    // String, default ""
config.bool("show_discounted_paywall")                 // Bool, default false
config.int("max_free_accounts", default: 1)            // Int (numbers truncated)
config.double("discount_ratio")                        // Double
config["paywall"]?["title"]?.stringValue               // RevflareJSON? (same type as offering metadata)
config.decode("paywall", as: PaywallConfig.self)       // a Decodable of your own (also from a string holding JSON)
config.source(for: "paywall")                          // .remote / .default / .static
config.conditions                                      // ["china"]: the conditions that matched
config.country                                         // "CN": the country the server used
```

Defaults can also come from a property list: `Revflare.remoteConfig.setDefaults(plistNamed: "RemoteConfigDefaults")`.

### Loading, caching and offline

- The last activated values are kept on the device (UserDefaults, one entry per server + SDK key) and **applied at
  once at the next launch**, before any request and before `configure`: the app has them offline.
- `Revflare.configure` fetches and activates in the background (one request per launch; an unchanged configuration
  is a cheap `304`). When the app comes back to the foreground, it refetches if the values are older than
  `minimumFetchInterval` (default 1 hour) or the app version, locale or storefront changed. Turn both off with
  `Revflare.remoteConfig.autoFetch = false` **before** `configure`.
- `isLoaded` is `true` once cached values were applied at launch, or once the first fetch attempt finished (success
  or not). `lastFetchStatus` (`.never`, `.success`, `.failure`, `.throttled`) and `lastFetchDate` tell what happened.
- Failures (offline, server error, timeout) never throw: the cached values or the defaults stay in use.

A first screen that depends on the config (e.g. which onboarding to show) can wait behind a short splash:

```swift
struct LaunchView: View {
    @ObservedObject private var config = Revflare.remoteConfig
    @State private var ready = false

    var body: some View {
        Group {
            if ready || config.isLoaded { RootView() } else { SplashView() }
        }
        .task {
            // Joins the request configure started; gives up after 3 s (values that arrive later are still activated).
            await config.fetchAndActivate(timeout: 3)
            ready = true
        }
    }
}
```

To never change values while the app is in use, apply them on the next launch instead:

```swift
Revflare.remoteConfig.autoFetch = false   // before configure
Revflare.configure(sdkKey: "rfp_…", server: serverURL)
Revflare.remoteConfig.activate()          // the values fetched during the previous run
Task { await Revflare.remoteConfig.fetch() }   // fetched now, applied at the next launch
```

`fetchAndActivate(timeout:)` returns `true` when the server answered in time and its values are active; concurrent
calls share one request. In debug builds `Revflare.remoteConfig.minimumFetchInterval = 0` refetches on every
foreground.

### Targeting by acquisition source

Config requests carry the install's acquisition source as Revflare resolved it from the Apple Ads token
(`Revflare.attribution`): `source=apple_ads&campaign=…&adGroup=…&keyword=…`, `source=organic`, or `source=unknown`
while Apple has not answered. A condition on it lets, for example, Apple Ads installs see a hard paywall while organic
ones keep the soft one:

1. Revflare web → the app → **Remote config** → parameter `paywall_mode` (string, default `soft`).
2. Conditional value `hard` for the condition **Source is in [apple_ads]** (optionally also **Campaign is 123** to
   limit it to one campaign).

```swift
Revflare.remoteConfig.setDefaults(["paywall_mode": "soft"])   // the soft default also covers `unknown`

struct PaywallGate: View {
    @ObservedObject private var config = Revflare.remoteConfig
    @State private var ready = false

    var body: some View {
        Group {
            if !ready { ProgressView() }
            else if config.string("paywall_mode") == "hard" { HardPaywall() }
            else { SoftPaywall() }
        }
        .task {
            // Applies values fetched since launch (e.g. after the attribution resolved). At most 3 s.
            await config.fetchAndActivate(timeout: 3)
            ready = true
        }
    }
}
```

What to expect:

- **First launch.** Apple usually answers within seconds, sometimes minutes. On a new install the first config fetch
  waits for the first attribution report (at most 3 s), so it often goes out with the source known already. If not,
  it goes out with `source=unknown`: pick a soft default for `unknown` (don't punish users you know nothing about),
  as the in-app default above does.
- **Later resolution.** When the source becomes known, RevflareKit refetches **into the fetched-not-active slot**:
  values on screen never change by themselves. They apply on the next `fetchAndActivate()` / `activate()`, on the next
  foreground (with `autoFetch`) or at the next launch. Call `fetchAndActivate` right before showing the paywall.
- Existing installs (state from before 1.8) ask the server once for their source and never wait at launch. An install
  whose source is still unknown 24 hours after its first launch stays `unknown`.
- Read it in code with `Revflare.attribution` (`RevflareAttribution`: `source` `.appleAds` / `.organic` /
  `.unknown`, `campaignId`, `adGroupId`, `keywordId`), observe `Revflare.remoteConfig.attribution` (`@Published`) or
  `Revflare.attributionDidChangeNotification`.

### Experiments

An experiment (1.7+) A/B tests remote config parameters: set it up in Revflare web → **Apps** → the app →
**Experiments** (the parameters it changes, the variants with their values, the traffic split, the audience). The
server assigns each install a variant and resolves the variant's values into the config: the app reads the
parameters as usual, nothing else to write.

```swift
// On the paywall, when it appears (not at launch):
let variant = Revflare.remoteConfig.string("paywall_variant", default: "a")   // records the exposure
```

**Exposure.** The first time the app reads (any getter, the subscript or `decode`) a parameter of an experiment the
device is enrolled in, RevflareKit tracks `experiment_exposure` with `experiment` (`exp_paywall1`) and `variant`
(`exp_paywall1:b`), whatever the value's source: the control often keeps the app's `setDefaults` / `default:` value
(the server sends none), and it must be counted like the variants or the split looks skewed. Once per install,
experiment and variant (remembered across launches); a new variant (re-assignment) is recorded again. A device that is
not enrolled (or has never fetched the config) records nothing. Events must be on (`Revflare.analyticsEnabled`);
while they are off nothing is recorded or remembered.

Read the parameter where the user actually **sees** the variant (when the paywall appears, when the onboarding step
shows), not at launch to precompute something: only users who saw a variant should count, or the results are
diluted. Apps that branch on the assignment without reading a parameter record the exposure themselves:

```swift
let config = Revflare.remoteConfig
if config.variant(forExperiment: "exp_onboarding") == "short" {
    config.trackExposure(experiment: "exp_onboarding")   // when the short onboarding shows
    ...
}
config.experiments                                       // [RevflareExperiment] (id, variant, keys), @Published
config.experiment("exp_paywall1")?.keys
```

Results (conversion, trial starts, revenue and retention per variant, joined by install id) are in Revflare web →
the app → Experiments. Purchases need no extra properties.

### Experiments and funnels

To compare variants in Revflare funnels too, send the variant as the `variant` property (funnels can split by it):

```swift
Revflare.trackPaywallView(placement: "onboarding", offering: offering)
Revflare.track("onboarding_complete", properties: ["variant": Revflare.remoteConfig.string("paywall_variant")])
```

### Migrating from Firebase Remote Config

1. Move the console's parameters: `firebase remoteconfig:get --project <project-id> -o rc.json`, then
   `revflare config <app> import-firebase rc.json` (parameters and their conditional values; review the
   conditions in Revflare web afterwards).
2. Replace the calls:

| Firebase | RevflareKit |
| --- | --- |
| `FirebaseApp.configure()` + `RemoteConfig.remoteConfig()` | `Revflare.configure(sdkKey:server:)` + `Revflare.remoteConfig` |
| `remoteConfig.setDefaults(["key": value as NSObject])` / `setDefaults(fromPlist:)` | `Revflare.remoteConfig.setDefaults(["key": value])` / `setDefaults(plistNamed:)` |
| `RemoteConfigSettings().minimumFetchInterval` | `Revflare.remoteConfig.minimumFetchInterval` (foreground refetches; launches always fetch) |
| `remoteConfig.fetchAndActivate { status, error in }` | `await Revflare.remoteConfig.fetchAndActivate()` (often not needed: `configure` does it) |
| `remoteConfig.fetch()` / `activate()` | `await Revflare.remoteConfig.fetch()` / `Revflare.remoteConfig.activate()` |
| `remoteConfig.configValue(forKey: "k").stringValue` / `remoteConfig["k"].stringValue` | `Revflare.remoteConfig.string("k")` |
| `.boolValue` / `.numberValue.intValue` / `.numberValue.doubleValue` | `bool("k")` / `int("k")` / `double("k")` |
| `.jsonValue` / `decoded(asType:)` | `json("k")` / `decode("k", as: T.self)` |
| `configValue(forKey:).source` (`.remote` / `.default` / `.static`) | `source(for: "k")` (same cases) |
| `lastFetchStatus` / `lastFetchTime` | `lastFetchStatus` / `lastFetchDate` (`@Published`) |
| `addOnConfigUpdateListener` (real-time) | `@ObservedObject Revflare.remoteConfig` / `objectWillChange` (values change on fetch, launch and foreground) |

3. Remove `FirebaseRemoteConfig` from the app (and Firebase altogether if nothing else uses it: `FirebaseApp.configure()`,
   `GoogleService-Info.plist`).

### Request

`GET /sdk/v1/config?installId=…&appVersion=2.1&appBuild=12&osVersion=18.1&locale=zh_CN&storefront=CN&source=apple_ads&campaign=123&adGroup=456&keyword=789&environment=production&sdk=1.9.1`
(header `X-Revflare-Key`, `If-None-Match` with the last ETag). `storefront` is StoreKit's
`Storefront.current?.countryCode` converted to ISO alpha-2 (left out when unknown); `source` is `apple_ads`,
`organic` or `unknown`, the ids only when known. A change of any of these (other than the install id) refetches
without the ETag. Answer:

```json
{ "version": "a1b2c3d4",
  "values": { "onboarding_version": "v1", "max_free_accounts": 1, "show_discounted_paywall": true,
              "paywall": { "title": "Go Pro" } },
  "conditions": ["china"], "country": "CN",
  "experiments": [ { "id": "exp_paywall1", "variant": "b", "keys": ["paywall_variant", "trial_days"] } ] }
```

`experiments` lists only running experiments the install is enrolled in (missing on older servers: none).
`304` when unchanged, `404` for an unknown SDK key (logged as an error), `429` gives `.throttled`.

## Test and debug data

Every RevflareKit request says where the build runs: `"environment"` in each JSON body (`/report`, `/identifiers`,
`/events`, `/offers/sign`) and `environment=` on `/sdk/v1/config`. Revflare excludes `sandbox` and `xcode` data from
its analytics by default (installs, events, funnels, attribution, experiments); the web panel's **Include test data**
toggle shows it. Keep RevflareKit on in debug builds and stop wrapping `track` / `configure` in `#if DEBUG`.

Detection runs on the device, without network and without `AppTransaction.shared` (which can show an App Store
sign-in prompt), in this order:

| Signal | Environment |
| --- | --- |
| Simulator (`targetEnvironment(simulator)` / `SIMULATOR_MODEL_IDENTIFIER`) | `xcode` |
| A debugger is attached (run from Xcode on a device) | `xcode` |
| A verified StoreKit transaction read in this run with `environment` `.xcode` / `.sandbox` (iOS 16+) | that |
| `Bundle.main.appStoreReceiptURL` ends in `sandboxReceipt` (TestFlight, sandbox Apple Accounts; the API is deprecated but still set) | `sandbox` |
| Otherwise | `production` |

**TestFlight counts as `sandbox`.** `Revflare.environment` gives the resolved value. Force it when detection can't
know (e.g. an internal build outside TestFlight):

```swift
Revflare.configure(sdkKey: "rfp_…", server: serverURL, environment: .sandbox)   // .automatic (default), .production, .sandbox, .xcode
```

Testers on App Store builds (a production build on a teammate's phone) are excluded by install id: copy it from the
app (e.g. a debug screen showing `Revflare.installId`) into Revflare web → the app → **Excluded install ids**.

## API

| | |
| --- | --- |
| `Revflare.configure(sdkKey:server:)` | Start. Once, at launch. `server` is your Revflare instance (the web app's address). Later calls are ignored. |
| `Revflare.configure(sdkKey:server:environment:)` | Same, forcing the reported `RevflareEnvironment` (`.automatic` default, `.production`, `.sandbox`, `.xcode`). |
| `Revflare.environment` | The resolved environment (`.production` / `.sandbox` / `.xcode`), sent with every request. |
| `Revflare.attribution` | `RevflareAttribution` (`source`: `.appleAds` / `.organic` / `.unknown`, `campaignId`, `adGroupId`, `keywordId`). Read only, kept on the device. |
| `Revflare.attributionDidChangeNotification` | Posted when `Revflare.attribution` changes. |
| `Revflare.installId` | This install's UUID (available before `configure`). |
| `Revflare.purchaseOptions` | `[.appAccountToken(Revflare.installId)]` for `Product.purchase(options:)`. |
| `Revflare.syncPurchases()` | Optional: report new purchases now. |
| `Revflare.setMetaAnonymousID(_:)` | Opt-in, Meta Conversions API matching: pass `AppEvents.shared.anonymousID`. Kept in UserDefaults; reported to `POST /sdk/v1/identifiers` with the IDFV, ATT status, IDFA (when authorized) and device info whenever they change. Only after the user's consent. |
| `Revflare.collectDeviceIdentifiers()` | Opt-in without a Facebook anonymous id (IDFV, IDFA when authorized, device info), and re-check now: call it again right after the ATT prompt. Only after the user's consent. |
| `Revflare.configurePurchases(productIds:entitlements:nonRenewingDurations:)` | Creates the app's `RevflareStore` (kept in `Revflare.store`). Owns the app's transactions. `nonRenewingDurations` (1.9, optional): durations of non-renewing subscriptions, e.g. `["…pass_3day": .days(3)]` (needed for declared passes). |
| `Revflare.configurePurchases(entitlements:nonRenewingDurations:)` | Same, with the products coming from the offerings (loaded at start and on foreground). |
| `RevflareStore.mapping` / `localMapping` / `nonRenewingDurations` / `localNonRenewingDurations` / `declaredProductIds` | 1.9: the effective entitlement map (app ∪ Revflare) and pass durations (the app's, plus Revflare's for products the app does not declare), the app's own parts, and the products it declares. |
| `RevflareOfferings.entitlements` / `nonRenewingDurations` | 1.9: what Revflare sets (empty from older servers). |
| `NonRenewingDuration` | `.days(n)` / `.weeks(n)` / `.months(n)` / `.years(n)`, `end(from:)`. |
| `Revflare.offerings(fetchPolicy:)` | `RevflareOfferings` set in Revflare: `.cachedOrFetched` (default, 5-minute cache) or `.fetchCurrent`; falls back to the cached copy offline. Throws `RevflareOfferingsError`. |
| `RevflareOfferings.current` / `all` / `ordered` / `[id]` / `offering(forPlacement:)` / `version` | Offerings; a placement gives its offering, else the current one. |
| `RevflareOffering.packages` / `package(identifier:)` / `annual`, `weekly`… / `metadata` / `metadata(_:as:)` / `decodeMetadata(_:)` | Packages in server order (unavailable products left out) and paywall metadata. |
| `RevflarePackage.product` / `identifier` / `metadata` / `offeringIdentifier` | StoreKit 2 `Product` of the package. |
| `RevflareStore.offerings` / `loadOfferings(fetchPolicy:)` / `offering(forPlacement:)` / `currentOffering` | Offerings in the store; `isLoadingOfferings`, `offeringsError`. |
| `RevflareStore.purchase(_ package:placement:appAccountToken:options:)` | Buys a package's product; `placement` goes with the purchase events. |
| `RevflareStore.products` / `loadProducts()` | StoreKit `Product`s in the order of `productIds`; `isLoadingProducts`, `productsError`. |
| `RevflareStore.purchase(_:placement:appAccountToken:options:)` | Buys; returns `.purchased(transaction)`, `.userCancelled` or `.pending`; throws StoreKit errors and `RevflareStoreError.failedVerification`. |
| `RevflareStore.restore()` | `AppStore.sync()` then refresh. For a "Restore Purchases" button only. |
| `RevflareStore.activeEntitlements` / `entitlement(named:)` / `isActive(_:)` / `isActive(productIds:)` | Access. `hasLoadedEntitlements` is false until the first check. |
| `RevflareStore.subscription(for:)` / `subscriptions` | Expiration, renewal, auto-renew, trial / intro, grace period, billing retry. |
| `RevflareStore.eligibleIntroOffer(for:)` / `isEligibleForIntroOffer(_:)` / `introOfferEligibility` | Intro offer only when the customer can get it. |
| `RevflareStore.refresh()` | Re-reads entitlements (local, no prompt). |
| `RevflareStore.purchase(_:promotionalOffer:placement:appAccountToken:)` (product or package) | Signs the promotional offer on your Revflare server (`POST /sdk/v1/offers/sign`, 10 s), then buys with it (JWS form with the iOS 26 SDK, else legacy). Throws `RevflareOfferError`. |
| `RevflareStore.promotionalOffers(for:)` | The product's promotional offers when the customer has or had a subscription in its group, else `[]`. |
| `RevflareStore.winBackOffers(for:)` / `purchase(_:winBackOffer:placement:appAccountToken:)` | iOS 18+: eligible win-back offers (best first) and buying with one. |
| `RevflareStore.isLapsed(entitlement:)` / `lapsedSubscription(groupID:)` | Expired, no access, not in grace / billing retry: the audience for offers. Also on `CustomerEntitlements`. |
| `Revflare.promotionalOfferSignature(productId:offerId:appAccountToken:)` | Signature for apps with their own StoreKit code; `signature.purchaseOptions()`. |
| `Revflare.track(_:properties:)` | Custom app-usage event for funnels (name 1-64 `A-Z a-z 0-9 _ . : -`, up to 10 string / number / bool properties). Thread-safe, returns at once. |
| `Revflare.trackPaywallView(placement:offering:)` / `trackPaywallClose(placement:offering:)` | `paywall_view` / `paywall_close` with `placement` and `offering`. |
| `Revflare.analyticsEnabled` | `true` by default; `false` deletes the queued events and stops collecting (kept in UserDefaults). |
| `Revflare.remoteConfig` | `RevflareRemoteConfig` (`@MainActor`, `ObservableObject`): the app's remote config. |
| `setDefaults(_:)` / `setDefaults(plistNamed:bundle:)` | In-app defaults (`String`, `Int`, `Double`, `Bool`, `[String: Any]`, `[Any]`). |
| `string(_:default:)` / `bool` / `int` / `double` / `json(_:)` / `decode(_:as:)` / `[key]` | Values: remote → default → `default:` argument; converts between types. |
| `source(for:)` / `allKeys` | `.remote` / `.default` / `.static`; every key with a value. |
| `fetchAndActivate(timeout:)` | Fetch and apply (default 3 s wait, never throws); `true` when the server answered in time. |
| `fetch()` / `activate()` | Fetch only (kept on the device) / apply what was fetched. |
| `isLoaded` / `lastFetchStatus` / `lastFetchDate` / `conditions` / `country` / `version` | `@Published` state. |
| `attribution` | `@Published` `RevflareAttribution` the config requests are made for; a change refetches into the pending slot. |
| `experiments` / `experiment(_:)` / `variant(forExperiment:)` | Enrolled experiments (`RevflareExperiment`: `id`, `variant`, `keys`; `@Published`, cached with the values). Reading a parameter of one tracks `experiment_exposure` once per install and variant. |
| `trackExposure(experiment:)` | Records the exposure for apps that branch on the variant without reading a parameter; `false` when not enrolled. |
| `autoFetch` / `minimumFetchInterval` | Automatic fetch at `configure` and on foreground (default on) / foreground refetch age (default 3600 s). |
| `Revflare.debugLogging` | `true` logs every step to the unified log (subsystem `app.revflare.kit`). |

Debugging: set `Revflare.debugLogging = true` before `configure`, run the app, and filter Console (or Xcode's console)
on `app.revflare.kit`. A wrong SDK key is always logged as an error. Test attribution on a device: the Simulator may not
produce a usable token, and Apple only reports a campaign for App Store installs that came from an ad (otherwise the
install is organic).

## Changes

- **1.9.2**: no longer reads disk space (an Apple required-reason API with no allowed reason for ad networks); the Meta `extinfo` disk fields are `0`.
- **1.9.1**: the cached pass history is checked against `Transaction.currentEntitlements` on every refresh (also on
  foreground): it is re-read when the latest transaction of a pass product changed (a pass bought on another device, a
  refunded latest pass), and a pass product with no current transaction grants nothing, so deleted transactions
  (StoreKit testing "Delete transactions") or a refund whose `Transaction.updates` event never reached the app no
  longer keep a pass active. Revoked transactions are left out of the cache. No `Transaction.all` walk when nothing
  changed.
- **1.9.0**: server-driven entitlements (merged with the app's map, kept on the device per server + SDK key, their
  products loaded automatically; stores made with product ids make one cached request at start and on foreground for
  them and still don't load the offerings) and non-renewing pass durations (`nonRenewingDurations:`,
  `NonRenewingDuration`; passes expire, stack and are no longer `isLifetime`). Durations only apply to non-renewing
  subscriptions (never non-consumables), and server durations never apply to products the app declares
  (`declaredProductIds`) unless it sets a local duration too. `RevflareStore.mapping` is now the merged map
  (`localMapping` is the app's). Needs a Revflare server with `/apps/:id/entitlements` for the server part; against an
  older server 1.9 ignores the (absent) server map and uses the local map and durations only. Stacked passes can expire
  later on the device than in the dashboard (which stores purchase + duration per pass); a refunded pass in a stack
  moves the later passes earlier.
- **1.8.0**: targeting by acquisition source, test and debug data (`Revflare.environment`).

## Development

```sh
cd sdk/ios
swift test                                                   # logic tests on macOS (attribution, environment, entitlements, store, offerings, events, remote config, offers)
xcodebuild -scheme RevflareKit -destination 'generic/platform=iOS Simulator' build
```

Server contract: `POST /sdk/v1/report`, `POST /sdk/v1/identifiers`, `GET /sdk/v1/offerings`, `POST /sdk/v1/events`, `GET /sdk/v1/config` and `POST /sdk/v1/offers/sign` in [`docs/api.md`](../../docs/api.md#apple-ads-attribution-revflarekit).

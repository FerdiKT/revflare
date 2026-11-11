import Foundation
import StoreKit

/// Apple Ads attribution for Revflare.
///
/// Call ``configure(sdkKey:server:)`` once at launch. RevflareKit then, in the background:
/// - sends the install's AdServices attribution token once, so Revflare can ask Apple which Apple Ads campaign,
///   ad group and keyword brought the install;
/// - reports the original transaction ids of the StoreKit purchases this install owns, so their revenue joins the
///   campaign (needed for apps that buy through RevenueCat or StoreKit 1).
///
/// Apps that buy with StoreKit 2 directly can also pass ``installId`` as the purchase's `appAccountToken`
/// (``purchaseOptions``), which links purchases on the server without waiting for the next sync.
///
/// The attribution never blocks the main thread, never shows UI, never finishes transactions and needs no permission
/// prompt: it is safe next to RevenueCat.
///
/// Opt-in, for Meta (Facebook) ads: ``setMetaAnonymousID(_:)`` / ``collectDeviceIdentifiers()`` report device
/// identifiers so Revflare can send purchases to Meta's Conversions API. Nothing of that is collected before.
///
/// Apps without RevenueCat can also buy and check entitlements with ``RevflareStore``
/// (``configurePurchases(productIds:entitlements:nonRenewingDurations:)``), which then owns (finishes) the app's transactions.
///
/// Paywalls can take their products from the offerings and placements set in Revflare (``offerings(fetchPolicy:)``),
/// so they change without an app update.
///
/// Funnels: RevflareKit collects app-usage events tied to the random install id (``track(_:properties:)``, automatic
/// `first_open` / `app_open` / `session_start` / `app_background`, purchase events from ``RevflareStore``), for the
/// funnels set in Revflare. Turn them off with ``analyticsEnabled``.
///
/// Remote config (``remoteConfig``): parameters set in Revflare, with values resolved per device by conditions
/// (country, app version, language, percentage rollout...), cached on the device. Replaces Firebase Remote Config.
public enum Revflare {
    /// The library version (sent in the `User-Agent`).
    public static let version = "1.9.2"

    private struct Runtime: @unchecked Sendable {
        let reporter: Reporter
        let observers: [NSObjectProtocol]
        let updatesTask: Task<Void, Never>
        let offerings: OfferingsService<StoreKitProductCatalog>
        let events: EventTracker
        let eventsTask: Task<Void, Never>
        let offerSigner: OfferSignatureClient
        /// Where ``RevflareStore`` keeps the server's entitlements and durations (per server + SDK key).
        let serverEntitlementsKey: String
    }

    private static let runtime = Locked<Runtime?>(nil)
    private static let identity = InstallIdentity(secure: KeychainStore(), defaults: UserDefaultsStore())

    /// Starts RevflareKit. Call once at launch, from `App.init` or `application(_:didFinishLaunchingWithOptions:)`.
    ///
    /// Returns immediately; the work happens in the background. Later calls are ignored.
    ///
    /// - Parameters:
    ///   - sdkKey: The app's SDK key (`rfp_...`), shown in Revflare under Apps → the app → "Apple Ads attribution".
    ///     It identifies the app and is not a secret.
    ///   - server: Your Revflare server, e.g. `URL(string: "https://revflare.example.com")!` (the address of the
    ///     web app).
    public static func configure(sdkKey: String, server: URL) {
        configure(sdkKey: sdkKey, server: server, environment: .automatic)
    }

    /// Starts RevflareKit with an explicit environment (see ``configure(sdkKey:server:)``).
    ///
    /// - Parameter environment: ``RevflareEnvironment/automatic`` (default) detects it on the device; pass
    ///   ``RevflareEnvironment/production`` / ``RevflareEnvironment/sandbox`` / ``RevflareEnvironment/xcode`` to force it,
    ///   e.g. `.sandbox` for an internal build distributed outside TestFlight. Sent with every request so Revflare can
    ///   keep test data out of its analytics.
    public static func configure(sdkKey: String, server: URL, environment: RevflareEnvironment) {
        let key = sdkKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            Log.error("Revflare.configure: the SDK key is empty; RevflareKit stays off")
            return
        }
        let remoteConfigFetcher: RemoteConfigFetcher? = runtime.withLock { runtime in
            guard runtime == nil else {
                Log.debug("Revflare.configure called again: ignored")
                return nil
            }
            environmentOverride.withLock { $0 = environment }
            let client = ReportClient(server: server, sdkKey: key, transport: URLSessionTransport(),
                                      environment: { Revflare.environment.rawValue })
            // A new install (no reporter state yet) lets its first config fetch wait for the first attribution report.
            let gate = AttributionGate(store: defaults)
            let remoteConfigFetcher = RemoteConfigFetcher(
                client: client,
                contextProvider: SystemRemoteConfigContextProvider(
                    identity: identity,
                    gate: gate,
                    attribution: { Revflare.attribution },
                    environment: { Revflare.environment.rawValue }
                )
            )
            // Before Revflare.remoteConfig is first created, so it starts with this server's cached values.
            RemoteConfigStorage(store: defaults).rememberScope(remoteConfigFetcher.cacheKey)
            let env = ReporterEnvironment(
                transport: client.transport,
                tokenProvider: AdServicesTokenProvider(),
                transactions: StoreKitTransactionSource(),
                store: defaults,
                identity: identity,
                appVersion: AppInfo.version,
                onAttributionChange: { attribution in Revflare.attributionDidChange(attribution) },
                onFirstAttributionReport: { gate.open() }
            )
            let reporter = Reporter(client: client, environment: env)

            var observers: [NSObjectProtocol] = []
            if let name = foregroundNotification {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { _ in
                    Task.detached(priority: .utility) { await reporter.sync(.foreground) }
                })
            }
            // Renewals, purchases on other devices, Ask to Buy, offer codes... Reading the sequence does not
            // consume it: the app's (or RevenueCat's) own listener still receives every update.
            let updatesTask = Task.detached(priority: .utility) {
                for await update in Transaction.updates {
                    if case .verified(let transaction) = update { TransactionEnvironmentRecorder.record(transaction) }
                    await reporter.sync(.transactionUpdate)
                }
            }
            let offerings = OfferingsService(
                fetcher: OfferingsFetcher(client: client, store: defaults, appVersion: AppInfo.version),
                catalog: StoreKitProductCatalog()
            )

            // Read before the reporter's first pass writes its state: an app that already ran RevflareKit (1.3 or
            // older) is not a new install and gets no first_open.
            let existingInstall = defaults.data(forKey: Reporter.stateKey) != nil
            let events = EventTracker(client: client, environment: EventsEnvironment(
                storage: FileEventStorage.appDefault() ?? MemoryEventStorage(),
                store: defaults,
                identity: identity
            ))
            let pipe = eventPipe
            let eventsTask = Task.detached(priority: .utility) {
                for await command in pipe.stream { await events.handle(command) }
            }
            // After the events tracked before configure (already in the pipe).
            pipe.send(.launch(Date(), existingInstall: existingInstall))
            if let name = foregroundNotification {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { _ in
                    pipe.send(.foreground(Date()))
                })
            }
            if let name = foregroundNotification {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { _ in
                    Task { @MainActor in await remoteConfig.foregroundRefresh() }
                })
            }
            if let name = backgroundNotification {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { _ in
                    let date = Date()
                    // Keeps the app running until the queue is sent (or the system's time runs out).
                    ExpiringActivityExecution().perform("RevflareKit events") { done in
                        pipe.send(.background(date, done: done))
                    }
                })
            }

            runtime = Runtime(reporter: reporter, observers: observers, updatesTask: updatesTask, offerings: offerings,
                              events: events, eventsTask: eventsTask,
                              offerSigner: OfferSignatureClient(client: client),
                              serverEntitlementsKey: ServerEntitlements.storageKey(server: server, sdkKey: key))
            Task.detached(priority: .utility) { await reporter.sync(.launch) }
            Log.debug("Configured for \(server.absoluteString)")
            return remoteConfigFetcher
        }
        if let remoteConfigFetcher {
            // Synchronously when called on the main thread (App.init), so `autoFetch` set just before is honoured.
            if Thread.isMainThread {
                MainActor.assumeIsolated { remoteConfig.start(remoteConfigFetcher) }
            } else {
                Task { @MainActor in remoteConfig.start(remoteConfigFetcher) }
            }
        }
    }

    // MARK: Attribution and environment

    /// Posted (on any thread) when ``attribution`` changes, e.g. when Revflare learns that Apple Ads brought the
    /// install. ``RevflareRemoteConfig/attribution`` is the `@Published` form.
    public static let attributionDidChangeNotification = Notification.Name("RevflareAttributionDidChange")

    private static let attributionValue = Locked<RevflareAttribution?>(nil)
    private static let environmentOverride = Locked<RevflareEnvironment>(.automatic)

    /// How this install was acquired (Apple Ads campaign / ad group / keyword, or organic), as Revflare resolved it.
    /// ``RevflareAttribution/Source/unknown`` until then (first launch: usually seconds to minutes). Read only; kept
    /// on the device.
    public static var attribution: RevflareAttribution {
        if let value = attributionValue.current { return value }
        let stored = defaults.data(forKey: Reporter.stateKey)
            .flatMap { try? JSONDecoder().decode(ReporterState.self, from: $0) }?.publicAttribution ?? .unknown
        return attributionValue.withLock { value in
            if value == nil { value = stored }
            return value ?? stored
        }
    }

    static func attributionDidChange(_ attribution: RevflareAttribution) {
        attributionValue.withLock { $0 = attribution }
        NotificationCenter.default.post(name: attributionDidChangeNotification, object: nil)
        Task { @MainActor in await remoteConfig.attributionChanged(attribution) }
    }

    /// The environment RevflareKit reports for this run (never ``RevflareEnvironment/automatic``): the one passed to
    /// ``configure(sdkKey:server:environment:)``, else detected without network or prompts (Simulator / debugger →
    /// `xcode`, TestFlight and sandbox → `sandbox`, else `production`). Handy to label your own logs; don't branch
    /// analytics on `DEBUG` any more, Revflare separates test data itself.
    public static var environment: RevflareEnvironment {
        EnvironmentDetector.resolve(override: environmentOverride.current, signals: SystemEnvironmentSignals())
    }

    /// The app's remote config (parameters set in Revflare web → the app → Remote config), see
    /// ``RevflareRemoteConfig``. The values activated last are available at once, also offline and before
    /// ``configure(sdkKey:server:)``; `configure` then fetches and activates in the background (``RevflareRemoteConfig/autoFetch``).
    @MainActor public static let remoteConfig = RevflareRemoteConfig(store: UserDefaultsStore())

    /// This install's id: a random UUID created on first use and kept in the keychain (so it usually survives a
    /// reinstall), with a UserDefaults copy as fallback. It carries no personal data.
    ///
    /// Available before ``configure(sdkKey:server:)``. Pass it as `appAccountToken` when buying with StoreKit 2
    /// (see ``purchaseOptions``) to link the purchase to this install.
    public static var installId: UUID { identity.resolve().id }

    /// Purchase options that link a StoreKit 2 purchase to this install:
    /// `try await product.purchase(options: Revflare.purchaseOptions)`.
    ///
    /// Equivalent to `[.appAccountToken(Revflare.installId)]`. If the app already sets its own `appAccountToken`
    /// (a user id), keep it: RevflareKit still links the purchase through the original transaction id.
    public static var purchaseOptions: Set<Product.PurchaseOption> { [.appAccountToken(installId)] }

    /// Prints what RevflareKit does to the unified log (`os.Logger`, subsystem `app.revflare.kit`). Off by default.
    public static var debugLogging: Bool {
        get { Log.enabled.current }
        set { Log.enabled.withLock { $0 = newValue } }
    }

    /// The store created by ``configurePurchases(productIds:entitlements:nonRenewingDurations:)``, nil before.
    @MainActor public private(set) static var store: RevflareStore?

    /// Creates the app's ``RevflareStore`` (StoreKit 2 purchases and entitlements) and keeps it in ``store``.
    /// Call once at launch, next to ``configure(sdkKey:server:)``; later calls return the first store.
    ///
    /// The store finishes the app's transactions: do not use it together with RevenueCat.
    ///
    /// With ``configure(sdkKey:server:)``, the store also reads the entitlements and non-renewing durations set in
    /// Revflare (one cached request at start and on foreground; merged with these, see ``RevflareStore/mapping``) and
    /// loads the products they refer to, so a product added there unlocks its entitlement without an app update. It
    /// does not load the offerings (call ``RevflareStore/loadOfferings(fetchPolicy:)`` for that). Durations set in
    /// Revflare never apply to `productIds` / `entitlements` products: give those a local duration here.
    ///
    /// - Parameters:
    ///   - productIds: The App Store product ids to load.
    ///   - entitlements: Entitlement name → product ids that grant it, e.g. `["pro": ["app.annual", "app.lifetime"]]`.
    ///   - nonRenewingDurations: Non-renewing subscription id → how long a purchase gives access, e.g.
    ///     `["app.pass_3day": .days(3)]`. Only non-renewing subscriptions use one (non-consumables are lifetime).
    @MainActor @discardableResult
    public static func configurePurchases(productIds: [String], entitlements: [String: [String]] = [:],
                                          nonRenewingDurations: [String: NonRenewingDuration] = [:]) -> RevflareStore {
        if let store { return store }
        let created = RevflareStore(productIds: productIds, entitlements: entitlements,
                                    nonRenewingDurations: nonRenewingDurations)
        store = created
        return created
    }

    /// Creates the app's ``RevflareStore`` with its products coming from the offerings set in Revflare: the store
    /// loads ``RevflareStore/offerings`` at start (and on foreground) and adds their products to
    /// ``RevflareStore/products``. Call ``configure(sdkKey:server:)`` first. Later calls return the first store.
    ///
    /// The store finishes the app's transactions: do not use it together with RevenueCat.
    ///
    /// - Parameters:
    ///   - entitlements: Entitlement name → product ids that grant it. List every product that unlocks something,
    ///     also ones on no paywall (they are loaded too); entitlements set in Revflare are added.
    ///   - nonRenewingDurations: Non-renewing subscription id → how long a purchase gives access. Durations set in
    ///     Revflare never apply to the products listed in `entitlements`; set them here.
    @MainActor @discardableResult
    public static func configurePurchases(entitlements: [String: [String]],
                                          nonRenewingDurations: [String: NonRenewingDuration] = [:]) -> RevflareStore {
        if let store { return store }
        let created = RevflareStore(entitlements: entitlements, nonRenewingDurations: nonRenewingDurations)
        store = created
        return created
    }

    /// The app's offerings, as set in Revflare (web → the app → Offerings): which products each paywall shows, in
    /// which order, with their metadata, and which offering each placement uses. Change them there without an app
    /// update.
    ///
    /// Works with or without ``RevflareStore``. The last good answer is kept on the device: with
    /// ``OfferingsFetchPolicy/cachedOrFetched`` a fresh (under 5 minutes) copy is returned at once, and any
    /// network failure falls back to the cached copy. Products StoreKit can't load are left out of the packages.
    ///
    /// - Throws: ``RevflareOfferingsError`` (`.notConfigured` before ``configure(sdkKey:server:)``, network or server
    ///   errors when nothing is cached).
    public static func offerings(fetchPolicy: OfferingsFetchPolicy = .cachedOrFetched) async throws -> RevflareOfferings {
        guard let service = runtime.current?.offerings else { throw RevflareOfferingsError.notConfigured }
        return RevflareOfferings(try await service.offerings(policy: fetchPolicy))
    }

    /// The entitlements and non-renewing durations set in Revflare, from the offerings answer (one request, shared
    /// with ``offerings(fetchPolicy:)``: same cache and ETag) without loading the offerings' products from StoreKit.
    static func serverEntitlements(fetchPolicy: OfferingsFetchPolicy = .cachedOrFetched) async throws -> ServerEntitlements {
        guard let service = runtime.current?.offerings else { throw RevflareOfferingsError.notConfigured }
        return try await service.fetcher.offerings(policy: fetchPolicy).serverEntitlements
    }

    /// The key ``RevflareStore`` keeps the server's entitlements under; nil before ``configure(sdkKey:server:)``.
    static var serverEntitlementsStorageKey: String? { runtime.current?.serverEntitlementsKey }

    /// Asks your Revflare server to sign a promotional offer (with the app's In-App Purchase key, uploaded in Revflare;
    /// the offer must be in the app's allowlist: web → the app → Offers). For apps that buy with their own StoreKit
    /// code: `try await product.purchase(options: signature.purchaseOptions())`. With ``RevflareStore`` use
    /// ``RevflareStore/purchase(_:promotionalOffer:placement:appAccountToken:)``.
    ///
    /// Promotional offers are only for customers who have or had a subscription in the product's group.
    ///
    /// - Parameters:
    ///   - appAccountToken: The token the purchase will send (covered by the signature); defaults to ``installId``.
    ///     ``RevflarePromotionalOfferSignature/purchaseOptions()`` includes it.
    /// - Throws: ``RevflareOfferError``.
    public static func promotionalOfferSignature(productId: String, offerId: String,
                                                 appAccountToken: UUID? = nil) async throws -> RevflarePromotionalOfferSignature {
        let token = appAccountToken ?? installId
        var signature = try await signPromotionalOffer(productId: productId, offerId: offerId, appAccountToken: token)
        signature.appAccountToken = token
        return signature
    }

    /// `POST /sdk/v1/offers/sign` (the background, at most ``OfferSignatureClient/timeout`` seconds).
    static func signPromotionalOffer(productId: String, offerId: String,
                                     appAccountToken: UUID?) async throws -> RevflarePromotionalOfferSignature {
        guard let signer = runtime.current?.offerSigner else { throw RevflareOfferError.sdkNotConfigured }
        let body = OfferSignatureRequest(installId: installId, productId: productId, offerId: offerId,
                                         appAccountToken: appAccountToken)
        return try await signer.sign(body)
    }

    /// Reports new purchases right away instead of at the next launch or foreground. Optional: call it after a
    /// purchase made through another SDK (e.g. RevenueCat) if you want it linked immediately. Does nothing before
    /// ``configure(sdkKey:server:)``.
    public static func syncPurchases() {
        guard let reporter = runtime.current?.reporter else { return }
        Task.detached(priority: .utility) { await reporter.sync(.manual) }
    }

    /// Opts in to Meta (Facebook) ads matching and sets the Facebook SDK's anonymous id:
    /// `Revflare.setMetaAnonymousID(AppEvents.shared.anonymousID)`. RevflareKit does not depend on the Facebook SDK.
    ///
    /// - Important: This is tracking data under Apple's definition once Revflare sends it to Meta for ads. Call it
    ///   only after the app's own consent flow (and App Tracking Transparency where required), never for users who
    ///   declined. Nothing is collected or sent before this or ``collectDeviceIdentifiers()`` is called.
    ///
    /// The opt-in and the id are kept in UserDefaults. RevflareKit then reports, to `POST /sdk/v1/identifiers` on your
    /// Revflare server, the anonymous id, the IDFV, the tracking status, the IDFA (only when the user allowed
    /// tracking; RevflareKit never shows the prompt) and Meta's device info, and reports again whenever any of it,
    /// the app version or the OS version changes. Can be called before or after ``configure(sdkKey:server:)``.
    public static func setMetaAnonymousID(_ id: String) {
        let value = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            Log.debug("Revflare.setMetaAnonymousID: empty id ignored")
            return
        }
        Reporter.optIn(store: defaults, metaAnonymousId: value)
        checkIdentifiers()
    }

    /// Opts in to device identifiers for Meta (Facebook) ads matching without a Facebook anonymous id (IDFA when
    /// allowed, IDFV, tracking status and device info), and re-checks them now.
    ///
    /// Call it again right after the app's App Tracking Transparency prompt completes, so the IDFA is reported at
    /// once. Calling it again is cheap: nothing is sent when nothing changed.
    ///
    /// - Important: This is tracking data under Apple's definition once Revflare sends it to Meta for ads. Call it
    ///   only after the app's own consent flow (and App Tracking Transparency where required), never for users who
    ///   declined. Nothing is collected or sent before this or ``setMetaAnonymousID(_:)`` is called.
    public static func collectDeviceIdentifiers() {
        Reporter.optIn(store: defaults, metaAnonymousId: nil)
        checkIdentifiers()
    }

    private static let defaults = UserDefaultsStore()

    // MARK: Events

    static let eventPipe = EventPipe()
    private static let analyticsFlag = Locked<Bool?>(nil)

    /// Records an app-usage event for funnels (onboarding steps, screens, feature use):
    /// `Revflare.track("onboarding_step", properties: ["step": 2, "name": "notifications"])`.
    ///
    /// Thread-safe; returns at once (the event is queued on disk and sent in the background, in batches). Events
    /// tracked before ``configure(sdkKey:server:)`` wait in memory and go out after it. Nothing is recorded while
    /// ``analyticsEnabled`` is false.
    ///
    /// - Parameters:
    ///   - name: 1-64 characters of `A-Z a-z 0-9 _ . : -` (e.g. `onboarding_step`, `export_pdf`). Events with other
    ///     names are dropped (logged with ``debugLogging``). Keep names stable: funnels match them.
    ///   - properties: Up to 10 values; keys 1-40 characters of `A-Z a-z 0-9 _ . -`. Strings (cut to 100
    ///     characters), numbers and booleans (sent as strings), `UUID`, `URL`, `Date` (ISO 8601) and string enums;
    ///     other values are dropped. Never put personal data here.
    public static func track(_ name: String, properties: [String: Any] = [:]) {
        guard analyticsEnabled else { return }
        guard let event = EventSanitizer.event(name: name, properties: properties, at: Date()) else { return }
        eventPipe.send(.track(event))
    }

    /// Records that a paywall is shown (`paywall_view`, with `placement` and `offering`): call it from the paywall's
    /// `onAppear` / `viewDidAppear`. RevflareKit can't know when a paywall shows; purchase events follow on their own
    /// with ``RevflareStore``.
    public static func trackPaywallView(placement: String? = nil, offering: RevflareOffering? = nil) {
        track("paywall_view", properties: paywallProperties(placement: placement, offeringId: offering?.identifier))
    }

    /// Records that a paywall was closed without buying (`paywall_close`, with `placement` and `offering`).
    public static func trackPaywallClose(placement: String? = nil, offering: RevflareOffering? = nil) {
        track("paywall_close", properties: paywallProperties(placement: placement, offeringId: offering?.identifier))
    }

    static func paywallProperties(placement: String?, offeringId: String?) -> [String: Any] {
        var properties: [String: Any] = [:]
        if let placement, !placement.isEmpty { properties["placement"] = placement }
        if let offeringId, !offeringId.isEmpty { properties["offering"] = offeringId }
        return properties
    }

    /// Whether RevflareKit collects app-usage events (default true). Set it to false for users who opt out of
    /// analytics: the queued events are deleted and nothing is recorded or sent until it is true again. Kept in
    /// UserDefaults. Attribution, purchase links and offerings are not affected.
    public static var analyticsEnabled: Bool {
        get {
            analyticsFlag.withLock { flag in
                if let flag { return flag }
                let value = EventTracker.isEnabled(store: defaults)
                flag = value
                return value
            }
        }
        set {
            analyticsFlag.withLock { flag in
                flag = newValue
                defaults.set(newValue ? "1" : "0", forKey: EventTracker.enabledKey)
                eventPipe.send(.setEnabled(newValue))
            }
        }
    }

    /// Events RevflareKit records itself (purchases, restores): only after ``configure(sdkKey:server:)``.
    static func trackAutomatic(_ name: String, properties: [String: String]) {
        guard runtime.current != nil else { return }
        track(name, properties: properties)
    }

    /// Re-checks the identifiers in the background (no-op before ``configure(sdkKey:server:)``: the launch pass does it).
    private static func checkIdentifiers() {
        guard let reporter = runtime.current?.reporter else { return }
        Task.detached(priority: .utility) { await reporter.sync(.identifiers) }
    }

    static var foregroundNotification: Notification.Name? {
        #if os(iOS) || os(tvOS) || os(visionOS)
        return Notification.Name("UIApplicationWillEnterForegroundNotification")
        #elseif os(macOS)
        return Notification.Name("NSApplicationWillBecomeActiveNotification")
        #else
        return nil
        #endif
    }
}

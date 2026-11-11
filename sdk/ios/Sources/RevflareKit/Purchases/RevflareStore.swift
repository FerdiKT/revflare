import Foundation
import StoreKit
import Combine

/// Errors thrown by ``RevflareStore``.
public enum RevflareStoreError: LocalizedError, Equatable {
    /// StoreKit returned a transaction it could not verify (JWS signature). Nothing is unlocked.
    case failedVerification(String)

    public var errorDescription: String? {
        switch self {
        case .failedVerification: return "The purchase could not be verified."
        }
    }
}

/// StoreKit 2 purchases and entitlements, a small replacement for RevenueCat's `Purchases`.
///
/// Create **one** store at launch (``Revflare/configurePurchases(productIds:entitlements:nonRenewingDurations:)`` or ``init(productIds:entitlements:nonRenewingDurations:)``)
/// and keep it for the app's lifetime. From then on the store:
/// - listens to `Transaction.updates` and finishes every verified transaction (renewals, Ask to Buy approvals,
///   offer codes, purchases made on other devices), then refreshes the entitlements;
/// - computes ``activeEntitlements`` from `Transaction.currentEntitlements` and the subscription statuses
///   (billing grace period counts as active; billing retry, expiry, refunds and upgrades do not), with the app's
///   entitlement map merged with the one set in Revflare (``mapping``) and non-renewing passes expiring after their
///   duration (``nonRenewingDurations``; repeat purchases stack; only non-renewing subscriptions, never
///   non-consumables; a server duration never applies to a product the app declares itself unless the app sets a
///   local duration for it too);
/// - when ``Revflare/configure(sdkKey:server:)`` was called, reads the entitlements and durations set in Revflare at
///   start and on foreground (one request, cached) and loads the products they refer to, so a product added in
///   Revflare unlocks its entitlement without an app update. Stores made from offerings
///   (``init(entitlements:nonRenewingDurations:)``) also load the offerings and their products; stores made with
///   product ids (``init(productIds:entitlements:nonRenewingDurations:)``) only do on ``loadOfferings(fetchPolicy:)``;
/// - buys with ``purchase(_:placement:appAccountToken:options:)`` (the install id as `appAccountToken`, so Revflare
///   links the purchase to the install's Apple Ads campaign at once) and restores with ``restore()``;
/// - records the funnel events `purchase_start`, `purchase_success`, `purchase_cancel`, `purchase_pending`,
///   `purchase_failed`, `restore_start`, `restore_success` and `restore_failed` (see ``Revflare/track(_:properties:)``;
///   off with ``Revflare/analyticsEnabled``);
/// - redeems promotional offers signed by the Revflare server
///   (``purchase(_:promotionalOffer:placement:appAccountToken:)``, ``promotionalOffers(for:)``) and, on iOS 18+,
///   win-back offers (``purchase(_:winBackOffer:placement:appAccountToken:)``, ``winBackOffers(for:)``) for lapsed
///   subscribers (``lapsedSubscription(groupID:)``, ``isLapsed(entitlement:)``).
///
/// - Important: The store **owns the app's transactions**: it finishes them. Do not use it in an app that also uses
///   RevenueCat (or any other purchase SDK that finishes transactions); such apps keep the attribution-only mode
///   (``Revflare/configure(sdkKey:server:)`` alone).
///
/// The store is an `ObservableObject` (the package supports iOS 15): use `@ObservedObject` / `@StateObject` /
/// `@EnvironmentObject` in SwiftUI, or the `$customer` publisher elsewhere.
@MainActor
public final class RevflareStore: ObservableObject {
    /// What a purchase came to.
    public enum PurchaseOutcome: Sendable, Equatable {
        /// Verified and finished; ``activeEntitlements`` already includes it.
        case purchased(RevflareTransaction)
        /// The user closed the purchase sheet. Nothing changed.
        case userCancelled
        /// Waiting for approval (Ask to Buy, Strong Customer Authentication). The transaction arrives later through
        /// `Transaction.updates`; the store unlocks it then.
        case pending

        public var isPurchased: Bool {
            if case .purchased = self { return true }
            return false
        }
    }

    /// The product ids the store loads, in this order. Products of the entitlements and durations set in Revflare,
    /// and of loaded ``offerings``, are added at the end.
    @Published public private(set) var productIds: [String]
    /// Entitlement names → product ids: the app's own map plus the one set in Revflare (union per entitlement). The
    /// server part is kept on the device and applied at launch, also offline.
    @Published public private(set) var mapping: EntitlementMapping
    /// Non-renewing product id → how long a purchase gives access: the app's own durations, plus the ones set in
    /// Revflare for products the app does not declare itself (``declaredProductIds``).
    @Published public private(set) var nonRenewingDurations: [String: NonRenewingDuration]
    /// The app's own entitlement map (``init(productIds:entitlements:nonRenewingDurations:)``).
    public let localMapping: EntitlementMapping
    /// The app's own durations.
    public let localNonRenewingDurations: [String: NonRenewingDuration]
    /// The products the app declares itself (its product ids and entitlement map). Durations set in Revflare never
    /// apply to them (only the app's own ``localNonRenewingDurations`` do): a server configuration can add products and
    /// entitlements, never shorten access to the products the app shipped with.
    public let declaredProductIds: Set<String>

    /// The loaded products, in the order of ``productIds`` (unknown ids are left out).
    @Published public private(set) var products: [Product] = []
    @Published public private(set) var isLoadingProducts = false
    /// The last product loading error (network...), nil once products loaded.
    @Published public private(set) var productsError: String?
    /// The customer's access.
    @Published public private(set) var customer = CustomerEntitlements()
    /// False until the first entitlement check finished (avoid showing a paywall to a subscriber at launch).
    @Published public private(set) var hasLoadedEntitlements = false
    @Published public private(set) var isPurchasing = false
    /// Product id → whether the customer can still get its introductory offer (only products that have one).
    @Published public private(set) var introOfferEligibility: [String: Bool] = [:]
    /// The offerings set in Revflare, once loaded (``loadOfferings(fetchPolicy:)``; automatic at start and on
    /// foreground for stores made from offerings, ``init(entitlements:nonRenewingDurations:)``).
    @Published public private(set) var offerings: RevflareOfferings?
    @Published public private(set) var isLoadingOfferings = false
    /// The last offerings loading error, nil once offerings loaded.
    @Published public private(set) var offeringsError: String?

    private let backend: PurchaseBackend
    private let productLoader: @Sendable ([String]) async throws -> [Product]
    private let now: @Sendable () -> Date
    private let linkPurchases: @Sendable () -> Void
    private let offeringsLoader: @Sendable (OfferingsFetchPolicy) async throws -> RevflareOfferings
    /// Records funnel events (``Revflare/trackAutomatic(_:properties:)`` in the app).
    private let trackEvent: @Sendable (String, [String: String]) -> Void
    /// Signs a promotional offer: (product id, offer id, appAccountToken) → signature (``Revflare`` in the app).
    private let signOffer: @Sendable (String, String, UUID?) async throws -> RevflarePromotionalOfferSignature
    /// Loads the offerings at start and on foreground.
    private let loadsOfferingsAutomatically: Bool
    /// False: automatic loads stay quiet when ``Revflare/configure(sdkKey:server:)`` was not called (stores made with
    /// product ids work without an SDK key).
    private let reportsMissingConfiguration: Bool
    private let tasks = Locked<[Task<Void, Never>]>([])
    private let observers = Locked<[NSObjectProtocol]>([])
    private var refreshGeneration = 0
    /// Subscription groups in `Transaction.all` (promotional offer eligibility), loaded once and kept until a new
    /// transaction or a restore: walking the whole history on every paywall would be slow.
    private var purchasedGroupsCache: Set<String>?
    private var expiryTask: Task<Void, Never>?
    /// The entitlements and durations set in Revflare (last answer, kept in `persistence`).
    private var serverEntitlements: ServerEntitlements
    private let persistence: KeyValueStore
    /// Waits (seconds); injected by tests.
    private let sleep: @Sendable (TimeInterval) async -> Void
    /// Server product ids already asked from StoreKit this session (unknown ones are not asked again).
    private var requestedServerProductIds: Set<String> = []
    /// Reads the entitlements and durations set in Revflare (one cached request, no StoreKit product loading).
    private let serverEntitlementsLoader: @Sendable (OfferingsFetchPolicy) async throws -> ServerEntitlements
    /// Reads them at start and on foreground when the offerings are not loaded automatically.
    private let syncsServerEntitlements: Bool
    /// The persistence key of the server's part (per server + SDK key; nil before ``Revflare/configure(sdkKey:server:)``).
    private let serverEntitlementsKey: @Sendable () -> String?
    /// Non-renewing transactions of the products with a duration (`Transaction.all`, revoked ones left out), kept
    /// until a transaction update, a purchase or a restore, or until `Transaction.currentEntitlements` no longer
    /// matches it (`anchors`, see ``PassHistoryRules``): walking the whole history on every refresh would be slow.
    private var nonRenewingHistoryCache: PassHistoryCache?
    private var nonRenewingHistoryGeneration = 0

    /// Creates the store and starts listening to transactions. Create one per app, at launch.
    ///
    /// - Parameters:
    ///   - productIds: The App Store product ids to load (subscriptions, non-consumables...).
    ///   - entitlements: Entitlement name → the product ids that grant it, e.g.
    ///     `["pro": ["app.weekly", "app.annual", "app.lifetime"]]` (like RevenueCat entitlements). Entitlements set in
    ///     Revflare are added to it.
    ///   - nonRenewingDurations: Non-renewing subscription id → how long a purchase gives access, e.g.
    ///     `["app.pass_3day": .days(3)]` (StoreKit gives such purchases no end date). Durations set in Revflare never
    ///     apply to `productIds` / `entitlements` products; set them here.
    ///
    /// With ``Revflare/configure(sdkKey:server:)``, the store also reads the entitlements and durations set in Revflare
    /// (one cached request at start and on foreground) and loads the products they refer to. It does not load the
    /// offerings (``products`` stays the app's products plus the server-mapped ones); call
    /// ``loadOfferings(fetchPolicy:)`` to use them.
    public convenience init(productIds: [String], entitlements: [String: [String]] = [:],
                            nonRenewingDurations: [String: NonRenewingDuration] = [:]) {
        self.init(
            productIds: productIds,
            mapping: EntitlementMapping(entitlements),
            nonRenewingDurations: nonRenewingDurations,
            backend: StoreKitPurchaseBackend(),
            productLoader: { ids in try await Product.products(for: ids) },
            linkPurchases: { Revflare.syncPurchases() },
            loadsOfferingsAutomatically: false,
            syncsServerEntitlements: true,
            reportsMissingConfiguration: false
        )
    }

    /// Creates a store whose products come from the offerings set in Revflare (loaded at start and on foreground),
    /// plus the products listed in `entitlements`. Needs ``Revflare/configure(sdkKey:server:)``. Create one per app,
    /// at launch.
    ///
    /// - Parameters:
    ///   - entitlements: Entitlement name → the product ids that grant it.
    ///   - nonRenewingDurations: Non-renewing subscription id → how long a purchase gives access. Durations set in
    ///     Revflare never apply to the products listed in `entitlements`; set them here.
    public convenience init(entitlements: [String: [String]], nonRenewingDurations: [String: NonRenewingDuration] = [:]) {
        let mapping = EntitlementMapping(entitlements)
        self.init(
            productIds: mapping.allProductIds.sorted(),
            mapping: mapping,
            nonRenewingDurations: nonRenewingDurations,
            backend: StoreKitPurchaseBackend(),
            productLoader: { ids in try await Product.products(for: ids) },
            linkPurchases: { Revflare.syncPurchases() },
            loadsOfferingsAutomatically: true
        )
    }

    init(productIds: [String], mapping: EntitlementMapping, nonRenewingDurations: [String: NonRenewingDuration] = [:],
         backend: PurchaseBackend,
         productLoader: @escaping @Sendable ([String]) async throws -> [Product],
         now: @escaping @Sendable () -> Date = { Date() },
         linkPurchases: @escaping @Sendable () -> Void,
         offeringsLoader: @escaping @Sendable (OfferingsFetchPolicy) async throws -> RevflareOfferings = { policy in
             try await Revflare.offerings(fetchPolicy: policy)
         },
         loadsOfferingsAutomatically: Bool = false,
         serverEntitlementsLoader: @escaping @Sendable (OfferingsFetchPolicy) async throws -> ServerEntitlements = { policy in
             try await Revflare.serverEntitlements(fetchPolicy: policy)
         },
         syncsServerEntitlements: Bool = false,
         reportsMissingConfiguration: Bool = true,
         persistence: KeyValueStore = UserDefaultsStore(),
         serverEntitlementsKey: @escaping @Sendable () -> String? = { Revflare.serverEntitlementsStorageKey },
         sleep: @escaping @Sendable (TimeInterval) async -> Void = { seconds in
             try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
         },
         trackEvent: @escaping @Sendable (String, [String: String]) -> Void = { name, properties in
             Revflare.trackAutomatic(name, properties: properties)
         },
         signOffer: @escaping @Sendable (String, String, UUID?) async throws -> RevflarePromotionalOfferSignature = {
             try await Revflare.signPromotionalOffer(productId: $0, offerId: $1, appAccountToken: $2)
         },
         start: Bool = true) {
        let server = ServerEntitlements.load(from: persistence, key: serverEntitlementsKey())
        let declared = Set(productIds).union(mapping.allProductIds)
        self.localMapping = mapping
        self.localNonRenewingDurations = nonRenewingDurations
        self.declaredProductIds = declared
        self.serverEntitlements = server
        self.persistence = persistence
        self.serverEntitlementsKey = serverEntitlementsKey
        self.serverEntitlementsLoader = serverEntitlementsLoader
        self.syncsServerEntitlements = syncsServerEntitlements
        self.sleep = sleep
        self.reportsMissingConfiguration = reportsMissingConfiguration
        self.mapping = NonRenewingRules.mergedMapping(local: mapping, server: server.entitlements)
        self.nonRenewingDurations = NonRenewingRules.mergedDurations(local: nonRenewingDurations, server: server.durations,
                                                                     declared: declared)
        // Products the saved server mapping refers to are loaded with the others.
        self.productIds = Self.merge(productIds, adding: server.productIds)
        self.backend = backend
        self.productLoader = productLoader
        self.now = now
        self.linkPurchases = linkPurchases
        self.offeringsLoader = offeringsLoader
        self.loadsOfferingsAutomatically = loadsOfferingsAutomatically
        self.trackEvent = trackEvent
        self.signOffer = signOffer
        if start { self.start() }
    }

    deinit {
        tasks.current.forEach { $0.cancel() }
        observers.current.forEach { NotificationCenter.default.removeObserver($0) }
    }

    // MARK: Access

    /// Active entitlements by name (RevenueCat's `customerInfo.entitlements.active`).
    public var activeEntitlements: [String: EntitlementInfo] { customer.active }
    /// Product ids that currently give access.
    public var activeProductIds: Set<String> { customer.activeProductIds }
    /// Subscriptions the customer has or recently had, by product id.
    public var subscriptions: [String: SubscriptionDetails] { customer.subscriptions }

    /// The active entitlement with this name, or nil.
    public func entitlement(named name: String) -> EntitlementInfo? { customer.active[name] }

    /// Whether the entitlement with this name is active.
    public func isActive(_ entitlement: String) -> Bool { customer.active[entitlement] != nil }

    /// Whether any of these products currently gives access.
    public func isActive<S: Sequence>(productIds: S) -> Bool where S.Element == String {
        productIds.contains { customer.activeTransactions[$0] != nil }
    }

    /// The loaded product with this id.
    public func product(id: String) -> Product? { products.first { $0.id == id } }

    /// Subscription details (expiration, renewal, trial, grace period) for a product the customer has or had.
    public func subscription(for productId: String) -> SubscriptionDetails? { customer.subscriptions[productId] }

    /// The product's introductory offer (free trial or intro price) if the customer is eligible for it, otherwise
    /// nil. Uses the eligibility checked when the products loaded and after each purchase; never promise a trial
    /// when this is nil.
    public func eligibleIntroOffer(for product: Product) -> Product.SubscriptionOffer? {
        guard let offer = product.subscription?.introductoryOffer, introOfferEligibility[product.id] == true else { return nil }
        return offer
    }

    /// Asks StoreKit whether the customer can get the product's introductory offer.
    public func isEligibleForIntroOffer(_ product: Product) async -> Bool {
        guard let subscription = product.subscription, subscription.introductoryOffer != nil else { return false }
        return await subscription.isEligibleForIntroOffer
    }

    // MARK: Offerings

    /// The offering marked current in Revflare.
    public var currentOffering: RevflareOffering? { offerings?.current }

    /// The offering to show at a paywall location ("onboarding", "settings"...): the placement's offering, else the
    /// current one. Nil until ``offerings`` loaded.
    public func offering(forPlacement placement: String) -> RevflareOffering? {
        offerings?.offering(forPlacement: placement)
    }

    /// Loads (or refreshes) ``offerings`` and adds their products to ``products``. Errors land in ``offeringsError``;
    /// the previous offerings stay.
    ///
    /// Also applies the entitlements and non-renewing durations set in Revflare (``mapping``,
    /// ``nonRenewingDurations``), loads the products they refer to and recomputes the entitlements.
    public func loadOfferings(fetchPolicy: OfferingsFetchPolicy = .cachedOrFetched) async {
        await loadOfferings(fetchPolicy: fetchPolicy, automatic: false)
    }

    private func loadOfferings(fetchPolicy: OfferingsFetchPolicy, automatic: Bool) async {
        isLoadingOfferings = true
        defer { isLoadingOfferings = false }
        do {
            let loaded = try await offeringsLoader(fetchPolicy)
            offeringsError = nil
            if loaded != offerings { offerings = loaded }
            await addProducts(loaded.ordered.flatMap(\.packages).map(\.product))
            await applyServerEntitlements(ServerEntitlements(entitlements: loaded.entitlements,
                                                             durations: loaded.nonRenewingDurations))
        } catch RevflareOfferingsError.notConfigured where automatic && !reportsMissingConfiguration {
            Log.debug("RevflareStore: no SDK key, offerings and server entitlements skipped")
        } catch {
            offeringsError = error.localizedDescription
            Log.debug("RevflareStore: offerings failed to load: \(error)")
        }
    }

    /// Reads the entitlements and durations set in Revflare (one request, cached and shared with the offerings; the
    /// offerings' products are not loaded) and applies them. Errors are only logged: the saved copy keeps applying.
    func syncServerEntitlements(fetchPolicy: OfferingsFetchPolicy = .cachedOrFetched) async {
        do {
            await applyServerEntitlements(try await serverEntitlementsLoader(fetchPolicy))
        } catch RevflareOfferingsError.notConfigured where !reportsMissingConfiguration {
            Log.debug("RevflareStore: no SDK key, server entitlements skipped")
        } catch {
            Log.debug("RevflareStore: server entitlements failed to load: \(error)")
        }
    }

    /// Merges the entitlements and durations set in Revflare with the app's own, keeps them on the device, loads the
    /// products they refer to and recomputes the entitlements when anything changed.
    func applyServerEntitlements(_ server: ServerEntitlements) async {
        if server != serverEntitlements {
            serverEntitlements = server
            server.save(to: persistence, key: serverEntitlementsKey())
        }
        let merged = NonRenewingRules.mergedMapping(local: localMapping, server: server.entitlements)
        let durations = NonRenewingRules.mergedDurations(local: localNonRenewingDurations, server: server.durations,
                                                         declared: declaredProductIds)
        let changed = merged != mapping || durations != nonRenewingDurations
        if merged != mapping { mapping = merged }
        if durations != nonRenewingDurations { nonRenewingDurations = durations }
        // Ids already in productIds are loaded by loadProducts(); only new ones are asked here.
        let listed = Set(productIds)
        let ids = Self.merge(productIds, adding: server.productIds)
        if ids != productIds { productIds = ids }
        let known = Set(products.map(\.id))
        let missing = server.productIds.filter {
            !listed.contains($0) && !known.contains($0) && !requestedServerProductIds.contains($0)
        }
        if !missing.isEmpty {
            requestedServerProductIds.formUnion(missing)
            do {
                let loaded = try await productLoader(missing)
                // addProducts refreshes when something new arrived.
                if !loaded.isEmpty {
                    await addProducts(loaded)
                    return
                }
            } catch {
                requestedServerProductIds.subtract(missing)
                Log.debug("RevflareStore: products of the server entitlements failed to load: \(error)")
            }
        }
        if changed { await refresh() }
    }

    /// Adds products (already loaded by the offerings) to ``productIds`` / ``products``.
    private func addProducts(_ added: [Product]) async {
        let ids = Self.merge(productIds, adding: added.map(\.id))
        let known = Set(products.map(\.id))
        var seen = Set<String>()
        let new = added.filter { !known.contains($0.id) && seen.insert($0.id).inserted }
        guard ids != productIds || !new.isEmpty else { return }
        productIds = ids
        guard !new.isEmpty else { return }
        let order = Dictionary(uniqueKeysWithValues: ids.enumerated().map { ($1, $0) })
        products = (products + new).sorted { (order[$0.id] ?? .max) < (order[$1.id] ?? .max) }
        await updateIntroEligibility()
        await refresh()
    }

    /// `existing` followed by the ids of `adding` it lacks, in order, without duplicates.
    nonisolated static func merge(_ existing: [String], adding: [String]) -> [String] {
        var seen = Set(existing)
        return existing + adding.filter { seen.insert($0).inserted }
    }

    // MARK: Loading

    /// Loads (or reloads) ``products``.
    public func loadProducts() async {
        isLoadingProducts = true
        defer { isLoadingProducts = false }
        do {
            let loaded = try await productLoader(productIds)
            let order = Dictionary(uniqueKeysWithValues: productIds.enumerated().map { ($1, $0) })
            products = loaded.sorted { (order[$0.id] ?? .max) < (order[$1.id] ?? .max) }
            productsError = nil
            let missing = Set(productIds).subtracting(loaded.map(\.id))
            if !missing.isEmpty { Log.error("RevflareStore: unknown product ids \(missing.sorted())") }
            await updateIntroEligibility()
            // Product groups are now known: statuses can include subscriptions in billing retry.
            await refresh()
        } catch {
            productsError = error.localizedDescription
            Log.debug("RevflareStore: products failed to load: \(error)")
        }
    }

    /// Re-reads the entitlements from StoreKit (local, no network, no sign-in prompt).
    public func refresh() async {
        refreshGeneration += 1
        let generation = refreshGeneration
        let durations = nonRenewingDurations
        var transactions = await backend.currentEntitlements()
        if !durations.isEmpty {
            // currentEntitlements has the latest purchase of each pass only: stacking needs all of them.
            let history = await nonRenewingHistory(productIds: Set(durations.keys), current: transactions)
            transactions = CustomerEntitlements.unique(transactions + history)
        }
        var groups: [String: String] = [:]
        for transaction in transactions where transaction.kind == .autoRenewable {
            if let group = transaction.subscriptionGroupId, groups[group] == nil { groups[group] = transaction.productId }
        }
        for product in products {
            if let group = product.subscription?.subscriptionGroupID, groups[group] == nil { groups[group] = product.id }
        }
        let statuses = await backend.subscriptionStatuses(groups: groups)
        // A refresh that started later has fresher data: let it publish.
        guard generation == refreshGeneration else { return }
        let computed = CustomerEntitlements.compute(transactions: transactions, statuses: statuses, mapping: mapping,
                                                    durations: nonRenewingDurations, now: now())
        if computed != customer { customer = computed }
        if !hasLoadedEntitlements { hasLoadedEntitlements = true }
        scheduleExpiryRefresh()
    }

    /// The pass history that counts with `current` (the `Transaction.currentEntitlements` just read). Cached (see
    /// ``nonRenewingHistoryCache``); the cache is re-read when the latest current transaction of a pass product
    /// changed since it was loaded (a pass bought on another device, a deleted or refunded transaction whose
    /// `Transaction.updates` event never reached the app, Xcode's "Delete transactions"...).
    private func nonRenewingHistory(productIds: Set<String>, current: [RevflareTransaction]) async -> [RevflareTransaction] {
        let anchors = PassHistoryRules.anchors(productIds: productIds, current: current)
        if let cache = nonRenewingHistoryCache, cache.productIds == productIds, cache.anchors == anchors {
            return PassHistoryRules.counted(cache.transactions, anchors: anchors)
        }
        let generation = nonRenewingHistoryGeneration
        let loaded = await backend.nonRenewingHistory(productIds: productIds).filter { $0.revocationDate == nil }
        // A transaction that arrived meanwhile invalidated it: don't keep a copy that may lack it.
        if generation == nonRenewingHistoryGeneration {
            nonRenewingHistoryCache = PassHistoryCache(productIds: productIds, anchors: anchors, transactions: loaded)
        }
        return PassHistoryRules.counted(loaded, anchors: anchors)
    }

    /// Forgets the cached transaction history (new transaction, purchase, restore).
    private func invalidateTransactionHistory() {
        purchasedGroupsCache = nil
        nonRenewingHistoryCache = nil
        nonRenewingHistoryGeneration += 1
    }

    // MARK: Purchasing

    /// Buys a product.
    ///
    /// - Parameters:
    ///   - placement: The paywall location the purchase starts from ("onboarding", "settings"...), sent with the
    ///     purchase funnel events.
    ///   - appAccountToken: Sent with the purchase; defaults to ``Revflare/installId`` (links the purchase to this
    ///     install's Apple Ads campaign). Pass the app's own user id if it has one.
    ///   - options: Extra purchase options (quantity, promotional offer...). Do not add an `appAccountToken` here.
    /// - Returns: `.purchased` (verified, finished, already in ``activeEntitlements``), `.userCancelled` or
    ///   `.pending`.
    /// - Throws: StoreKit errors (network, not allowed...) and ``RevflareStoreError/failedVerification(_:)``.
    @discardableResult
    public func purchase(_ product: Product, placement: String? = nil, appAccountToken: UUID? = nil,
                         options: Set<Product.PurchaseOption> = []) async throws -> PurchaseOutcome {
        try await buy(product, context: PurchaseEventContext(productId: product.id, placement: placement),
                      appAccountToken: appAccountToken, options: options)
    }

    /// Buys a package of an offering (its ``RevflarePackage/product``). Same options and outcome as
    /// ``purchase(_:placement:appAccountToken:options:)``; the purchase events also carry the offering and the
    /// package.
    @discardableResult
    public func purchase(_ package: RevflarePackage, placement: String? = nil, appAccountToken: UUID? = nil,
                         options: Set<Product.PurchaseOption> = []) async throws -> PurchaseOutcome {
        let context = PurchaseEventContext(productId: package.product.id, offering: package.offeringIdentifier,
                                           package: package.identifier, placement: placement)
        return try await buy(package.product, context: context, appAccountToken: appAccountToken, options: options)
    }

    private func buy(_ product: Product, context: PurchaseEventContext, appAccountToken: UUID?,
                     options: Set<Product.PurchaseOption>) async throws -> PurchaseOutcome {
        var all = options
        all.insert(.appAccountToken(appAccountToken ?? Revflare.installId))
        let purchaseOptions = all
        return try await purchase(productId: product.id, context: context) {
            PurchaseAttempt(try await product.purchase(options: purchaseOptions))
        }
    }

    /// The purchase flow, with the StoreKit call injected (tests).
    func purchase(productId: String, context: PurchaseEventContext? = nil,
                  attempt: () async throws -> PurchaseAttempt) async throws -> PurchaseOutcome {
        let properties = (context ?? PurchaseEventContext(productId: productId)).properties
        isPurchasing = true
        defer { isPurchasing = false }
        Log.debug("RevflareStore: buying \(productId)")
        trackEvent("purchase_start", properties)
        let result: PurchaseAttempt
        do {
            result = try await attempt()
        } catch {
            let code = PurchaseEventContext.errorCode(error)
            if code == "user_cancelled" {
                trackEvent("purchase_cancel", properties)
            } else {
                trackEvent("purchase_failed", properties.merging(["error": code]) { _, new in new })
            }
            throw error
        }
        switch result {
        case .userCancelled:
            trackEvent("purchase_cancel", properties)
            return .userCancelled
        case .pending:
            trackEvent("purchase_pending", properties)
            return .pending
        case .completed(let event):
            guard let transaction = event.transaction else {
                trackEvent("purchase_failed", properties.merging(["error": "failed_verification"]) { _, new in new })
                throw RevflareStoreError.failedVerification(event.verificationError ?? "unverified transaction")
            }
            await event.finish()
            invalidateTransactionHistory()
            await refresh()
            await updateIntroEligibility()
            linkPurchases()
            trackEvent("purchase_success", properties)
            return .purchased(transaction)
        }
    }

    // MARK: Promotional and win-back offers

    /// Buys a subscription with a promotional offer set up in App Store Connect. The Revflare server signs the offer
    /// first (background request, at most 10 s; the offer must be in the app's allowlist: Revflare web → the app →
    /// Offers, and the server needs the app's In-App Purchase key).
    ///
    /// Promotional offers are only for customers who have or had a subscription in the product's group: list the
    /// ones to show with ``promotionalOffers(for:)``. Events carry `offer` and `offer_type` = `promotional`.
    ///
    /// - Parameters:
    ///   - offerID: The promotional offer's identifier in App Store Connect.
    ///   - appAccountToken: Defaults to ``Revflare/installId``; the signature covers it and the purchase sends the same.
    /// - Throws: ``RevflareOfferError`` (signing), StoreKit errors (`Product.PurchaseError.ineligibleForOffer`...)
    ///   and ``RevflareStoreError/failedVerification(_:)``.
    @discardableResult
    public func purchase(_ product: Product, promotionalOffer offerID: String, placement: String? = nil,
                         appAccountToken: UUID? = nil) async throws -> PurchaseOutcome {
        let context = PurchaseEventContext(productId: product.id, placement: placement, offer: offerID,
                                           offerType: PurchaseOfferType.promotional.rawValue)
        return try await purchasePromotional(productId: product.id, offerID: offerID, context: context,
                                             appAccountToken: appAccountToken ?? Revflare.installId) { options in
            PurchaseAttempt(try await product.purchase(options: options))
        }
    }

    /// Buys a package with a promotional offer (see ``purchase(_:promotionalOffer:placement:appAccountToken:)``);
    /// the events also carry the offering and the package.
    @discardableResult
    public func purchase(_ package: RevflarePackage, promotionalOffer offerID: String, placement: String? = nil,
                         appAccountToken: UUID? = nil) async throws -> PurchaseOutcome {
        let product = package.product
        let context = PurchaseEventContext(productId: product.id, offering: package.offeringIdentifier,
                                           package: package.identifier, placement: placement, offer: offerID,
                                           offerType: PurchaseOfferType.promotional.rawValue)
        return try await purchasePromotional(productId: product.id, offerID: offerID, context: context,
                                             appAccountToken: appAccountToken ?? Revflare.installId) { options in
            PurchaseAttempt(try await product.purchase(options: options))
        }
    }

    /// The promotional offer flow, with the StoreKit call injected (tests): sign, build the options (same
    /// `appAccountToken` as signed), buy.
    func purchasePromotional(productId: String, offerID: String, context: PurchaseEventContext, appAccountToken: UUID,
                             encoding: PromotionalOfferEncoding = .preferred,
                             attempt: (Set<Product.PurchaseOption>) async throws -> PurchaseAttempt) async throws -> PurchaseOutcome {
        let sign = signOffer
        return try await purchase(productId: productId, context: context) {
            var signature = try await sign(productId, offerID, appAccountToken)
            signature.appAccountToken = appAccountToken
            return try await attempt(try signature.purchaseOptions(encoding: encoding))
        }
    }

    /// The product's promotional offers if the customer can get them (has or had a subscription in the product's
    /// group, per `Transaction.all` and the group's statuses), else empty. Local, no network.
    public func promotionalOffers(for product: Product) async -> [Product.SubscriptionOffer] {
        guard let subscription = product.subscription, !subscription.promotionalOffers.isEmpty else { return [] }
        guard await hasSubscriptionHistory(groupId: subscription.subscriptionGroupID, productId: product.id) else { return [] }
        return subscription.promotionalOffers
    }

    /// Whether the customer has or had a subscription in the group (promotional offer eligibility).
    func hasSubscriptionHistory(groupId: String, productId: String) async -> Bool {
        if OfferEligibility.hasSubscriptionHistory(groupId: groupId, purchasedGroups: [], statuses: [], customer: customer) {
            return true
        }
        let purchased: Set<String>
        if let cached = purchasedGroupsCache {
            purchased = cached
        } else {
            purchased = await backend.purchasedSubscriptionGroups()
            purchasedGroupsCache = purchased
        }
        let statuses = await backend.subscriptionStatuses(groups: [groupId: productId])
        return OfferEligibility.hasSubscriptionHistory(groupId: groupId, purchasedGroups: purchased, statuses: statuses,
                                                       customer: customer)
    }

    /// The product's win-back offers the customer can redeem now (`renewalInfo.eligibleWinBackOfferIDs` of the
    /// group, matched to `product.subscription.winBackOffers`), best first; empty when none. Win-back offers need no
    /// signature.
    @available(iOS 18.0, macOS 15.0, tvOS 18.0, watchOS 11.0, *)
    public func winBackOffers(for product: Product) async -> [Product.SubscriptionOffer] {
        guard let subscription = product.subscription, !subscription.winBackOffers.isEmpty else { return [] }
        let eligible = await eligibleWinBackOfferIds(groupId: subscription.subscriptionGroupID, productId: product.id)
        return OfferEligibility.matching(subscription.winBackOffers, eligibleIds: eligible, id: \.id)
    }

    /// The win-back offer ids StoreKit says the customer can redeem in the group.
    func eligibleWinBackOfferIds(groupId: String, productId: String) async -> [String] {
        let statuses = await backend.subscriptionStatuses(groups: [groupId: productId])
        return OfferEligibility.eligibleWinBackOfferIds(groupId: groupId, statuses: statuses)
    }

    /// Buys a subscription with a win-back offer (from ``winBackOffers(for:)``). Events carry `offer` and
    /// `offer_type` = `win_back`. Redemptions made from the App Store (Streamlined Purchasing) arrive through
    /// `Transaction.updates`, which the store already handles.
    @available(iOS 18.0, macOS 15.0, tvOS 18.0, watchOS 11.0, *)
    @discardableResult
    public func purchase(_ product: Product, winBackOffer offer: Product.SubscriptionOffer, placement: String? = nil,
                         appAccountToken: UUID? = nil) async throws -> PurchaseOutcome {
        let context = PurchaseEventContext(productId: product.id, placement: placement, offer: offer.id,
                                           offerType: PurchaseOfferType.winBack.rawValue)
        return try await buy(product, context: context, appAccountToken: appAccountToken, options: [.winBackOffer(offer)])
    }

    /// Buys a package with a win-back offer (see ``purchase(_:winBackOffer:placement:appAccountToken:)``).
    @available(iOS 18.0, macOS 15.0, tvOS 18.0, watchOS 11.0, *)
    @discardableResult
    public func purchase(_ package: RevflarePackage, winBackOffer offer: Product.SubscriptionOffer, placement: String? = nil,
                         appAccountToken: UUID? = nil) async throws -> PurchaseOutcome {
        let context = PurchaseEventContext(productId: package.product.id, offering: package.offeringIdentifier,
                                           package: package.identifier, placement: placement, offer: offer.id,
                                           offerType: PurchaseOfferType.winBack.rawValue)
        return try await buy(package.product, context: context, appAccountToken: appAccountToken,
                             options: [.winBackOffer(offer)])
    }

    /// The customer's most recently expired subscription in the group when they have no access in it and are not in
    /// a billing grace period or billing retry (target those with "update your payment method", not a discount).
    /// Groups are known once the store loaded their products.
    public func lapsedSubscription(groupID: String) -> SubscriptionDetails? {
        customer.lapsedSubscription(groupID: groupID)
    }

    /// Whether the entitlement lapsed: not active, granted before by a subscription that expired, and no billing grace
    /// period / retry in progress. The audience for win-back and promotional offers.
    public func isLapsed(entitlement: String) -> Bool {
        customer.isLapsed(entitlement: entitlement, mapping: mapping)
    }

    /// Restores purchases: `AppStore.sync()` (may ask the user to sign in), then refreshes. Only call it from a
    /// "Restore Purchases" button; entitlements are otherwise always current without it.
    ///
    /// - Returns: The customer's access after the restore.
    @discardableResult
    public func restore() async throws -> CustomerEntitlements {
        isPurchasing = true
        defer { isPurchasing = false }
        trackEvent("restore_start", [:])
        do {
            try await backend.syncWithAppStore()
            invalidateTransactionHistory()
        } catch {
            trackEvent("restore_failed", ["error": PurchaseEventContext.errorCode(error)])
            throw error
        }
        await refresh()
        await updateIntroEligibility()
        linkPurchases()
        trackEvent("restore_success", ["entitlements": customer.active.keys.sorted().joined(separator: ",")])
        return customer
    }

    // MARK: Transactions

    private func start() {
        let stream = backend.transactionUpdates()
        let backend = self.backend
        let listener = Task { [weak self] in
            for await event in stream {
                guard let self else { return }
                await self.handle(event)
            }
        }
        let initial = Task { [weak self] in
            // Transactions left unfinished by a previous run (crash, purchase while the app was killed...).
            for event in await backend.unfinishedTransactions() {
                guard let self else { return }
                await self.handle(event, refresh: false)
            }
            await self?.refresh()
            await self?.loadProducts()
            if self?.loadsOfferingsAutomatically == true {
                await self?.loadOfferings(fetchPolicy: .cachedOrFetched, automatic: true)
            } else if self?.syncsServerEntitlements == true {
                await self?.syncServerEntitlements()
            }
        }
        tasks.withLock { $0 = [listener, initial] }
        if let name = Revflare.foregroundNotification {
            let observer = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    await self?.refresh()
                    // Cheap when fresh (no request under 5 minutes, then a 304 when unchanged).
                    guard let self else { return }
                    if self.loadsOfferingsAutomatically || self.offerings != nil {
                        await self.loadOfferings(fetchPolicy: .cachedOrFetched, automatic: true)
                    } else if self.syncsServerEntitlements {
                        await self.syncServerEntitlements()
                    }
                }
            }
            observers.withLock { $0.append(observer) }
        }
    }

    func handle(_ event: TransactionEvent, refresh shouldRefresh: Bool = true) async {
        guard let transaction = event.transaction else { return }
        Log.debug("RevflareStore: transaction \(transaction.id) (\(transaction.productId)) finished")
        await event.finish()
        invalidateTransactionHistory()
        if shouldRefresh {
            await refresh()
            await updateIntroEligibility()
        }
        linkPurchases()
    }

    private func updateIntroEligibility() async {
        var eligibility: [String: Bool] = [:]
        for product in products {
            guard let subscription = product.subscription, subscription.introductoryOffer != nil else { continue }
            eligibility[product.id] = await subscription.isEligibleForIntroOffer
        }
        if eligibility != introOfferEligibility { introOfferEligibility = eligibility }
    }

    /// Refreshes when the next subscription or pass expires, so access ends on time while the app stays open (and on
    /// foreground).
    private func scheduleExpiryRefresh() {
        expiryTask?.cancel()
        let current = now()
        let dates = customer.activeTransactions.values.compactMap(\.expirationDate)
            + customer.subscriptions.values.compactMap { $0.isInGracePeriod ? $0.gracePeriodExpirationDate : nil }
        guard let next = dates.filter({ $0 > current }).min() else { return }
        let delay = min(next.timeIntervalSince(current) + 1, 24 * 3600)
        let sleep = self.sleep
        expiryTask = Task { [weak self] in
            await sleep(delay)
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }
}

/// What the purchase funnel events carry.
struct PurchaseEventContext: Sendable, Equatable {
    var productId: String
    var offering: String?
    var package: String?
    var placement: String?
    /// The subscription offer redeemed (promotional / win-back offer id).
    var offer: String? = nil
    /// `promotional` or `win_back` (``PurchaseOfferType``).
    var offerType: String? = nil

    var properties: [String: String] {
        var properties = ["product": productId]
        if let offering, !offering.isEmpty { properties["offering"] = offering }
        if let package, !package.isEmpty { properties["package"] = package }
        if let placement, !placement.isEmpty { properties["placement"] = placement }
        if let offer, !offer.isEmpty { properties["offer"] = offer }
        if let offerType, !offerType.isEmpty { properties["offer_type"] = offerType }
        return properties
    }

    /// A short, stable code for `purchase_failed` / `restore_failed` (`network_error`, `purchase_not_allowed`,
    /// `NSURLErrorDomain:-1009`...).
    static func errorCode(_ error: Error) -> String {
        if error is RevflareStoreError { return "failed_verification" }
        if let error = error as? RevflareOfferError {
            switch error {
            case .sdkNotConfigured: return "offer_sdk_not_configured"
            case .notAllowed: return "offer_not_allowed"
            case .notConfigured: return "offer_not_configured"
            case .unknownSDKKey: return "offer_unknown_sdk_key"
            case .rateLimited: return "offer_rate_limited"
            case .network: return "offer_network_error"
            case .server: return "offer_server_error"
            case .invalidResponse: return "offer_invalid_response"
            }
        }
        if let error = error as? StoreKitError {
            switch error {
            case .userCancelled: return "user_cancelled"
            case .networkError: return "network_error"
            case .systemError: return "system_error"
            case .notAvailableInStorefront: return "not_available_in_storefront"
            case .notEntitled: return "not_entitled"
            case .unknown: return "unknown"
            default: return "storekit_error"
            }
        }
        if let error = error as? Product.PurchaseError {
            switch error {
            case .invalidQuantity: return "invalid_quantity"
            case .productUnavailable: return "product_unavailable"
            case .purchaseNotAllowed: return "purchase_not_allowed"
            case .ineligibleForOffer: return "ineligible_for_offer"
            case .invalidOfferIdentifier: return "invalid_offer_identifier"
            case .invalidOfferPrice: return "invalid_offer_price"
            case .invalidOfferSignature: return "invalid_offer_signature"
            case .missingOfferParameters: return "missing_offer_parameters"
            default: return "purchase_error"
            }
        }
        let nsError = error as NSError
        return "\(nsError.domain):\(nsError.code)"
    }
}

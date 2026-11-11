import Foundation

/// A verified StoreKit transaction, reduced to what entitlement decisions need (plain values, so the logic can be
/// tested without the App Store).
public struct RevflareTransaction: Sendable, Equatable, Hashable {
    public enum ProductKind: String, Sendable, Hashable {
        case autoRenewable, nonRenewable, nonConsumable, consumable
    }

    public enum Ownership: String, Sendable, Hashable {
        /// Bought by this Apple Account.
        case purchased
        /// Shared through Family Sharing by the family member who bought it.
        case familyShared
    }

    public enum OfferKind: String, Sendable, Hashable {
        case introductory, promotional, code, winBack, other
    }

    public var id: UInt64
    public var originalId: UInt64
    public var productId: String
    public var kind: ProductKind
    public var subscriptionGroupId: String?
    public var purchaseDate: Date
    public var originalPurchaseDate: Date
    /// Nil for purchases that do not expire.
    public var expirationDate: Date?
    public var revocationDate: Date?
    /// The subscription was replaced by a higher level one in the same group.
    public var isUpgraded: Bool
    public var ownership: Ownership
    /// The offer the customer is in for this period (an introductory offer is a trial or an intro price).
    public var offer: OfferKind?
    /// True when the offer is a free trial.
    public var isFreeTrial: Bool
    public var appAccountToken: UUID?

    public init(id: UInt64, originalId: UInt64? = nil, productId: String, kind: ProductKind,
                subscriptionGroupId: String? = nil, purchaseDate: Date, originalPurchaseDate: Date? = nil,
                expirationDate: Date? = nil, revocationDate: Date? = nil, isUpgraded: Bool = false,
                ownership: Ownership = .purchased, offer: OfferKind? = nil, isFreeTrial: Bool = false,
                appAccountToken: UUID? = nil) {
        self.id = id
        self.originalId = originalId ?? id
        self.productId = productId
        self.kind = kind
        self.subscriptionGroupId = subscriptionGroupId
        self.purchaseDate = purchaseDate
        self.originalPurchaseDate = originalPurchaseDate ?? purchaseDate
        self.expirationDate = expirationDate
        self.revocationDate = revocationDate
        self.isUpgraded = isUpgraded
        self.ownership = ownership
        self.offer = offer
        self.isFreeTrial = isFreeTrial
        self.appAccountToken = appAccountToken
    }
}

/// Renewal state of a subscription (mirrors `Product.SubscriptionInfo.RenewalState`).
public enum SubscriptionRenewalState: String, Sendable, Hashable {
    case subscribed
    case expired
    /// The renewal failed and Apple keeps retrying; access is not granted (unless in a grace period).
    case inBillingRetryPeriod
    /// The renewal failed but the developer enabled a billing grace period: access continues.
    case inGracePeriod
    case revoked
    case unknown
}

/// One entry of `Product.SubscriptionInfo.Status` (the latest transaction of a subscription and its renewal info).
public struct SubscriptionStatusRecord: Sendable, Equatable {
    public var state: SubscriptionRenewalState
    public var transaction: RevflareTransaction
    public var willAutoRenew: Bool
    /// The product the subscription renews to (differs from the current one after a crossgrade / downgrade).
    public var autoRenewProductId: String?
    public var gracePeriodExpirationDate: Date?
    /// Next renewal date (iOS 17+); otherwise the transaction's expiration date is used.
    public var renewalDate: Date?
    /// Win-back offers StoreKit says the customer can redeem (`renewalInfo.eligibleWinBackOfferIDs`, iOS 18+), best
    /// first.
    public var eligibleWinBackOfferIds: [String]

    public init(state: SubscriptionRenewalState, transaction: RevflareTransaction, willAutoRenew: Bool,
                autoRenewProductId: String? = nil, gracePeriodExpirationDate: Date? = nil, renewalDate: Date? = nil,
                eligibleWinBackOfferIds: [String] = []) {
        self.state = state
        self.transaction = transaction
        self.willAutoRenew = willAutoRenew
        self.autoRenewProductId = autoRenewProductId
        self.gracePeriodExpirationDate = gracePeriodExpirationDate
        self.renewalDate = renewalDate
        self.eligibleWinBackOfferIds = eligibleWinBackOfferIds
    }
}

/// What the UI needs about a subscription product the customer has (or recently had).
public struct SubscriptionDetails: Sendable, Equatable {
    public var productId: String
    public var subscriptionGroupId: String?
    public var state: SubscriptionRenewalState
    /// Gives access right now (subscribed, or in a billing grace period).
    public var isActive: Bool
    public var expirationDate: Date?
    public var renewalDate: Date?
    public var willAutoRenew: Bool
    public var autoRenewProductId: String?
    /// In an introductory offer (free trial or intro price) this period.
    public var isInIntroOffer: Bool
    public var isInFreeTrial: Bool
    public var isInGracePeriod: Bool
    public var isInBillingRetry: Bool
    public var gracePeriodExpirationDate: Date?
    public var purchaseDate: Date
    public var originalPurchaseDate: Date
    public var ownership: RevflareTransaction.Ownership
}

/// An active entitlement (like RevenueCat's `EntitlementInfo`).
public struct EntitlementInfo: Sendable, Equatable {
    public enum PeriodType: String, Sendable, Hashable {
        case normal, intro, trial
    }

    /// The entitlement name from the mapping, e.g. `"pro"`.
    public var identifier: String
    /// The product that grants it (the one that lasts longest when several do).
    public var productId: String
    /// Nil for purchases that never expire (lifetime). For a non-renewing product with a duration (a pass): the end of
    /// the pass, stacked repeat purchases included.
    public var expirationDate: Date?
    public var willRenew: Bool
    public var periodType: PeriodType
    public var isInGracePeriod: Bool
    public var ownership: RevflareTransaction.Ownership
    public var latestPurchaseDate: Date
    public var originalPurchaseDate: Date
    public var transaction: RevflareTransaction

    /// No expiration: a non-consumable (lifetime) purchase, or a non-renewing one without a duration. False for a pass
    /// with a duration (``NonRenewingDuration``).
    public var isLifetime: Bool { expirationDate == nil }
}

/// Which product ids grant which entitlement (like RevenueCat entitlements). A product can grant several.
public struct EntitlementMapping: Sendable, Equatable {
    /// Entitlement name → product ids.
    public var entitlements: [String: Set<String>]

    public init(_ entitlements: [String: Set<String>] = [:]) {
        self.entitlements = entitlements
    }

    public init(_ entitlements: [String: [String]]) {
        self.entitlements = entitlements.mapValues(Set.init)
    }

    /// Entitlement names a product grants.
    public func entitlements(for productId: String) -> Set<String> {
        Set(entitlements.compactMap { $0.value.contains(productId) ? $0.key : nil })
    }

    public var allProductIds: Set<String> { entitlements.values.reduce(into: Set()) { $0.formUnion($1) } }
}

/// The customer's access, computed from StoreKit's current entitlements and subscription statuses.
public struct CustomerEntitlements: Sendable, Equatable {
    /// Active entitlements by name.
    public var active: [String: EntitlementInfo] = [:]
    /// Product ids that currently give access, with the transaction that grants each.
    public var activeTransactions: [String: RevflareTransaction] = [:]
    /// Subscriptions the customer has or recently had (active, in billing retry, expired with a known status), by
    /// product id.
    public var subscriptions: [String: SubscriptionDetails] = [:]

    public var activeProductIds: Set<String> { Set(activeTransactions.keys) }

    public init() {}

    /// Computes access. Pure: `transactions` are the verified `Transaction.currentEntitlements`, `statuses` the
    /// verified `Product.SubscriptionInfo.Status` entries of the app's subscription groups.
    ///
    /// Rules:
    /// - revoked (refunded) and upgraded transactions never give access; consumables never do;
    /// - non-consumables give access for ever (durations never apply to them); non-renewing products too, unless they
    ///   have a duration (`durations`): then until purchase + duration, repeat purchases stacking
    ///   (``NonRenewingRules``); refunded passes never;
    /// - subscriptions give access until they expire, or while the status says `inGracePeriod` (billing grace
    ///   period), even after the expiration date; a status of `expired`, `revoked` or `inBillingRetryPeriod` wins
    ///   over a stale transaction;
    /// - family-shared purchases count like the customer's own.
    public static func compute(transactions: [RevflareTransaction], statuses: [SubscriptionStatusRecord],
                               mapping: EntitlementMapping, durations: [String: NonRenewingDuration] = [:],
                               now: Date) -> CustomerEntitlements {
        var result = CustomerEntitlements()
        let transactions = NonRenewingRules.applyingDurations(durations, to: transactions)

        // The newest status per original transaction (Family Sharing can give one per ownership).
        var statusByOriginal: [UInt64: SubscriptionStatusRecord] = [:]
        for status in statuses {
            let key = status.transaction.originalId
            if let existing = statusByOriginal[key], existing.transaction.purchaseDate > status.transaction.purchaseDate {
                continue
            }
            statusByOriginal[key] = status
        }

        func gracePeriodActive(_ status: SubscriptionStatusRecord) -> Bool {
            guard status.state == .inGracePeriod else { return false }
            if let end = status.gracePeriodExpirationDate { return end > now }
            return true
        }

        func givesAccess(_ transaction: RevflareTransaction) -> Bool {
            guard transaction.revocationDate == nil, !transaction.isUpgraded else { return false }
            switch transaction.kind {
            case .consumable:
                return false
            case .nonConsumable:
                // Lifetime, always: durations never apply to non-consumables.
                return true
            case .nonRenewable:
                return transaction.expirationDate.map { $0 > now } ?? true
            case .autoRenewable:
                if let status = statusByOriginal[transaction.originalId] {
                    switch status.state {
                    case .expired, .revoked, .inBillingRetryPeriod: return false
                    case .inGracePeriod: return gracePeriodActive(status)
                    case .subscribed, .unknown: break
                    }
                }
                return transaction.expirationDate.map { $0 > now } ?? true
            }
        }

        func better(_ a: RevflareTransaction, than b: RevflareTransaction) -> Bool {
            // Lasts longer wins; nil (never expires) beats any date.
            switch (a.expirationDate, b.expirationDate) {
            case (nil, nil): return a.purchaseDate > b.purchaseDate
            case (nil, _): return true
            case (_, nil): return false
            case let (x?, y?): return x != y ? x > y : a.purchaseDate > b.purchaseDate
            }
        }

        func add(_ transaction: RevflareTransaction) {
            if let existing = result.activeTransactions[transaction.productId], !better(transaction, than: existing) { return }
            result.activeTransactions[transaction.productId] = transaction
        }

        for transaction in transactions where givesAccess(transaction) { add(transaction) }
        // In a grace period StoreKit may already leave the subscription out of the current entitlements.
        for status in statusByOriginal.values where gracePeriodActive(status) && status.transaction.revocationDate == nil {
            add(status.transaction)
        }

        // Subscription details: every subscription with a status, plus active ones without a status.
        var subscriptionSources: [String: (RevflareTransaction, SubscriptionStatusRecord?)] = [:]
        for status in statusByOriginal.values {
            let productId = status.transaction.productId
            if let existing = subscriptionSources[productId], existing.0.purchaseDate > status.transaction.purchaseDate { continue }
            subscriptionSources[productId] = (status.transaction, status)
        }
        for transaction in result.activeTransactions.values where transaction.kind == .autoRenewable {
            if let existing = subscriptionSources[transaction.productId], existing.1 != nil,
               existing.0.originalId == transaction.originalId {
                continue
            }
            subscriptionSources[transaction.productId] = (transaction, statusByOriginal[transaction.originalId])
        }
        for (productId, source) in subscriptionSources {
            let (transaction, status) = source
            let active = result.activeTransactions[productId]?.originalId == transaction.originalId
            let state = status?.state ?? (active ? .subscribed : .expired)
            result.subscriptions[productId] = SubscriptionDetails(
                productId: productId,
                subscriptionGroupId: transaction.subscriptionGroupId,
                state: state,
                isActive: active,
                expirationDate: transaction.expirationDate,
                renewalDate: status?.renewalDate ?? transaction.expirationDate,
                willAutoRenew: status?.willAutoRenew ?? active,
                autoRenewProductId: status?.autoRenewProductId,
                isInIntroOffer: transaction.offer == .introductory,
                isInFreeTrial: transaction.offer == .introductory && transaction.isFreeTrial,
                isInGracePeriod: state == .inGracePeriod,
                isInBillingRetry: state == .inBillingRetryPeriod || state == .inGracePeriod,
                gracePeriodExpirationDate: status?.gracePeriodExpirationDate,
                purchaseDate: transaction.purchaseDate,
                originalPurchaseDate: transaction.originalPurchaseDate,
                ownership: transaction.ownership
            )
        }

        // Entitlements: the best active product among the ones mapped to each name.
        for (name, productIds) in mapping.entitlements {
            let candidates = productIds.compactMap { result.activeTransactions[$0] }
            guard var best = candidates.first else { continue }
            for candidate in candidates.dropFirst() where better(candidate, than: best) { best = candidate }
            let details = result.subscriptions[best.productId]
            let period: EntitlementInfo.PeriodType = best.offer == .introductory ? (best.isFreeTrial ? .trial : .intro) : .normal
            result.active[name] = EntitlementInfo(
                identifier: name,
                productId: best.productId,
                expirationDate: best.kind == .nonConsumable ? nil : best.expirationDate,
                willRenew: best.kind == .autoRenewable ? (details?.willAutoRenew ?? true) : false,
                periodType: period,
                isInGracePeriod: details?.isInGracePeriod ?? false,
                ownership: best.ownership,
                latestPurchaseDate: best.purchaseDate,
                originalPurchaseDate: best.originalPurchaseDate,
                transaction: best
            )
        }
        return result
    }

    /// One entry per transaction id (the current entitlements and the pass history overlap).
    static func unique(_ transactions: [RevflareTransaction]) -> [RevflareTransaction] {
        var seen = Set<UInt64>()
        return transactions.filter { seen.insert($0.id).inserted }
    }
}

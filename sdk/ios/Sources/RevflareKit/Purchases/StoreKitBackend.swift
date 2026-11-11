import Foundation
import StoreKit

/// A transaction from `Transaction.updates` / `Transaction.unfinished`, or the result of a purchase.
struct TransactionEvent: Sendable {
    /// Nil when StoreKit could not verify the transaction (it is then left unfinished).
    var transaction: RevflareTransaction?
    var verificationError: String?
    /// Finishes the transaction in StoreKit.
    var finish: @Sendable () async -> Void
}

/// What a purchase attempt returned, before the store acts on it.
enum PurchaseAttempt: Sendable {
    case completed(TransactionEvent)
    case userCancelled
    case pending
}

/// The StoreKit operations the store needs (StoreKit 2 in the app, a fake in tests).
protocol PurchaseBackend: Sendable {
    /// Verified `Transaction.currentEntitlements`.
    func currentEntitlements() async -> [RevflareTransaction]
    /// Verified statuses of the given subscription groups. `groups` maps a group id to one product id of the group
    /// (needed before iOS 17 to look the status up through the product).
    func subscriptionStatuses(groups: [String: String]) async -> [SubscriptionStatusRecord]
    /// `Transaction.updates`, for the lifetime of the store.
    func transactionUpdates() -> AsyncStream<TransactionEvent>
    /// `Transaction.unfinished`.
    func unfinishedTransactions() async -> [TransactionEvent]
    /// `AppStore.sync()`: may ask the user to sign in.
    func syncWithAppStore() async throws
    /// Subscription groups the customer bought in (verified `Transaction.all`, own purchases, also expired ones).
    func purchasedSubscriptionGroups() async -> Set<String>
    /// Every verified non-renewing transaction of these products (`Transaction.all`, refunded ones included):
    /// `Transaction.currentEntitlements` only has the latest one of each, passes stack over all of them.
    /// Non-consumables are never included (always lifetime).
    func nonRenewingHistory(productIds: Set<String>) async -> [RevflareTransaction]
}

extension PurchaseBackend {
    func nonRenewingHistory(productIds: Set<String>) async -> [RevflareTransaction] { [] }
}

struct StoreKitPurchaseBackend: PurchaseBackend {
    func currentEntitlements() async -> [RevflareTransaction] {
        var result: [RevflareTransaction] = []
        for await verification in Transaction.currentEntitlements {
            if case .verified(let transaction) = verification {
                TransactionEnvironmentRecorder.record(transaction)
                result.append(RevflareTransaction(transaction))
            }
        }
        return result
    }

    func subscriptionStatuses(groups: [String: String]) async -> [SubscriptionStatusRecord] {
        var result: [SubscriptionStatusRecord] = []
        for (groupId, productId) in groups {
            let statuses: [Product.SubscriptionInfo.Status]
            do {
                if #available(iOS 17.0, macOS 14.0, tvOS 17.0, watchOS 10.0, *) {
                    statuses = try await Product.SubscriptionInfo.status(for: groupId)
                } else {
                    statuses = try await Product.products(for: [productId]).first?.subscription?.status ?? []
                }
            } catch {
                Log.debug("Subscription status of group \(groupId) unavailable: \(error)")
                continue
            }
            for status in statuses {
                guard case .verified(let transaction) = status.transaction else { continue }
                var renewal: Product.SubscriptionInfo.RenewalInfo?
                if case .verified(let info) = status.renewalInfo { renewal = info }
                var renewalDate: Date?
                if #available(iOS 17.0, macOS 14.0, tvOS 17.0, watchOS 10.0, *) { renewalDate = renewal?.renewalDate }
                var winBackOfferIds: [String] = []
                if #available(iOS 18.0, macOS 15.0, tvOS 18.0, watchOS 11.0, *) {
                    winBackOfferIds = renewal?.eligibleWinBackOfferIDs ?? []
                }
                result.append(SubscriptionStatusRecord(
                    state: SubscriptionRenewalState(status.state),
                    transaction: RevflareTransaction(transaction),
                    willAutoRenew: renewal?.willAutoRenew ?? false,
                    autoRenewProductId: renewal?.autoRenewPreference,
                    gracePeriodExpirationDate: renewal?.gracePeriodExpirationDate,
                    renewalDate: renewalDate,
                    eligibleWinBackOfferIds: winBackOfferIds
                ))
            }
        }
        return result
    }

    func transactionUpdates() -> AsyncStream<TransactionEvent> {
        AsyncStream { continuation in
            let task = Task.detached(priority: .utility) {
                for await verification in Transaction.updates {
                    continuation.yield(TransactionEvent(verification))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func unfinishedTransactions() async -> [TransactionEvent] {
        var result: [TransactionEvent] = []
        for await verification in Transaction.unfinished { result.append(TransactionEvent(verification)) }
        return result
    }

    func syncWithAppStore() async throws {
        try await AppStore.sync()
    }

    func purchasedSubscriptionGroups() async -> Set<String> {
        var groups = Set<String>()
        for await verification in Transaction.all {
            guard case .verified(let transaction) = verification, transaction.productType == .autoRenewable,
                  transaction.ownershipType == .purchased, let group = transaction.subscriptionGroupID else { continue }
            groups.insert(group)
        }
        return groups
    }

    func nonRenewingHistory(productIds: Set<String>) async -> [RevflareTransaction] {
        guard !productIds.isEmpty else { return [] }
        var result: [RevflareTransaction] = []
        for await verification in Transaction.all {
            guard case .verified(let transaction) = verification,
                  transaction.productType == .nonRenewable,
                  productIds.contains(transaction.productID) else { continue }
            result.append(RevflareTransaction(transaction))
        }
        return result
    }
}

extension TransactionEvent {
    init(_ verification: VerificationResult<Transaction>) {
        switch verification {
        case .verified(let transaction):
            TransactionEnvironmentRecorder.record(transaction)
            self.init(transaction: RevflareTransaction(transaction), verificationError: nil, finish: { await transaction.finish() })
        case .unverified(let transaction, let error):
            Log.error("Unverified StoreKit transaction \(transaction.id) (\(transaction.productID)): \(error)")
            self.init(transaction: nil, verificationError: String(describing: error), finish: {})
        }
    }
}

extension PurchaseAttempt {
    init(_ result: Product.PurchaseResult) {
        switch result {
        case .success(let verification): self = .completed(TransactionEvent(verification))
        case .userCancelled: self = .userCancelled
        case .pending: self = .pending
        @unknown default: self = .pending
        }
    }
}

extension SubscriptionRenewalState {
    init(_ state: Product.SubscriptionInfo.RenewalState) {
        switch state {
        case .subscribed: self = .subscribed
        case .expired: self = .expired
        case .inBillingRetryPeriod: self = .inBillingRetryPeriod
        case .inGracePeriod: self = .inGracePeriod
        case .revoked: self = .revoked
        default: self = .unknown
        }
    }
}

extension RevflareTransaction {
    init(_ transaction: Transaction) {
        let kind: ProductKind
        switch transaction.productType {
        case .autoRenewable: kind = .autoRenewable
        case .nonRenewable: kind = .nonRenewable
        case .nonConsumable: kind = .nonConsumable
        default: kind = .consumable
        }
        var offer: OfferKind?
        if let type = transaction.offerType {
            switch type {
            case .introductory: offer = .introductory
            case .promotional: offer = .promotional
            case .code: offer = .code
            default:
                if #available(iOS 18.0, macOS 15.0, tvOS 18.0, watchOS 11.0, *), type == .winBack {
                    offer = .winBack
                } else {
                    offer = .other
                }
            }
        }
        var isFreeTrial = false
        if #available(iOS 17.2, macOS 14.2, tvOS 17.2, watchOS 10.2, *) {
            isFreeTrial = transaction.offer?.paymentMode == .freeTrial
        } else {
            isFreeTrial = transaction.offerPaymentModeStringRepresentation == "FREE_TRIAL"
        }
        self.init(
            id: transaction.id,
            originalId: transaction.originalID,
            productId: transaction.productID,
            kind: kind,
            subscriptionGroupId: transaction.subscriptionGroupID,
            purchaseDate: transaction.purchaseDate,
            originalPurchaseDate: transaction.originalPurchaseDate,
            expirationDate: transaction.expirationDate,
            revocationDate: transaction.revocationDate,
            isUpgraded: transaction.isUpgraded,
            ownership: transaction.ownershipType == .familyShared ? .familyShared : .purchased,
            offer: offer,
            isFreeTrial: isFreeTrial,
            appAccountToken: transaction.appAccountToken
        )
    }
}

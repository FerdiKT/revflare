import Foundation
import XCTest
@testable import RevflareKit

// MARK: Fakes

/// StoreKit stand-in: scripted current entitlements, statuses, updates and unfinished transactions.
final class FakePurchaseBackend: PurchaseBackend, @unchecked Sendable {
    let entitlements = Locked<[RevflareTransaction]>([])
    let statuses = Locked<[SubscriptionStatusRecord]>([])
    let unfinished = Locked<[TransactionEvent]>([])
    let finished = Locked<[UInt64]>([])
    let syncCalls = Locked(0)
    let syncError = Locked<Error?>(nil)
    let requestedGroups = Locked<[[String: String]]>([])
    private let continuation = Locked<AsyncStream<TransactionEvent>.Continuation?>(nil)

    func currentEntitlements() async -> [RevflareTransaction] { entitlements.current }

    func subscriptionStatuses(groups: [String: String]) async -> [SubscriptionStatusRecord] {
        requestedGroups.withLock { $0.append(groups) }
        return statuses.current
    }

    func transactionUpdates() -> AsyncStream<TransactionEvent> {
        AsyncStream { continuation in self.continuation.withLock { $0 = continuation } }
    }

    func unfinishedTransactions() async -> [TransactionEvent] { unfinished.current }

    func syncWithAppStore() async throws {
        syncCalls.withLock { $0 += 1 }
        if let error = syncError.current { throw error }
    }

    /// `Transaction.all` of non-renewing products (passes); like StoreKitPurchaseBackend, other kinds are left out.
    let history = Locked<[RevflareTransaction]>([])
    let historyRequests = Locked<[Set<String>]>([])
    func nonRenewingHistory(productIds: Set<String>) async -> [RevflareTransaction] {
        historyRequests.withLock { $0.append(productIds) }
        return history.current.filter { productIds.contains($0.productId) && $0.kind == .nonRenewable }
    }

    let purchasedGroups = Locked<Set<String>>([])
    let purchasedGroupsCalls = Locked(0)
    func purchasedSubscriptionGroups() async -> Set<String> {
        purchasedGroupsCalls.withLock { $0 += 1 }
        return purchasedGroups.current
    }

    /// A verified event that records its finish and, when finished, makes the transaction a current entitlement.
    func event(_ transaction: RevflareTransaction, grants: Bool = true) -> TransactionEvent {
        TransactionEvent(transaction: transaction, verificationError: nil) { [self] in
            finished.withLock { $0.append(transaction.id) }
            if grants {
                entitlements.withLock { list in
                    list.removeAll { $0.productId == transaction.productId }
                    list.append(transaction)
                }
            }
        }
    }

    func unverifiedEvent() -> TransactionEvent {
        TransactionEvent(transaction: nil, verificationError: "bad signature") { [self] in
            finished.withLock { $0.append(0) }
        }
    }

    func sendUpdate(_ event: TransactionEvent) {
        continuation.current?.yield(event)
    }
}

private let now = Date(timeIntervalSince1970: 1_800_000_000)
private let day: TimeInterval = 86_400

private func lifetime(_ id: UInt64 = 1, ownership: RevflareTransaction.Ownership = .purchased) -> RevflareTransaction {
    RevflareTransaction(id: id, productId: "com.example.lifetime", kind: .nonConsumable,
                        purchaseDate: now.addingTimeInterval(-30 * day), ownership: ownership)
}

private func subscription(_ id: UInt64, product: String = "com.example.annual", expires: Date?,
                          originalId: UInt64? = nil, offer: RevflareTransaction.OfferKind? = nil, isFreeTrial: Bool = false,
                          revoked: Bool = false, upgraded: Bool = false) -> RevflareTransaction {
    RevflareTransaction(id: id, originalId: originalId, productId: product, kind: .autoRenewable, subscriptionGroupId: "group1",
                        purchaseDate: (expires ?? now).addingTimeInterval(-7 * day), expirationDate: expires,
                        revocationDate: revoked ? now.addingTimeInterval(-day) : nil, isUpgraded: upgraded,
                        offer: offer, isFreeTrial: isFreeTrial)
}

private let mapping = EntitlementMapping(["pro": ["com.example.weekly", "com.example.annual", "com.example.lifetime"]])

private func compute(_ transactions: [RevflareTransaction], _ statuses: [SubscriptionStatusRecord] = [],
                     mapping: EntitlementMapping = mapping) -> CustomerEntitlements {
    CustomerEntitlements.compute(transactions: transactions, statuses: statuses, mapping: mapping, now: now)
}

// MARK: Entitlement mapping

final class EntitlementComputationTests: XCTestCase {
    func testLifetimeGrantsProForever() throws {
        let result = compute([lifetime()])
        let pro = try XCTUnwrap(result.active["pro"])
        XCTAssertEqual(pro.productId, "com.example.lifetime")
        XCTAssertTrue(pro.isLifetime)
        XCTAssertFalse(pro.willRenew)
        XCTAssertEqual(pro.periodType, .normal)
        XCTAssertEqual(result.activeProductIds, ["com.example.lifetime"])
        XCTAssertTrue(result.subscriptions.isEmpty)
    }

    func testSubscriptionActiveUntilExpiration() {
        XCTAssertNotNil(compute([subscription(1, expires: now.addingTimeInterval(day))]).active["pro"])
        XCTAssertNil(compute([subscription(1, expires: now.addingTimeInterval(-1))]).active["pro"])
    }

    func testRevokedUpgradedAndConsumablesGiveNothing() {
        XCTAssertTrue(compute([subscription(1, expires: now.addingTimeInterval(day), revoked: true)]).active.isEmpty)
        XCTAssertTrue(compute([subscription(1, expires: now.addingTimeInterval(day), upgraded: true)]).active.isEmpty)
        var refunded = lifetime()
        refunded.revocationDate = now
        XCTAssertTrue(compute([refunded]).active.isEmpty)
        let coins = RevflareTransaction(id: 9, productId: "com.example.lifetime", kind: .consumable, purchaseDate: now)
        XCTAssertTrue(compute([coins]).active.isEmpty)
    }

    func testGracePeriodKeepsAccessAfterExpiration() throws {
        let lapsed = subscription(1, expires: now.addingTimeInterval(-day))
        let grace = SubscriptionStatusRecord(state: .inGracePeriod, transaction: lapsed, willAutoRenew: true,
                                             gracePeriodExpirationDate: now.addingTimeInterval(5 * day))
        // Present in the current entitlements, and also when StoreKit already left it out.
        for transactions in [[lapsed], []] {
            let result = compute(transactions, [grace])
            let pro = try XCTUnwrap(result.active["pro"])
            XCTAssertTrue(pro.isInGracePeriod)
            XCTAssertTrue(pro.willRenew)
            let details = try XCTUnwrap(result.subscriptions["com.example.annual"])
            XCTAssertTrue(details.isActive)
            XCTAssertEqual(details.state, .inGracePeriod)
            XCTAssertEqual(details.gracePeriodExpirationDate, now.addingTimeInterval(5 * day))
        }
        // Once the grace period is over, access ends.
        var over = grace
        over.gracePeriodExpirationDate = now.addingTimeInterval(-1)
        XCTAssertNil(compute([lapsed], [over]).active["pro"])
    }

    func testBillingRetryIsNotActiveButReported() throws {
        let lapsed = subscription(1, expires: now.addingTimeInterval(-day))
        let retry = SubscriptionStatusRecord(state: .inBillingRetryPeriod, transaction: lapsed, willAutoRenew: true)
        let result = compute([], [retry])
        XCTAssertNil(result.active["pro"])
        let details = try XCTUnwrap(result.subscriptions["com.example.annual"])
        XCTAssertFalse(details.isActive)
        XCTAssertTrue(details.isInBillingRetry)
        XCTAssertFalse(details.isInGracePeriod)
    }

    func testStatusWinsOverStaleTransaction() {
        let stale = subscription(1, expires: now.addingTimeInterval(day))
        for state in [SubscriptionRenewalState.expired, .revoked, .inBillingRetryPeriod] {
            let status = SubscriptionStatusRecord(state: state, transaction: stale, willAutoRenew: false)
            XCTAssertNil(compute([stale], [status]).active["pro"], state.rawValue)
        }
        let subscribed = SubscriptionStatusRecord(state: .subscribed, transaction: stale, willAutoRenew: false,
                                                  autoRenewProductId: "com.example.weekly")
        let result = compute([stale], [subscribed])
        XCTAssertEqual(result.active["pro"]?.willRenew, false)
        XCTAssertEqual(result.subscriptions["com.example.annual"]?.autoRenewProductId, "com.example.weekly")
    }

    func testBestProductWins() {
        let annual = subscription(2, expires: now.addingTimeInterval(300 * day))
        let weekly = subscription(3, product: "com.example.weekly", expires: now.addingTimeInterval(3 * day))
        XCTAssertEqual(compute([weekly, annual]).active["pro"]?.productId, "com.example.annual")
        XCTAssertEqual(compute([weekly, annual, lifetime()]).active["pro"]?.productId, "com.example.lifetime")
        XCTAssertEqual(compute([weekly, annual, lifetime()]).activeProductIds.count, 3)
    }

    func testFamilySharedCounts() {
        let shared = compute([lifetime(ownership: .familyShared)])
        XCTAssertEqual(shared.active["pro"]?.ownership, .familyShared)
    }

    func testTrialAndIntroPeriods() throws {
        let trial = subscription(1, expires: now.addingTimeInterval(3 * day), offer: .introductory, isFreeTrial: true)
        let result = compute([trial])
        XCTAssertEqual(result.active["pro"]?.periodType, .trial)
        let details = try XCTUnwrap(result.subscriptions["com.example.annual"])
        XCTAssertTrue(details.isInFreeTrial)
        XCTAssertTrue(details.isInIntroOffer)
        XCTAssertTrue(details.willAutoRenew, "active without a status: assumed to renew")
        let intro = subscription(1, expires: now.addingTimeInterval(3 * day), offer: .introductory)
        XCTAssertEqual(compute([intro]).active["pro"]?.periodType, .intro)
        let code = subscription(1, expires: now.addingTimeInterval(3 * day), offer: .code)
        XCTAssertEqual(compute([code]).active["pro"]?.periodType, .normal)
    }

    func testMappingSeveralEntitlementsAndUnmappedProducts() {
        let mapping = EntitlementMapping(["pro": ["com.example.lifetime"], "ads_free": ["com.example.lifetime", "com.example.annual"]])
        XCTAssertEqual(mapping.entitlements(for: "com.example.lifetime"), ["pro", "ads_free"])
        XCTAssertEqual(mapping.allProductIds, ["com.example.lifetime", "com.example.annual"])
        let result = compute([lifetime()], mapping: mapping)
        XCTAssertEqual(Set(result.active.keys), ["pro", "ads_free"])
        let unmapped = RevflareTransaction(id: 5, productId: "com.example.other", kind: .nonConsumable, purchaseDate: now)
        let other = compute([unmapped], mapping: mapping)
        XCTAssertTrue(other.active.isEmpty)
        XCTAssertEqual(other.activeProductIds, ["com.example.other"])
    }
}

// MARK: Store state transitions

@MainActor
final class RevflareStoreTests: XCTestCase {
    private var backend: FakePurchaseBackend!
    private var links: Locked<Int>!

    override func setUp() async throws {
        backend = FakePurchaseBackend()
        links = Locked(0)
    }

    private func makeStore() -> RevflareStore {
        let links = self.links!
        return RevflareStore(productIds: ["com.example.weekly", "com.example.annual", "com.example.lifetime"],
                             mapping: mapping, backend: backend, productLoader: { _ in [] }, now: { now },
                             linkPurchases: { links.withLock { $0 += 1 } })
    }

    private func waitUntil(_ condition: @MainActor () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<200 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("Condition not met", file: file, line: line)
    }

    func testStartLoadsEntitlementsAndFinishesUnfinished() async {
        let pending = subscription(7, expires: now.addingTimeInterval(day))
        backend.unfinished.withLock { $0 = [backend.event(pending)] }
        let store = makeStore()
        XCTAssertFalse(store.hasLoadedEntitlements)
        await waitUntil { store.hasLoadedEntitlements }
        XCTAssertEqual(backend.finished.current, [7])
        XCTAssertTrue(store.isActive("pro"))
        XCTAssertEqual(backend.requestedGroups.current.last, ["group1": "com.example.annual"])
        XCTAssertEqual(links.current, 1)
    }

    func testPurchaseSuccessFinishesRefreshesAndLinks() async throws {
        let store = makeStore()
        await waitUntil { store.hasLoadedEntitlements }
        XCTAssertFalse(store.isActive("pro"))
        let bought = subscription(10, expires: now.addingTimeInterval(7 * day))
        let outcome = try await store.purchase(productId: bought.productId) {
            XCTAssertTrue(store.isPurchasing)
            return .completed(backend.event(bought))
        }
        XCTAssertEqual(outcome, .purchased(bought))
        XCTAssertTrue(outcome.isPurchased)
        XCTAssertFalse(store.isPurchasing)
        XCTAssertEqual(backend.finished.current, [10])
        XCTAssertTrue(store.isActive("pro"))
        XCTAssertEqual(store.entitlement(named: "pro")?.productId, "com.example.annual")
        XCTAssertTrue(store.isActive(productIds: ["com.example.annual"]))
        XCTAssertFalse(store.isActive(productIds: ["com.example.weekly"]))
        XCTAssertEqual(store.subscription(for: "com.example.annual")?.expirationDate, now.addingTimeInterval(7 * day))
        XCTAssertEqual(links.current, 1)
    }

    func testCancelledPurchaseChangesNothing() async throws {
        let store = makeStore()
        await waitUntil { store.hasLoadedEntitlements }
        let before = store.customer
        let outcome = try await store.purchase(productId: "com.example.annual") { .userCancelled }
        XCTAssertEqual(outcome, .userCancelled)
        XCTAssertEqual(store.customer, before)
        XCTAssertTrue(backend.finished.current.isEmpty)
        XCTAssertEqual(links.current, 0)
        XCTAssertFalse(store.isPurchasing)
    }

    func testPendingPurchaseUnlocksWhenTheUpdateArrives() async throws {
        let store = makeStore()
        await waitUntil { store.hasLoadedEntitlements }
        let outcome = try await store.purchase(productId: "com.example.lifetime") { .pending }
        XCTAssertEqual(outcome, .pending)
        XCTAssertFalse(store.isActive("pro"))
        // Ask to Buy approved: StoreKit delivers the transaction through Transaction.updates.
        backend.sendUpdate(backend.event(lifetime(42)))
        await waitUntil { store.isActive("pro") }
        XCTAssertEqual(backend.finished.current, [42])
        XCTAssertTrue(store.entitlement(named: "pro")?.isLifetime ?? false)
        XCTAssertEqual(links.current, 1)
    }

    func testUnverifiedPurchaseThrowsAndIsNotFinished() async {
        let store = makeStore()
        await waitUntil { store.hasLoadedEntitlements }
        do {
            _ = try await store.purchase(productId: "com.example.annual") { .completed(backend.unverifiedEvent()) }
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? RevflareStoreError, .failedVerification("bad signature"))
        }
        XCTAssertTrue(backend.finished.current.isEmpty)
        XCTAssertFalse(store.isActive("pro"))
        XCTAssertFalse(store.isPurchasing)
    }

    func testUnverifiedUpdateIsIgnored() async {
        let store = makeStore()
        await waitUntil { store.hasLoadedEntitlements }
        backend.sendUpdate(backend.unverifiedEvent())
        backend.sendUpdate(backend.event(lifetime(3)))
        await waitUntil { store.isActive("pro") }
        XCTAssertEqual(backend.finished.current, [3])
    }

    func testPurchaseErrorPropagates() async {
        let store = makeStore()
        await waitUntil { store.hasLoadedEntitlements }
        do {
            _ = try await store.purchase(productId: "com.example.annual") { throw URLError(.notConnectedToInternet) }
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .notConnectedToInternet)
        }
        XCTAssertFalse(store.isPurchasing)
    }

    func testRestoreSyncsAndRefreshes() async throws {
        let store = makeStore()
        await waitUntil { store.hasLoadedEntitlements }
        // Bought on another device: only visible after AppStore.sync().
        backend.entitlements.withLock { $0 = [lifetime()] }
        let restored = try await store.restore()
        XCTAssertEqual(backend.syncCalls.current, 1)
        XCTAssertNotNil(restored.active["pro"])
        XCTAssertTrue(store.isActive("pro"))
        XCTAssertEqual(links.current, 1)
    }

    func testRestoreErrorPropagates() async {
        let store = makeStore()
        await waitUntil { store.hasLoadedEntitlements }
        backend.syncError.withLock { $0 = URLError(.userCancelledAuthentication) }
        do {
            try await store.restore()
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .userCancelledAuthentication)
        }
        XCTAssertFalse(store.isPurchasing)
        XCTAssertFalse(store.isActive("pro"))
    }

    func testRefundRemovesAccess() async {
        backend.entitlements.withLock { $0 = [subscription(1, expires: now.addingTimeInterval(day))] }
        let store = makeStore()
        await waitUntil { store.isActive("pro") }
        // A refund arrives as an update with a revocation date.
        let refunded = subscription(1, expires: now.addingTimeInterval(day), revoked: true)
        backend.sendUpdate(backend.event(refunded))
        await waitUntil { !store.isActive("pro") }
        XCTAssertTrue(store.activeEntitlements.isEmpty)
    }

    func testRenewalKeepsAccessAndUpdatesExpiration() async {
        backend.entitlements.withLock { $0 = [subscription(1, expires: now.addingTimeInterval(day))] }
        let store = makeStore()
        await waitUntil { store.isActive("pro") }
        let renewed = subscription(2, expires: now.addingTimeInterval(8 * day), originalId: 1)
        backend.sendUpdate(backend.event(renewed))
        await waitUntil { store.entitlement(named: "pro")?.expirationDate == now.addingTimeInterval(8 * day) }
        XCTAssertEqual(store.entitlement(named: "pro")?.transaction.originalId, 1)
    }
}

import Foundation
import StoreKit
import XCTest
@testable import RevflareKit

// Server-driven entitlements and non-renewing durations (RevflareKit 1.9).

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
private let day: TimeInterval = 86_400
private let pass = "com.example.pass_3day"

private func passTx(_ id: UInt64, bought: Date, product: String = pass, refunded: Bool = false) -> RevflareTransaction {
    RevflareTransaction(id: id, productId: product, kind: .nonRenewable, purchaseDate: bought,
                        revocationDate: refunded ? bought.addingTimeInterval(3600) : nil)
}

private func utc(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 0) -> Date {
    var c = DateComponents()
    (c.year, c.month, c.day, c.hour) = (y, m, d, h)
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "UTC")!
    return cal.date(from: c)!
}

final class NonRenewingDurationTests: XCTestCase {
    func testEndOnTheUTCCalendar() {
        let start = utc(2026, 1, 31, 10)
        XCTAssertEqual(NonRenewingDuration.days(3).end(from: start), start.addingTimeInterval(3 * day))
        XCTAssertEqual(NonRenewingDuration.weeks(2).end(from: start), start.addingTimeInterval(14 * day))
        XCTAssertEqual(NonRenewingDuration.months(1).end(from: start), utc(2026, 2, 28, 10))
        XCTAssertEqual(NonRenewingDuration.months(1).end(from: utc(2028, 1, 31)), utc(2028, 2, 29))
        XCTAssertEqual(NonRenewingDuration.months(13).end(from: start), utc(2027, 2, 28, 10))
        XCTAssertEqual(NonRenewingDuration.years(1).end(from: utc(2028, 2, 29)), utc(2029, 2, 28))
        XCTAssertEqual(NonRenewingDuration.days(0).count, 1)
        XCTAssertEqual(NonRenewingDuration.days(3).description, "3 days")
    }

    func testDecodingWithAndWithoutTheNewFields() throws {
        let old = #"{ "version": "v1", "currentOfferingId": null, "offerings": [], "placements": {} }"#
        let a = try JSONDecoder().decode(OfferingsResponse.self, from: Data(old.utf8))
        XCTAssertEqual(a.entitlements, [:])
        XCTAssertEqual(a.durations, [:])
        XCTAssertTrue(a.serverEntitlements.isEmpty)

        let new = #"""
        { "version": "v2", "currentOfferingId": null, "offerings": [], "placements": {},
          "entitlements": { "pro": ["com.example.monthly", "com.example.pass_3day"], "bad": "nope" },
          "products": { "com.example.pass_3day": { "duration": { "unit": "day", "count": 3 } },
                        "com.example.week": { "duration": { "unit": "week", "count": 1 }, "future": true },
                        "com.example.broken": { "duration": { "unit": "hour", "count": 3 } },
                        "com.example.zero": { "duration": { "unit": "day", "count": 0 } },
                        "com.example.plain": {} } }
        """#
        let b = try JSONDecoder().decode(OfferingsResponse.self, from: Data(new.utf8))
        XCTAssertEqual(b.entitlements, ["pro": ["com.example.monthly", "com.example.pass_3day"]])
        XCTAssertEqual(b.durations, ["com.example.pass_3day": .days(3), "com.example.week": .weeks(1)])
        XCTAssertEqual(b.serverEntitlements.productIds, ["com.example.monthly", "com.example.pass_3day", "com.example.week"])
        // The offerings model carries them.
        let offerings = RevflareOfferings(OfferingsSnapshot<Product>(response: b, products: [:]))
        XCTAssertEqual(offerings.entitlements, b.entitlements)
        XCTAssertEqual(offerings.nonRenewingDurations, b.durations)
        // Malformed field types do not break the offerings.
        let odd = #"{ "version": "v3", "offerings": [], "entitlements": [1, 2], "products": "x" }"#
        let c = try JSONDecoder().decode(OfferingsResponse.self, from: Data(odd.utf8))
        XCTAssertEqual(c.entitlements, [:])
        XCTAssertEqual(c.durations, [:])
    }

    func testMergeRules() {
        let local = EntitlementMapping(["pro": ["com.example.annual"], "extra": ["com.example.extra"]])
        let merged = NonRenewingRules.mergedMapping(local: local, server: ["pro": ["com.example.annual", pass], "team": ["com.example.team"]])
        XCTAssertEqual(merged.entitlements, [
            "pro": ["com.example.annual", pass], "extra": ["com.example.extra"], "team": ["com.example.team"],
        ])
        XCTAssertEqual(NonRenewingRules.mergedMapping(local: local, server: [:]), local)
        let durations = NonRenewingRules.mergedDurations(local: [pass: .days(5)],
                                                         server: [pass: .days(3), "com.example.week": .weeks(1)])
        XCTAssertEqual(durations, [pass: .days(5), "com.example.week": .weeks(1)])
    }

    func testServerDurationsNeverApplyToProductsTheAppDeclares() {
        // The app ships "com.example.lifetime" and the pass (with its own duration); the server sets durations on both
        // and on a product the app doesn't know.
        let durations = NonRenewingRules.mergedDurations(
            local: [pass: .days(3)],
            server: ["com.example.lifetime": .days(3), pass: .weeks(1), "com.example.new_pass": .days(1)],
            declared: ["com.example.lifetime", pass]
        )
        XCTAssertEqual(durations, [pass: .days(3), "com.example.new_pass": .days(1)])
    }

    func testStorageKeyIsScopedByServerAndSDKKey() {
        let a = ServerEntitlements.storageKey(server: URL(string: "https://a.example.com")!, sdkKey: "rfp_1")
        XCTAssertEqual(a, ServerEntitlements.storageKey(server: URL(string: "https://a.example.com")!, sdkKey: "rfp_1"))
        XCTAssertNotEqual(a, ServerEntitlements.storageKey(server: URL(string: "https://b.example.com")!, sdkKey: "rfp_1"))
        XCTAssertNotEqual(a, ServerEntitlements.storageKey(server: URL(string: "https://a.example.com")!, sdkKey: "rfp_2"))
        XCTAssertTrue(a.hasPrefix("app.revflare.kit.serverEntitlements."))
        let store = MemoryStore()
        ServerEntitlements(entitlements: ["pro": [pass]], durations: [pass: .days(3)]).save(to: store, key: a)
        XCTAssertEqual(ServerEntitlements.load(from: store, key: a).durations, [pass: .days(3)])
        XCTAssertTrue(ServerEntitlements.load(from: store, key: "other").isEmpty)
        XCTAssertTrue(ServerEntitlements.load(from: store, key: nil).isEmpty)
    }
}

final class NonRenewingEntitlementTests: XCTestCase {
    private let mapping = EntitlementMapping(["pro": ["com.example.lifetime", pass]])

    private func compute(_ transactions: [RevflareTransaction], durations: [String: NonRenewingDuration] = [pass: .days(3)],
                         now: Date) -> CustomerEntitlements {
        CustomerEntitlements.compute(transactions: transactions, statuses: [], mapping: mapping, durations: durations, now: now)
    }

    func testWithoutDurationAPassIsLifetime() {
        let result = compute([passTx(1, bought: t0)], durations: [:], now: t0.addingTimeInterval(30 * day))
        XCTAssertEqual(result.active["pro"]?.isLifetime, true)
    }

    func testDurationExpiresThePass() throws {
        let bought = t0
        let during = compute([passTx(1, bought: bought)], now: bought.addingTimeInterval(2 * day))
        let pro = try XCTUnwrap(during.active["pro"])
        XCTAssertFalse(pro.isLifetime)
        XCTAssertEqual(pro.expirationDate, bought.addingTimeInterval(3 * day))
        XCTAssertFalse(pro.willRenew)
        XCTAssertNil(during.subscriptions[pass])
        XCTAssertNil(compute([passTx(1, bought: bought)], now: bought.addingTimeInterval(3 * day)).active["pro"])
    }

    func testRepeatPurchasesStack() throws {
        // Bought at day 0, again at day 1 (while active): the second runs from day 3 to day 6. A third bought at day 10
        // (after the chain ended) runs 10 → 13.
        let txs = [passTx(2, bought: t0.addingTimeInterval(day)), passTx(1, bought: t0), passTx(3, bought: t0.addingTimeInterval(10 * day))]
        let atDay5 = compute(Array(txs.prefix(2)), now: t0.addingTimeInterval(5 * day))
        XCTAssertEqual(atDay5.active["pro"]?.expirationDate, t0.addingTimeInterval(6 * day))
        XCTAssertEqual(atDay5.active["pro"]?.transaction.id, 2)
        XCTAssertNil(compute(Array(txs.prefix(2)), now: t0.addingTimeInterval(6 * day)).active["pro"])
        let atDay11 = compute(txs, now: t0.addingTimeInterval(11 * day))
        XCTAssertEqual(atDay11.active["pro"]?.expirationDate, t0.addingTimeInterval(13 * day))
        let applied = NonRenewingRules.applyingDurations([pass: .days(3)], to: txs)
        XCTAssertEqual(applied.map(\.expirationDate), [t0.addingTimeInterval(6 * day), t0.addingTimeInterval(3 * day), t0.addingTimeInterval(13 * day)])
    }

    func testRefundedPassesAreExcludedAndDoNotStack() {
        let txs = [passTx(1, bought: t0, refunded: true), passTx(2, bought: t0.addingTimeInterval(day))]
        let result = compute(txs, now: t0.addingTimeInterval(3.5 * day))
        // The refunded one gives nothing and does not push the second: 1 → 4.
        XCTAssertEqual(result.active["pro"]?.expirationDate, t0.addingTimeInterval(4 * day))
        XCTAssertNil(compute([passTx(1, bought: t0, refunded: true)], now: t0.addingTimeInterval(day)).active["pro"])
    }

    func testDurationsNeverApplyToNonConsumables() throws {
        // A duration set (by mistake) on a lifetime product: it stays lifetime, for ever.
        let lifetime = RevflareTransaction(id: 9, productId: "com.example.lifetime", kind: .nonConsumable, purchaseDate: t0)
        let durations: [String: NonRenewingDuration] = ["com.example.lifetime": .days(3)]
        XCTAssertNil(NonRenewingRules.applyingDurations(durations, to: [lifetime])[0].expirationDate)
        let result = compute([lifetime], durations: durations, now: t0.addingTimeInterval(400 * day))
        let pro = try XCTUnwrap(result.active["pro"])
        XCTAssertTrue(pro.isLifetime)
        XCTAssertNil(pro.expirationDate)
        XCTAssertNil(result.activeTransactions["com.example.lifetime"]?.expirationDate)
    }

    func testLifetimeBeatsAPassAndOtherProductsAreUntouched() {
        let lifetime = RevflareTransaction(id: 9, productId: "com.example.lifetime", kind: .nonConsumable, purchaseDate: t0)
        let result = compute([lifetime, passTx(1, bought: t0)], now: t0.addingTimeInterval(day))
        XCTAssertEqual(result.active["pro"]?.productId, "com.example.lifetime")
        XCTAssertEqual(result.active["pro"]?.isLifetime, true)
        XCTAssertEqual(result.activeTransactions[pass]?.expirationDate, t0.addingTimeInterval(3 * day))
    }
}

@MainActor
final class ServerEntitlementsStoreTests: XCTestCase {
    private func offerings(entitlements: [String: [String]], durations: [String: NonRenewingDuration] = [:]) -> RevflareOfferings {
        RevflareOfferings(OfferingsSnapshot<Product>(
            response: OfferingsResponse(version: "v", currentOfferingId: nil, offerings: [], placements: [:],
                                        entitlements: entitlements, durations: durations),
            products: [:]))
    }

    private func waitUntil(_ condition: @MainActor () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<400 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("Condition not met", file: file, line: line)
    }

    func testServerMappingIsMergedLoadsItsProductsPersistsAndGrants() async {
        let backend = FakePurchaseBackend()
        backend.entitlements.withLock { $0 = [passTx(1, bought: t0.addingTimeInterval(-day))] }
        let persistence = MemoryStore()
        let requested = Locked<[[String]]>([])
        let server = offerings(entitlements: ["pro": ["com.example.annual", pass]], durations: [pass: .days(3)])
        let store = RevflareStore(productIds: ["com.example.annual"], mapping: EntitlementMapping(["pro": ["com.example.annual"]]),
                                  backend: backend,
                                  productLoader: { ids in requested.withLock { $0.append(ids) }; return [] },
                                  now: { t0 }, linkPurchases: {},
                                  offeringsLoader: { _ in server }, loadsOfferingsAutomatically: true,
                                  persistence: persistence, serverEntitlementsKey: { "k" })
        await waitUntil { store.offerings != nil && store.isActive("pro") }
        XCTAssertEqual(store.mapping.entitlements["pro"], ["com.example.annual", pass])
        XCTAssertEqual(store.localMapping.entitlements["pro"], ["com.example.annual"])
        XCTAssertEqual(store.nonRenewingDurations, [pass: .days(3)])
        XCTAssertEqual(store.productIds, ["com.example.annual", pass])
        // The pass product was asked from StoreKit (auto-loaded) even though the app never listed it.
        XCTAssertEqual(requested.current, [["com.example.annual"], [pass]])
        let pro = store.entitlement(named: "pro")
        XCTAssertEqual(pro?.productId, pass)
        XCTAssertEqual(pro?.isLifetime, false)
        XCTAssertEqual(pro?.expirationDate, t0.addingTimeInterval(2 * day))
        // Stacking needs the pass history.
        XCTAssertEqual(backend.historyRequests.current.last, [pass])
        XCTAssertEqual(ServerEntitlements.load(from: persistence, key: "k"), server.serverEntitlementsForTests)

        // Next launch, offline: the saved server map applies at once, before any network.
        let offline = RevflareStore(productIds: ["com.example.annual"], mapping: EntitlementMapping(["pro": ["com.example.annual"]]),
                                    nonRenewingDurations: [pass: .days(5)],
                                    backend: backend, productLoader: { _ in [] }, now: { t0 }, linkPurchases: {},
                                    offeringsLoader: { _ in throw RevflareOfferingsError.network("offline") },
                                    loadsOfferingsAutomatically: true, persistence: persistence,
                                    serverEntitlementsKey: { "k" }, start: false)
        XCTAssertEqual(offline.mapping.entitlements["pro"], ["com.example.annual", pass])
        XCTAssertEqual(offline.productIds, ["com.example.annual", pass])
        // The app's own duration wins.
        XCTAssertEqual(offline.nonRenewingDurations, [pass: .days(5)])
        // Another server / SDK key never sees this copy.
        let elsewhere = RevflareStore(productIds: ["com.example.annual"], mapping: EntitlementMapping(["pro": ["com.example.annual"]]),
                                      backend: backend, productLoader: { _ in [] }, linkPurchases: {},
                                      persistence: persistence, serverEntitlementsKey: { "other" }, start: false)
        XCTAssertEqual(elsewhere.mapping, elsewhere.localMapping)
        await offline.refresh()
        XCTAssertEqual(offline.entitlement(named: "pro")?.expirationDate, t0.addingTimeInterval(4 * day))
    }

    func testLocalMapAndDurationsApplyWithoutServer() async {
        let backend = FakePurchaseBackend()
        backend.entitlements.withLock { $0 = [passTx(1, bought: t0.addingTimeInterval(-day))] }
        let store = RevflareStore(productIds: [pass], mapping: EntitlementMapping(["pro": [pass]]),
                                  nonRenewingDurations: [pass: .days(3)], backend: backend, productLoader: { _ in [] },
                                  now: { t0 }, linkPurchases: {},
                                  offeringsLoader: { _ in throw RevflareOfferingsError.notConfigured },
                                  loadsOfferingsAutomatically: true, reportsMissingConfiguration: false,
                                  persistence: MemoryStore())
        await waitUntil { store.hasLoadedEntitlements }
        XCTAssertEqual(store.entitlement(named: "pro")?.expirationDate, t0.addingTimeInterval(2 * day))
        try? await Task.sleep(nanoseconds: 30_000_000)
        // No SDK key: the automatic load stays quiet.
        XCTAssertNil(store.offeringsError)
    }

    func testServerChangeRecomputesAndRemovalDropsServerProducts() async {
        let backend = FakePurchaseBackend()
        backend.entitlements.withLock { $0 = [passTx(1, bought: t0.addingTimeInterval(-day))] }
        let persistence = MemoryStore()
        let store = RevflareStore(productIds: ["com.example.annual"], mapping: EntitlementMapping(["pro": ["com.example.annual"]]),
                                  backend: backend, productLoader: { _ in [] }, now: { t0 }, linkPurchases: {},
                                  persistence: persistence, serverEntitlementsKey: { "k" })
        await waitUntil { store.hasLoadedEntitlements }
        XCTAssertFalse(store.isActive("pro"))
        await store.applyServerEntitlements(ServerEntitlements(entitlements: ["pro": [pass]], durations: [:]))
        XCTAssertTrue(store.isActive("pro"))
        XCTAssertEqual(store.entitlement(named: "pro")?.isLifetime, true, "no duration: lifetime")
        await store.applyServerEntitlements(ServerEntitlements(entitlements: ["pro": [pass]], durations: [pass: .days(3)]))
        XCTAssertEqual(store.entitlement(named: "pro")?.expirationDate, t0.addingTimeInterval(2 * day))
        await store.applyServerEntitlements(ServerEntitlements())
        XCTAssertFalse(store.isActive("pro"))
        XCTAssertEqual(store.mapping, store.localMapping)
        XCTAssertTrue(ServerEntitlements.load(from: persistence, key: "k").isEmpty)
    }

    func testServerDurationNeverShortensADeclaredProduct() async {
        // The app ships a lifetime-like product it declares (a non-renewing one without a duration, so lifetime); the
        // server sets a 3-day duration on it: ignored. Undeclared products still get theirs.
        let declared = "com.example.declared_pass"
        let backend = FakePurchaseBackend()
        backend.entitlements.withLock { $0 = [passTx(1, bought: t0.addingTimeInterval(-30 * day), product: declared)] }
        let store = RevflareStore(productIds: [declared], mapping: EntitlementMapping(["pro": [declared]]),
                                  backend: backend, productLoader: { _ in [] }, now: { t0 }, linkPurchases: {},
                                  persistence: MemoryStore(), serverEntitlementsKey: { "k" })
        await waitUntil { store.hasLoadedEntitlements }
        await store.applyServerEntitlements(ServerEntitlements(entitlements: [:], durations: [declared: .days(3), pass: .days(3)]))
        XCTAssertEqual(store.nonRenewingDurations, [pass: .days(3)])
        XCTAssertEqual(store.declaredProductIds, [declared])
        XCTAssertEqual(store.entitlement(named: "pro")?.isLifetime, true)

        // With a local duration the app opted in: the local one applies (never the server's).
        let optedIn = RevflareStore(productIds: [declared], mapping: EntitlementMapping(["pro": [declared]]),
                                    nonRenewingDurations: [declared: .weeks(10)],
                                    backend: backend, productLoader: { _ in [] }, now: { t0 }, linkPurchases: {},
                                    persistence: MemoryStore(), serverEntitlementsKey: { "k" })
        await waitUntil { optedIn.hasLoadedEntitlements }
        await optedIn.applyServerEntitlements(ServerEntitlements(entitlements: [:], durations: [declared: .days(3)]))
        XCTAssertEqual(optedIn.nonRenewingDurations, [declared: .weeks(10)])
        XCTAssertEqual(optedIn.entitlement(named: "pro")?.expirationDate, t0.addingTimeInterval(40 * day))
    }

    func testProductIdStoreSyncsServerEntitlementsWithoutOfferings() async {
        let backend = FakePurchaseBackend()
        backend.entitlements.withLock { $0 = [passTx(1, bought: t0.addingTimeInterval(-day))] }
        let offeringsCalls = Locked(0)
        let serverCalls = Locked<[OfferingsFetchPolicy]>([])
        let requested = Locked<[[String]]>([])
        let store = RevflareStore(productIds: ["com.example.annual"], mapping: EntitlementMapping(["pro": ["com.example.annual"]]),
                                  backend: backend,
                                  productLoader: { ids in requested.withLock { $0.append(ids) }; return [] },
                                  now: { t0 }, linkPurchases: {},
                                  offeringsLoader: { _ in
                                      offeringsCalls.withLock { $0 += 1 }
                                      throw RevflareOfferingsError.network("unexpected")
                                  },
                                  loadsOfferingsAutomatically: false,
                                  serverEntitlementsLoader: { policy in
                                      serverCalls.withLock { $0.append(policy) }
                                      return ServerEntitlements(entitlements: ["pro": [pass]], durations: [pass: .days(3)])
                                  },
                                  syncsServerEntitlements: true, reportsMissingConfiguration: false,
                                  persistence: MemoryStore(), serverEntitlementsKey: { "k" })
        await waitUntil { store.isActive("pro") }
        // One cheap request; no offerings, no offering products: only the app's ids and the server-mapped pass.
        XCTAssertEqual(serverCalls.current, [.cachedOrFetched])
        XCTAssertEqual(offeringsCalls.current, 0)
        XCTAssertNil(store.offerings)
        XCTAssertNil(store.offeringsError)
        XCTAssertEqual(store.productIds, ["com.example.annual", pass])
        XCTAssertEqual(requested.current, [["com.example.annual"], [pass]])
        XCTAssertEqual(store.entitlement(named: "pro")?.expirationDate, t0.addingTimeInterval(2 * day))

        // Not configured (no SDK key): quiet, the app's map applies.
        let quiet = RevflareStore(productIds: [pass], mapping: EntitlementMapping(["pro": [pass]]),
                                  backend: backend, productLoader: { _ in [] }, now: { t0 }, linkPurchases: {},
                                  serverEntitlementsLoader: { _ in throw RevflareOfferingsError.notConfigured },
                                  syncsServerEntitlements: true, reportsMissingConfiguration: false,
                                  persistence: MemoryStore(), serverEntitlementsKey: { nil })
        await waitUntil { quiet.hasLoadedEntitlements }
        XCTAssertEqual(quiet.entitlement(named: "pro")?.isLifetime, true)
        XCTAssertNil(quiet.offeringsError)
    }

    func testPassHistoryIsCachedUntilATransactionArrives() async {
        let backend = FakePurchaseBackend()
        backend.entitlements.withLock { $0 = [passTx(2, bought: t0.addingTimeInterval(-day))] }
        backend.history.withLock { $0 = [passTx(1, bought: t0.addingTimeInterval(-2 * day)), passTx(2, bought: t0.addingTimeInterval(-day))] }
        let store = RevflareStore(productIds: [pass], mapping: EntitlementMapping(["pro": [pass]]),
                                  nonRenewingDurations: [pass: .days(3)], backend: backend, productLoader: { _ in [] },
                                  now: { t0 }, linkPurchases: {}, persistence: MemoryStore(), start: false)
        await store.refresh()
        await store.refresh()
        await store.refresh()
        XCTAssertEqual(backend.historyRequests.current.count, 1)
        XCTAssertEqual(store.entitlement(named: "pro")?.expirationDate, t0.addingTimeInterval(4 * day))

        // A transaction update (another purchase, a refund...) invalidates it.
        let third = passTx(3, bought: t0)
        backend.history.withLock { $0.append(third) }
        await store.handle(backend.event(third))
        XCTAssertEqual(backend.historyRequests.current.count, 2)
        XCTAssertEqual(store.entitlement(named: "pro")?.expirationDate, t0.addingTimeInterval(7 * day))
        await store.refresh()
        XCTAssertEqual(backend.historyRequests.current.count, 2)

        // A restore too.
        _ = try? await store.restore()
        XCTAssertEqual(backend.historyRequests.current.count, 3)
    }

    // RevflareKit 1.9.1: the cached pass history follows Transaction.currentEntitlements.

    private func passStore(_ backend: FakePurchaseBackend) -> RevflareStore {
        RevflareStore(productIds: [pass], mapping: EntitlementMapping(["pro": [pass]]),
                      nonRenewingDurations: [pass: .days(3)], backend: backend, productLoader: { _ in [] },
                      now: { t0 }, linkPurchases: {}, persistence: MemoryStore(), start: false)
    }

    func testDeletedTransactionsTurnTheEntitlementOffOnTheNextRefresh() async {
        let backend = FakePurchaseBackend()
        backend.entitlements.withLock { $0 = [passTx(2, bought: t0.addingTimeInterval(-day))] }
        backend.history.withLock { $0 = [passTx(1, bought: t0.addingTimeInterval(-2 * day)), passTx(2, bought: t0.addingTimeInterval(-day))] }
        let store = passStore(backend)
        await store.refresh()
        XCTAssertEqual(store.entitlement(named: "pro")?.expirationDate, t0.addingTimeInterval(4 * day))

        // Xcode "Delete transactions": both lists empty, no Transaction.updates event.
        backend.entitlements.withLock { $0 = [] }
        backend.history.withLock { $0 = [] }
        await store.refresh()
        XCTAssertFalse(store.isActive("pro"))
        XCTAssertTrue(store.customer.activeTransactions.isEmpty)
        XCTAssertEqual(backend.historyRequests.current.count, 2)
        await store.refresh()
        XCTAssertEqual(backend.historyRequests.current.count, 2, "nothing changed: no new walk")

        // Gone from currentEntitlements but still in Transaction.all (not anchored): no access, no walk per refresh.
        let other = FakePurchaseBackend()
        other.entitlements.withLock { $0 = [passTx(2, bought: t0.addingTimeInterval(-day))] }
        other.history.withLock { $0 = [passTx(2, bought: t0.addingTimeInterval(-day))] }
        let second = passStore(other)
        await second.refresh()
        XCTAssertTrue(second.isActive("pro"))
        other.entitlements.withLock { $0 = [] }
        await second.refresh()
        await second.refresh()
        XCTAssertFalse(second.isActive("pro"))
        XCTAssertEqual(other.historyRequests.current.count, 2)
    }

    func testRefundedLatestPassIsRemovedAndStackingRecomputed() async {
        let backend = FakePurchaseBackend()
        let first = passTx(1, bought: t0.addingTimeInterval(-2 * day)), latest = passTx(2, bought: t0.addingTimeInterval(-day))
        backend.entitlements.withLock { $0 = [latest] }
        backend.history.withLock { $0 = [first, latest] }
        let store = passStore(backend)
        await store.refresh()
        XCTAssertEqual(store.entitlement(named: "pro")?.expirationDate, t0.addingTimeInterval(4 * day))

        // Refunded without an update reaching the app; StoreKit shows the earlier pass as the latest entitlement.
        backend.entitlements.withLock { $0 = [first] }
        backend.history.withLock { $0 = [first, passTx(2, bought: t0.addingTimeInterval(-day), refunded: true)] }
        await store.refresh()
        XCTAssertEqual(backend.historyRequests.current.count, 2)
        XCTAssertEqual(store.entitlement(named: "pro")?.expirationDate, t0.addingTimeInterval(day))
        XCTAssertEqual(store.entitlement(named: "pro")?.transaction.id, 1)

        // No pass left in currentEntitlements: the whole chain stops counting (documented tradeoff).
        backend.entitlements.withLock { $0 = [] }
        await store.refresh()
        XCTAssertFalse(store.isActive("pro"))
    }

    func testPassBoughtOnAnotherDeviceReloadsTheHistory() async {
        let backend = FakePurchaseBackend()
        backend.entitlements.withLock { $0 = [passTx(2, bought: t0.addingTimeInterval(-day))] }
        backend.history.withLock { $0 = [passTx(1, bought: t0.addingTimeInterval(-2 * day)), passTx(2, bought: t0.addingTimeInterval(-day))] }
        let store = passStore(backend)
        await store.refresh()
        await store.refresh()
        XCTAssertEqual(backend.historyRequests.current.count, 1, "unchanged: the history is not re-read")

        // Bought elsewhere, synced by StoreKit without an update event in this app.
        let third = passTx(3, bought: t0)
        backend.entitlements.withLock { $0 = [third] }
        backend.history.withLock { $0.append(third) }
        await store.refresh()
        XCTAssertEqual(backend.historyRequests.current.count, 2)
        XCTAssertEqual(store.entitlement(named: "pro")?.expirationDate, t0.addingTimeInterval(7 * day))
        await store.refresh()
        XCTAssertEqual(backend.historyRequests.current.count, 2)
    }

    func testPassHistoryRules() {
        let a = passTx(1, bought: t0), b = passTx(2, bought: t0.addingTimeInterval(day)), r = passTx(3, bought: t0.addingTimeInterval(2 * day), refunded: true)
        let lifetime = RevflareTransaction(id: 9, productId: "com.example.lifetime", kind: .nonConsumable, purchaseDate: t0)
        XCTAssertEqual(PassHistoryRules.anchors(productIds: [pass], current: [b, a, r, lifetime]), [pass: 2])
        XCTAssertEqual(PassHistoryRules.anchors(productIds: [pass], current: [lifetime]), [:])
        let other = passTx(4, bought: t0, product: "com.example.pass_week")
        XCTAssertEqual(PassHistoryRules.counted([a, b, r, other], anchors: [pass: 2]).map(\.id), [1, 2])
        XCTAssertEqual(PassHistoryRules.counted([a, b], anchors: [:]), [])
    }

    func testRefreshWhenThePassEnds() async {
        let backend = FakePurchaseBackend()
        backend.entitlements.withLock { $0 = [passTx(1, bought: t0)] }
        backend.history.withLock { $0 = [passTx(1, bought: t0), passTx(2, bought: t0.addingTimeInterval(day))] }
        let clock = Locked(t0.addingTimeInterval(day))
        let sleeps = Locked<[TimeInterval]>([])
        let store = RevflareStore(productIds: [pass], mapping: EntitlementMapping(["pro": [pass]]),
                                  nonRenewingDurations: [pass: .days(3)], backend: backend, productLoader: { _ in [] },
                                  now: { clock.current }, linkPurchases: {}, persistence: MemoryStore(),
                                  sleep: { seconds in
                                      sleeps.withLock { $0.append(seconds) }
                                      clock.withLock { $0 = $0.addingTimeInterval(seconds) }
                                      await Task.yield()
                                  })
        // Stacked: 0 → 3, then 3 → 6. The timer wakes (at most a day at a time) until the chain ends, then access ends.
        await waitUntil { store.hasLoadedEntitlements && !store.isActive("pro") }
        XCTAssertGreaterThanOrEqual(clock.current, t0.addingTimeInterval(6 * day))
        XCTAssertLessThan(clock.current, t0.addingTimeInterval(6 * day + 10))
        XCTAssertTrue(sleeps.current.allSatisfy { $0 <= day })
        XCTAssertGreaterThanOrEqual(sleeps.current.count, 5)
    }
}

extension RevflareOfferings {
    var serverEntitlementsForTests: ServerEntitlements {
        ServerEntitlements(entitlements: entitlements, durations: nonRenewingDurations)
    }
}

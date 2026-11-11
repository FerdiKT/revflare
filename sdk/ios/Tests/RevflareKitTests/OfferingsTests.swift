import Foundation
import XCTest
@testable import RevflareKit

// MARK: Fixtures

private let contractJSON = #"""
{ "version": "e3b0c442",
  "currentOfferingId": "default",
  "offerings": [
    { "identifier": "default", "displayName": "Default", "metadata": { "title": "Go Pro" },
      "packages": [ { "identifier": "$annual", "productId": "com.example.app.annual", "metadata": {} },
                    { "identifier": "$weekly", "productId": "com.example.app.weekly", "metadata": { "badge": "Popular" } } ] },
    { "identifier": "discount", "displayName": "Discount", "metadata": {},
      "packages": [ { "identifier": "$annual", "productId": "com.example.app.annual.discount", "metadata": {} } ] } ],
  "placements": { "onboarding": "default", "settings": null, "sale": "discount" } }
"""#

private func decode(_ json: String) throws -> OfferingsResponse {
    try JSONDecoder().decode(OfferingsResponse.self, from: Data(json.utf8))
}

/// Products are their ids: StoreKit `Product`s can't be made in tests.
private func snapshot(_ json: String = contractJSON, available: Set<String>? = nil) throws -> OfferingsSnapshot<String> {
    let response = try decode(json)
    let ids = available ?? Set(response.productIds)
    return OfferingsSnapshot(response: response, products: Dictionary(uniqueKeysWithValues: ids.map { ($0, $0) }))
}

/// Records catalog calls; knows a fixed set of products.
final class FakeCatalog: ProductCatalog, @unchecked Sendable {
    let known = Locked<Set<String>>([])
    let calls = Locked<[Set<String>]>([])
    let error = Locked<Error?>(nil)

    init(_ known: Set<String>) { self.known.withLock { $0 = known } }

    func products(for ids: Set<String>) async throws -> [String: String] {
        calls.withLock { $0.append(ids) }
        if let error = error.current { throw error }
        let found = ids.intersection(known.current)
        return Dictionary(uniqueKeysWithValues: found.map { ($0, $0) })
    }
}

// MARK: Decoding

final class OfferingsDecodingTests: XCTestCase {
    func testDecodesTheContract() throws {
        let response = try decode(contractJSON)
        XCTAssertEqual(response.version, "e3b0c442")
        XCTAssertEqual(response.currentOfferingId, "default")
        XCTAssertEqual(response.offerings.map(\.identifier), ["default", "discount"])
        let first = response.offerings[0]
        XCTAssertEqual(first.displayName, "Default")
        XCTAssertEqual(first.metadata["title"], .string("Go Pro"))
        XCTAssertEqual(first.packages.map(\.identifier), ["$annual", "$weekly"])
        XCTAssertEqual(first.packages[1].productId, "com.example.app.weekly")
        XCTAssertEqual(first.packages[1].metadata["badge"]?.stringValue, "Popular")
        XCTAssertEqual(response.placements["onboarding"] ?? nil, "default")
        XCTAssertEqual(response.placements.keys.contains("settings"), true)
        XCTAssertNil(response.placements["settings"] ?? nil)
        XCTAssertFalse(response.placements.keys.contains("paywall"))
        XCTAssertEqual(response.productIds, ["com.example.app.annual", "com.example.app.weekly", "com.example.app.annual.discount"])
    }

    func testNullCurrentUnknownFieldsAndMissingOptionals() throws {
        let json = #"""
        { "version": "v2", "currentOfferingId": null, "futureField": { "x": 1 },
          "offerings": [ { "identifier": "a", "kind": "new", "packages": [
              { "identifier": "$monthly", "productId": "com.example.m", "extra": true } ] },
            { "displayName": "missing identifier is skipped" } ] }
        """#
        let response = try decode(json)
        XCTAssertNil(response.currentOfferingId)
        XCTAssertEqual(response.offerings.count, 1)
        XCTAssertEqual(response.offerings[0].displayName, "a")
        XCTAssertEqual(response.offerings[0].metadata, [:])
        XCTAssertEqual(response.offerings[0].packages, [PackagePayload(identifier: "$monthly", productId: "com.example.m")])
        XCTAssertEqual(response.placements, [:])
        XCTAssertNil(try snapshot(json).current)
    }

    func testMetadataOfEveryJSONType() throws {
        let json = #"""
        { "version": "v", "currentOfferingId": "a", "offerings": [ { "identifier": "a", "displayName": "A",
          "metadata": { "title": "Go Pro", "count": 3, "ratio": 0.5, "dark": true, "none": null,
                        "features": ["No ads", 2, false], "theme": { "color": "#FF0000", "radius": 12 } },
          "packages": [] } ], "placements": {} }
        """#
        let metadata = try decode(json).offerings[0].metadata
        XCTAssertEqual(metadata["title"]?.stringValue, "Go Pro")
        XCTAssertEqual(metadata["count"]?.intValue, 3)
        XCTAssertEqual(metadata["count"]?.numberValue, 3)
        XCTAssertEqual(metadata["ratio"]?.numberValue, 0.5)
        XCTAssertNil(metadata["ratio"]?.intValue)
        XCTAssertEqual(metadata["dark"]?.boolValue, true)
        XCTAssertNil(metadata["dark"]?.numberValue)
        XCTAssertEqual(metadata["none"]?.isNull, true)
        XCTAssertEqual(metadata["features"], ["No ads", 2, false])
        XCTAssertEqual(metadata["features"]?[0]?.stringValue, "No ads")
        XCTAssertNil(metadata["features"]?[9])
        XCTAssertEqual(metadata["theme"]?["color"]?.stringValue, "#FF0000")
        XCTAssertEqual(metadata["theme"]?.objectValue?.count, 2)

        struct Theme: Decodable, Equatable { var color: String; var radius: Int }
        struct Paywall: Decodable { var title: String; var count: Int; var dark: Bool; var theme: Theme }
        struct Container: RevflareMetadataContainer { var metadata: [String: RevflareJSON] }
        let container = Container(metadata: metadata)
        XCTAssertEqual(container.metadata("theme", as: Theme.self), Theme(color: "#FF0000", radius: 12))
        XCTAssertEqual(container.metadata("title", as: String.self), "Go Pro")
        XCTAssertEqual(container.metadata("features", as: [RevflareJSON].self)?.count, 3)
        XCTAssertNil(container.metadata("title", as: Int.self))
        XCTAssertNil(container.metadata("missing", as: String.self))
        let paywall = try container.decodeMetadata(Paywall.self)
        XCTAssertEqual(paywall.title, "Go Pro")
        XCTAssertEqual(paywall.count, 3)
        XCTAssertTrue(paywall.dark)
        XCTAssertEqual(paywall.theme.radius, 12)
    }

    func testJSONRoundTrips() throws {
        let value: RevflareJSON = ["a": [1, "two", true, nil, ["b": 2.5]]]
        let data = try JSONEncoder().encode(value)
        XCTAssertEqual(try JSONDecoder().decode(RevflareJSON.self, from: data), value)
    }
}

// MARK: Rules

final class OfferingRulesTests: XCTestCase {
    func testPlacementFallbacks() throws {
        let offerings = try snapshot()
        XCTAssertEqual(offerings.current?.identifier, "default")
        XCTAssertEqual(offerings.offering(forPlacement: "sale")?.identifier, "discount")
        XCTAssertEqual(offerings.offering(forPlacement: "onboarding")?.identifier, "default")
        // null placement → current; unknown placement → current.
        XCTAssertEqual(offerings.offering(forPlacement: "settings")?.identifier, "default")
        XCTAssertEqual(offerings.offering(forPlacement: "nowhere")?.identifier, "default")
    }

    func testPlacementToMissingOfferingAndNoCurrent() {
        let placements: [String: String?] = ["a": "gone", "b": nil, "c": "x"]
        let available: Set<String> = ["x", "y"]
        XCTAssertEqual(OfferingRules.offeringId(forPlacement: "a", placements: placements, current: "y", available: available), "y")
        XCTAssertEqual(OfferingRules.offeringId(forPlacement: "c", placements: placements, current: nil, available: available), "x")
        XCTAssertNil(OfferingRules.offeringId(forPlacement: "b", placements: placements, current: nil, available: available))
        XCTAssertNil(OfferingRules.offeringId(forPlacement: "z", placements: placements, current: "gone", available: available))
    }

    func testPackagesKeepServerOrderAndDropUnavailableProducts() throws {
        let all = try snapshot()
        XCTAssertEqual(all.current?.packages.map(\.identifier), ["$annual", "$weekly"])
        XCTAssertEqual(all.current?.packages.map(\.product), ["com.example.app.annual", "com.example.app.weekly"])
        XCTAssertEqual(all.current?.package(identifier: "$weekly")?.metadata["badge"], "Popular")
        XCTAssertEqual(all.current?.packages.first?.offeringIdentifier, "default")
        XCTAssertTrue(all.droppedProductIds.isEmpty)

        let partial = try snapshot(available: ["com.example.app.weekly"])
        XCTAssertEqual(partial.current?.packages.map(\.identifier), ["$weekly"])
        // The offering stays (its metadata may still matter), just without packages.
        XCTAssertEqual(partial.offering(identifier: "discount")?.packages.count, 0)
        XCTAssertEqual(partial.droppedProductIds, ["com.example.app.annual", "com.example.app.annual.discount"])
    }

    func testStoreMergesOfferingProductIds() {
        XCTAssertEqual(RevflareStore.merge(["b", "a"], adding: ["c", "a", "d", "c"]), ["b", "a", "c", "d"])
        XCTAssertEqual(RevflareStore.merge([], adding: ["x"]), ["x"])
    }
}

// MARK: Fetching, caching, policies

final class OfferingsFetcherTests: XCTestCase {
    private var transport: FakeTransport!
    private var store: MemoryStore!
    private var clock: TestClock!
    private let server = URL(string: "https://revflare.example.com")!

    override func setUp() {
        transport = FakeTransport()
        store = MemoryStore()
        clock = TestClock()
    }

    private func makeFetcher(sdkKey: String = "rfp_test", appVersion: String? = "1.2.3") -> OfferingsFetcher {
        let clock = self.clock!
        return OfferingsFetcher(client: ReportClient(server: server, sdkKey: sdkKey, transport: transport), store: store,
                                appVersion: appVersion, now: { clock.now })
    }

    private func ok(_ body: String = contractJSON, etag: String = "\"e3b0c442\"") -> FakeTransport.Reply {
        .response(200, body, ["ETag": etag, "Cache-Control": "max-age=60"])
    }

    private var offeringRequests: [URLRequest] { transport.requests(to: "/sdk/v1/offerings") }

    func testRequestShape() async throws {
        transport.enqueue(ok())
        let response = try await makeFetcher().offerings(policy: .cachedOrFetched)
        XCTAssertEqual(response.version, "e3b0c442")
        let request = try XCTUnwrap(offeringRequests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.absoluteString, "https://revflare.example.com/sdk/v1/offerings?appVersion=1.2.3")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Revflare-Key"), "rfp_test")
        XCTAssertNil(request.value(forHTTPHeaderField: "If-None-Match"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "User-Agent"), "RevflareKit/\(Revflare.version)")
    }

    func testFreshCacheSkipsTheNetworkThenRevalidatesWithETag() async throws {
        transport.enqueue(ok())
        let fetcher = makeFetcher()
        _ = try await fetcher.offerings(policy: .cachedOrFetched)
        clock.advance(4 * 60)
        _ = try await fetcher.offerings(policy: .cachedOrFetched)
        XCTAssertEqual(offeringRequests.count, 1, "fresh cache: no request")

        clock.advance(2 * 60)
        transport.enqueue(.status(304, ""))
        let revalidated = try await fetcher.offerings(policy: .cachedOrFetched)
        XCTAssertEqual(revalidated.version, "e3b0c442")
        XCTAssertEqual(offeringRequests.count, 2)
        XCTAssertEqual(offeringRequests.last?.value(forHTTPHeaderField: "If-None-Match"), "\"e3b0c442\"")
        // A 304 makes the copy fresh again.
        let entry = await fetcher.cachedEntry
        XCTAssertEqual(entry?.fetchedAt, clock.now)
        _ = try await fetcher.offerings(policy: .cachedOrFetched)
        XCTAssertEqual(offeringRequests.count, 2)
    }

    func testFetchCurrentAlwaysAsks() async throws {
        transport.enqueue(ok(), .status(304, ""))
        let fetcher = makeFetcher()
        _ = try await fetcher.offerings(policy: .fetchCurrent)
        _ = try await fetcher.offerings(policy: .fetchCurrent)
        XCTAssertEqual(offeringRequests.count, 2)
        XCTAssertEqual(offeringRequests.last?.value(forHTTPHeaderField: "If-None-Match"), "\"e3b0c442\"")
    }

    func testNewVersionReplacesTheCache() async throws {
        let updated = contractJSON.replacingOccurrences(of: "e3b0c442", with: "0badc0de")
            .replacingOccurrences(of: #""currentOfferingId": "default""#, with: #""currentOfferingId": "discount""#)
        transport.enqueue(ok(), ok(updated, etag: "\"0badc0de\""))
        let fetcher = makeFetcher()
        _ = try await fetcher.offerings(policy: .fetchCurrent)
        let second = try await fetcher.offerings(policy: .fetchCurrent)
        XCTAssertEqual(second.version, "0badc0de")
        XCTAssertEqual(second.currentOfferingId, "discount")
        let entry = await fetcher.cachedEntry
        XCTAssertEqual(entry?.etag, "\"0badc0de\"")
    }

    func testDiskCacheSurvivesRelaunchAndNetworkFailureFallsBack() async throws {
        transport.enqueue(ok())
        _ = try await makeFetcher().offerings(policy: .cachedOrFetched)

        // Relaunch, an hour later, offline: the stale copy is used for both policies.
        clock.advance(3600)
        transport.defaultReply = .networkError
        let relaunched = makeFetcher()
        let cached = try await relaunched.offerings(policy: .cachedOrFetched)
        XCTAssertEqual(cached.version, "e3b0c442")
        let current = try await relaunched.offerings(policy: .fetchCurrent)
        XCTAssertEqual(current.currentOfferingId, "default")
        XCTAssertEqual(offeringRequests.count, 3)
        XCTAssertEqual(offeringRequests.last?.value(forHTTPHeaderField: "If-None-Match"), "\"e3b0c442\"")

        // Server errors fall back too.
        transport.enqueue(.status(500, "oops"), .status(404, "unknown key"), .status(200, "not json"))
        for _ in 0..<3 {
            let fallback = try await relaunched.offerings(policy: .fetchCurrent)
            XCTAssertEqual(fallback.version, "e3b0c442")
        }
    }

    func testThrowsWithoutCache() async {
        transport.enqueue(.networkError, .status(404, "unknown key"), .status(503, ""), .status(200, "[]"))
        let fetcher = makeFetcher()
        await assertThrows(fetcher, matches: { if case .network = $0 { return true }; return false })
        await assertThrows(fetcher, matches: { $0 == .unknownSDKKey })
        await assertThrows(fetcher, matches: { $0 == .server(status: 503) })
        await assertThrows(fetcher, matches: { if case .invalidResponse = $0 { return true }; return false })
    }

    private func assertThrows(_ fetcher: OfferingsFetcher, matches: (RevflareOfferingsError) -> Bool,
                              file: StaticString = #filePath, line: UInt = #line) async {
        do {
            _ = try await fetcher.offerings(policy: .cachedOrFetched)
            XCTFail("expected an error", file: file, line: line)
        } catch let error as RevflareOfferingsError {
            XCTAssertTrue(matches(error), "unexpected \(error)", file: file, line: line)
        } catch {
            XCTFail("unexpected \(error)", file: file, line: line)
        }
    }

    func testCacheIsScopedToServerAndKey() async throws {
        transport.enqueue(ok())
        _ = try await makeFetcher().offerings(policy: .cachedOrFetched)
        transport.defaultReply = .networkError
        do {
            _ = try await makeFetcher(sdkKey: "rfp_other").offerings(policy: .cachedOrFetched)
            XCTFail("another key must not see this cache")
        } catch {}
        XCTAssertNotEqual(OfferingsFetcher.cacheKey(server: server, sdkKey: "rfp_test"),
                          OfferingsFetcher.cacheKey(server: URL(string: "https://other.example.com")!, sdkKey: "rfp_test"))
    }

    func testAppUpdateMakesTheCacheStale() async throws {
        transport.enqueue(ok(), .status(304, ""))
        _ = try await makeFetcher(appVersion: "1.0").offerings(policy: .cachedOrFetched)
        _ = try await makeFetcher(appVersion: "1.1").offerings(policy: .cachedOrFetched)
        XCTAssertEqual(offeringRequests.count, 2)
        XCTAssertEqual(offeringRequests.last?.url?.query, "appVersion=1.1")
        XCTAssertEqual(offeringRequests.last?.value(forHTTPHeaderField: "If-None-Match"), "\"e3b0c442\"")
    }

    func testETagFallsBackToVersionWhenTheHeaderIsMissing() async throws {
        transport.enqueue(.status(200, contractJSON))
        let fetcher = makeFetcher()
        _ = try await fetcher.offerings(policy: .cachedOrFetched)
        let entry = await fetcher.cachedEntry
        XCTAssertEqual(entry?.etag, "\"e3b0c442\"")
    }

    func testConcurrentCallsShareOneRequest() async throws {
        transport.enqueue(ok())
        let fetcher = makeFetcher()
        async let a = fetcher.offerings(policy: .fetchCurrent)
        async let b = fetcher.offerings(policy: .fetchCurrent)
        let (first, second) = try await (a, b)
        XCTAssertEqual(first, second)
        XCTAssertLessThanOrEqual(offeringRequests.count, 2)
    }
}

// MARK: Products

final class OfferingsServiceTests: XCTestCase {
    func testLoadsAllProductsInOneCallAndCachesThem() async throws {
        let transport = FakeTransport()
        transport.defaultReply = .response(200, contractJSON, ["ETag": "\"e3b0c442\""])
        let fetcher = OfferingsFetcher(client: ReportClient(server: URL(string: "https://revflare.example.com")!,
                                                            sdkKey: "rfp_test", transport: transport),
                                       store: MemoryStore(), appVersion: nil)
        let catalog = FakeCatalog(["com.example.app.annual", "com.example.app.weekly"])
        let service = OfferingsService(fetcher: fetcher, catalog: catalog)

        let first = try await service.offerings(policy: .fetchCurrent)
        XCTAssertEqual(catalog.calls.current, [["com.example.app.annual", "com.example.app.weekly", "com.example.app.annual.discount"]])
        XCTAssertEqual(first.current?.packages.map(\.identifier), ["$annual", "$weekly"])
        XCTAssertEqual(first.offering(forPlacement: "sale")?.packages.count, 0)
        XCTAssertEqual(first.droppedProductIds, ["com.example.app.annual.discount"])

        // Loaded products are kept: only the unavailable one is asked for again.
        _ = try await service.offerings(policy: .fetchCurrent)
        XCTAssertEqual(catalog.calls.current.last, ["com.example.app.annual.discount"])

        // StoreKit failing later keeps what is loaded.
        catalog.error.withLock { $0 = URLError(.notConnectedToInternet) }
        let third = try await service.offerings(policy: .fetchCurrent)
        XCTAssertEqual(third.current?.packages.count, 2)
    }

    func testThrowsWhenNoProductCanBeLoaded() async {
        let transport = FakeTransport()
        transport.defaultReply = .response(200, contractJSON, [:])
        let fetcher = OfferingsFetcher(client: ReportClient(server: URL(string: "https://revflare.example.com")!,
                                                            sdkKey: "rfp_test", transport: transport),
                                       store: MemoryStore(), appVersion: nil)
        let catalog = FakeCatalog([])
        catalog.error.withLock { $0 = URLError(.notConnectedToInternet) }
        let service = OfferingsService(fetcher: fetcher, catalog: catalog)
        do {
            _ = try await service.offerings(policy: .cachedOrFetched)
            XCTFail("expected productsUnavailable")
        } catch let error as RevflareOfferingsError {
            if case .productsUnavailable = error {} else { XCTFail("unexpected \(error)") }
        } catch {
            XCTFail("unexpected \(error)")
        }
    }
}

// MARK: Store

@MainActor
final class StoreOfferingsTests: XCTestCase {
    func testLoadOfferingsErrorIsPublishedAndClassicStoreDoesNotAutoLoad() async {
        let calls = Locked<[OfferingsFetchPolicy]>([])
        let store = RevflareStore(productIds: ["com.example.annual"], mapping: EntitlementMapping(["pro": ["com.example.annual"]]),
                                  backend: FakePurchaseBackend(), productLoader: { _ in [] }, linkPurchases: {},
                                  offeringsLoader: { policy in
                                      calls.withLock { $0.append(policy) }
                                      throw RevflareOfferingsError.notConfigured
                                  })
        for _ in 0..<200 where !store.hasLoadedEntitlements { try? await Task.sleep(nanoseconds: 5_000_000) }
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertTrue(calls.current.isEmpty, "a store made with product ids loads offerings only when asked")

        await store.loadOfferings(fetchPolicy: .fetchCurrent)
        XCTAssertEqual(calls.current, [.fetchCurrent])
        XCTAssertNil(store.offerings)
        XCTAssertNil(store.offering(forPlacement: "onboarding"))
        XCTAssertNotNil(store.offeringsError)
        XCTAssertFalse(store.isLoadingOfferings)
    }

    func testOfferingsStoreLoadsAtStart() async {
        let calls = Locked<[OfferingsFetchPolicy]>([])
        let mapping = EntitlementMapping(["pro": ["com.example.lifetime", "com.example.annual"]])
        let store = RevflareStore(productIds: mapping.allProductIds.sorted(), mapping: mapping,
                                  backend: FakePurchaseBackend(), productLoader: { _ in [] }, linkPurchases: {},
                                  offeringsLoader: { policy in
                                      calls.withLock { $0.append(policy) }
                                      throw RevflareOfferingsError.network("offline")
                                  },
                                  loadsOfferingsAutomatically: true)
        XCTAssertEqual(store.productIds, ["com.example.annual", "com.example.lifetime"])
        for _ in 0..<200 where calls.current.isEmpty { try? await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertEqual(calls.current, [.cachedOrFetched])
        for _ in 0..<200 where store.offeringsError == nil { try? await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertNotNil(store.offeringsError)
    }
}

import Foundation
import XCTest
@testable import RevflareKit

// MARK: Fixtures

private let contractJSON = #"""
{ "version": "a1b2c3d4",
  "values": { "onboarding_version": "v1", "max_free_accounts": 1, "show_discounted_paywall": true,
              "paywall": { "title": "Go Pro", "features": ["No ads", "Sync"] }, "ratio": 0.25, "empty": null },
  "conditions": ["china"], "country": "CN" }
"""#

private let updatedJSON = #"""
{ "version": "b2c3d4e5", "values": { "onboarding_version": "v2" }, "conditions": [], "country": "US" }
"""#

private func ok(_ body: String, etag: String? = nil) -> FakeTransport.Reply {
    var headers = ["Content-Type": "application/json", "Cache-Control": "private, max-age=60"]
    if let etag { headers["ETag"] = etag }
    return .response(200, body, headers)
}

final class FakeContextProvider: RemoteConfigContextProvider, @unchecked Sendable {
    static let installId = UUID(uuidString: "16FD2706-8BAF-433B-82EB-8C7FADA847DA")!
    let value = Locked(RemoteConfigContext(
        installId: FakeContextProvider.installId, appVersion: "2.1", appBuild: "12", osVersion: "18.1",
        locale: "zh_CN", storefront: "CN"
    ))
    let calls = Locked(0)
    func context() async -> RemoteConfigContext {
        calls.withLock { $0 += 1 }
        return value.current
    }
}

/// Answers after a delay.
final class SlowTransport: Transport, @unchecked Sendable {
    let inner: FakeTransport
    let delay: TimeInterval
    init(_ inner: FakeTransport, delay: TimeInterval) {
        self.inner = inner
        self.delay = delay
    }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        return try await inner.send(request)
    }
}

/// One simulated app: the store survives "relaunches" (new RevflareRemoteConfig instances).
@MainActor
final class RemoteConfigHarness {
    let transport = FakeTransport()
    let store = MemoryStore()
    let clock = TestClock()
    let context = FakeContextProvider()
    var server = URL(string: "https://revflare.example.com")!
    var sdkKey = "rfp_test"
    var responseDelay: TimeInterval = 0
    /// `Revflare.analyticsEnabled` as the instances see it.
    var analyticsEnabled = true
    /// Events the instances tracked (name, properties).
    var tracked: [(name: String, props: [String: String])] = []

    func fetcher() -> RemoteConfigFetcher {
        let clock = self.clock
        let transport: Transport = responseDelay > 0 ? SlowTransport(self.transport, delay: responseDelay) : self.transport
        return RemoteConfigFetcher(client: ReportClient(server: server, sdkKey: sdkKey, transport: transport),
                                   contextProvider: context, now: { clock.now })
    }

    /// What `Revflare.configure` does before the instance exists.
    func rememberScope() { RemoteConfigStorage(store: store).rememberScope(fetcher().cacheKey) }

    /// A new launch: a fresh instance reading the store (not started).
    func launch() -> RevflareRemoteConfig {
        let clock = self.clock
        return RevflareRemoteConfig(store: store, now: { clock.now },
                                    analyticsEnabled: { [unowned self] in self.analyticsEnabled },
                                    trackEvent: { [unowned self] in self.tracked.append(($0, $1)) })
    }

    /// A launch with `configure`.
    func configuredLaunch(autoFetch: Bool = false) -> RevflareRemoteConfig {
        rememberScope()
        let config = launch()
        config.autoFetch = autoFetch
        config.start(fetcher())
        return config
    }

    var configRequests: [URLRequest] { transport.requests(to: "/sdk/v1/config") }
}

// MARK: Wire format

final class RemoteConfigDecodingTests: XCTestCase {
    func testDecodesTheContractWithEveryValueType() throws {
        let response = try JSONDecoder().decode(RemoteConfigResponse.self, from: Data(contractJSON.utf8))
        XCTAssertEqual(response.version, "a1b2c3d4")
        XCTAssertEqual(response.values["onboarding_version"], .string("v1"))
        XCTAssertEqual(response.values["max_free_accounts"], .number(1))
        XCTAssertEqual(response.values["show_discounted_paywall"], .bool(true))
        XCTAssertEqual(response.values["ratio"], .number(0.25))
        XCTAssertEqual(response.values["paywall"], ["title": "Go Pro", "features": ["No ads", "Sync"]])
        XCTAssertEqual(response.values["empty"], .null)
        XCTAssertEqual(response.conditions, ["china"])
        XCTAssertEqual(response.country, "CN")
    }

    func testMissingAndUnknownFields() throws {
        let json = #"{ "version": "v9", "values": { "a": "x" }, "country": "", "future": [1, 2] }"#
        let response = try JSONDecoder().decode(RemoteConfigResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response, RemoteConfigResponse(version: "v9", values: ["a": "x"], conditions: [], country: nil))
        let empty = try JSONDecoder().decode(RemoteConfigResponse.self, from: Data("{}".utf8))
        XCTAssertEqual(empty, RemoteConfigResponse(version: "", values: [:]))
    }
}

final class CountryCodeTests: XCTestCase {
    func testAlpha3ToAlpha2() {
        XCTAssertEqual(CountryCode.alpha2("CHN"), "CN")
        XCTAssertEqual(CountryCode.alpha2("USA"), "US")
        XCTAssertEqual(CountryCode.alpha2("TUR"), "TR")
        XCTAssertEqual(CountryCode.alpha2("GBR"), "GB")
        XCTAssertEqual(CountryCode.alpha2("DEU"), "DE")
        XCTAssertEqual(CountryCode.alpha2("JPN"), "JP")
        XCTAssertEqual(CountryCode.alpha2("BRA"), "BR")
        XCTAssertEqual(CountryCode.alpha2("ZWE"), "ZW")
        XCTAssertEqual(CountryCode.alpha2("ABW"), "AW")
        XCTAssertEqual(CountryCode.alpha2("XKS"), "XK")
        XCTAssertEqual(CountryCode.alpha2(" chn "), "CN")
    }

    func testAlpha2PassesThroughAndJunkIsNil() {
        XCTAssertEqual(CountryCode.alpha2("cn"), "CN")
        XCTAssertNil(CountryCode.alpha2("XYZ"))
        XCTAssertNil(CountryCode.alpha2(""))
        XCTAssertNil(CountryCode.alpha2("C1N"))
        XCTAssertNil(CountryCode.alpha2("CHINA"))
    }

    func testTableIsWellFormed() {
        XCTAssertGreaterThanOrEqual(CountryCode.alpha3ToAlpha2.count, 249)
        for (alpha3, alpha2) in CountryCode.alpha3ToAlpha2 {
            XCTAssertEqual(alpha3.count, 3, alpha3)
            XCTAssertEqual(alpha2.count, 2, alpha3)
            XCTAssertTrue((alpha3 + alpha2).allSatisfy { $0.isUppercase }, alpha3)
        }
    }
}

final class RemoteConfigRequestTests: XCTestCase {
    private let context = RemoteConfigContext(
        installId: FakeContextProvider.installId, appVersion: "2.1", appBuild: "12", osVersion: "18.1",
        locale: "zh_CN", storefront: "CN"
    )

    func testRequest() throws {
        let client = ReportClient(server: URL(string: "https://revflare.example.com")!, sdkKey: "rfp_test", transport: FakeTransport())
        let request = client.remoteConfigRequest(context: context, etag: "\"a1b2c3d4\"")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.absoluteString,
                       "https://revflare.example.com/sdk/v1/config?installId=16fd2706-8baf-433b-82eb-8c7fada847da"
                        + "&appVersion=2.1&appBuild=12&osVersion=18.1&locale=zh_CN&storefront=CN&source=unknown&sdk=\(Revflare.version)")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Revflare-Key"), "rfp_test")
        XCTAssertEqual(request.value(forHTTPHeaderField: "If-None-Match"), "\"a1b2c3d4\"")
        XCTAssertEqual(request.value(forHTTPHeaderField: "User-Agent"), "RevflareKit/\(Revflare.version)")
        XCTAssertNil(request.httpBody)
    }

    func testStorefrontOmittedWhenUnknownAndNoEtag() {
        var context = self.context
        context.storefront = nil
        let client = ReportClient(server: URL(string: "https://revflare.example.com")!, sdkKey: "rfp_test", transport: FakeTransport())
        let request = client.remoteConfigRequest(context: context, etag: nil)
        let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.map(\.name), ["installId", "appVersion", "appBuild", "osVersion", "locale", "source", "sdk"])
        XCTAssertNil(request.value(forHTTPHeaderField: "If-None-Match"))
    }

    func testFingerprintIgnoresInstallIdButNotTargetedFields() {
        var other = context
        other.installId = UUID()
        XCTAssertEqual(other.fingerprint, context.fingerprint)
        other.storefront = "US"
        XCTAssertNotEqual(other.fingerprint, context.fingerprint)
        other = context
        other.appVersion = "2.2"
        XCTAssertNotEqual(other.fingerprint, context.fingerprint)
    }

    func testVersion() {
        XCTAssertEqual(Revflare.version, "1.9.2")
    }
}

// MARK: Conversions

final class RemoteConfigValueTests: XCTestCase {
    func testString() {
        XCTAssertEqual(RemoteConfigValue.string("v1"), "v1")
        XCTAssertEqual(RemoteConfigValue.string(1), "1")
        XCTAssertEqual(RemoteConfigValue.string(2.5), "2.5")
        XCTAssertEqual(RemoteConfigValue.string(-3), "-3")
        XCTAssertEqual(RemoteConfigValue.string(true), "true")
        XCTAssertEqual(RemoteConfigValue.string(["b": 1, "a": "x/y"]), #"{"a":"x/y","b":1}"#)
        XCTAssertEqual(RemoteConfigValue.string([1, "two"]), #"[1,"two"]"#)
        XCTAssertNil(RemoteConfigValue.string(.null))
    }

    func testBool() {
        XCTAssertEqual(RemoteConfigValue.bool(true), true)
        for text in ["true", "TRUE", "yes", "on", "1", " True "] { XCTAssertEqual(RemoteConfigValue.bool(.string(text)), true, text) }
        for text in ["false", "No", "off", "0", ""] { XCTAssertEqual(RemoteConfigValue.bool(.string(text)), false, text) }
        XCTAssertNil(RemoteConfigValue.bool("maybe"))
        XCTAssertEqual(RemoteConfigValue.bool(2), true)
        XCTAssertEqual(RemoteConfigValue.bool(0), false)
        XCTAssertNil(RemoteConfigValue.bool(["a": 1]))
    }

    func testNumbers() {
        XCTAssertEqual(RemoteConfigValue.int(3), 3)
        XCTAssertEqual(RemoteConfigValue.int(2.9), 2)
        XCTAssertEqual(RemoteConfigValue.int(-2.9), -2)
        XCTAssertEqual(RemoteConfigValue.int("42"), 42)
        XCTAssertEqual(RemoteConfigValue.int("4.5"), 4)
        XCTAssertEqual(RemoteConfigValue.int(true), 1)
        XCTAssertNil(RemoteConfigValue.int("many"))
        XCTAssertNil(RemoteConfigValue.int(1e30))
        XCTAssertEqual(RemoteConfigValue.double(0.25), 0.25)
        XCTAssertEqual(RemoteConfigValue.double(" 3.5 "), 3.5)
        XCTAssertEqual(RemoteConfigValue.double(false), 0)
        XCTAssertNil(RemoteConfigValue.double("nan"))
        XCTAssertNil(RemoteConfigValue.double([1]))
    }

    private struct Paywall: Decodable, Equatable {
        var title: String
        var features: [String]
    }

    func testDecodeFromJSONAndFromAStringHoldingJSON() {
        let json: RevflareJSON = ["title": "Go Pro", "features": ["No ads"]]
        XCTAssertEqual(RemoteConfigValue.decode(json, as: Paywall.self), Paywall(title: "Go Pro", features: ["No ads"]))
        let text: RevflareJSON = .string(#"{"title":"Go Pro","features":["No ads"]}"#)
        XCTAssertEqual(RemoteConfigValue.decode(text, as: Paywall.self), Paywall(title: "Go Pro", features: ["No ads"]))
        XCTAssertEqual(RemoteConfigValue.decode(text, as: String.self), #"{"title":"Go Pro","features":["No ads"]}"#)
        XCTAssertNil(RemoteConfigValue.decode("nope", as: Paywall.self))
    }

    func testDefaultsFromAny() {
        XCTAssertEqual(RemoteConfigValue.json(from: true), .bool(true))
        XCTAssertEqual(RemoteConfigValue.json(from: 1), .number(1))
        XCTAssertEqual(RemoteConfigValue.json(from: 0), .number(0))
        XCTAssertEqual(RemoteConfigValue.json(from: 2.5), .number(2.5))
        XCTAssertEqual(RemoteConfigValue.json(from: Float(1.5)), .number(1.5))
        XCTAssertEqual(RemoteConfigValue.json(from: "x"), .string("x"))
        XCTAssertEqual(RemoteConfigValue.json(from: NSNumber(value: true)), .bool(true))
        XCTAssertEqual(RemoteConfigValue.json(from: NSNumber(value: 1)), .number(1))
        XCTAssertEqual(RemoteConfigValue.json(from: ["a": [1, true, "s"]] as [String: Any]), ["a": [1, true, "s"]])
        XCTAssertEqual(RemoteConfigValue.json(from: RevflareJSON.string("j")), .string("j"))
        XCTAssertEqual(RemoteConfigValue.json(from: URL(string: "https://example.com")!), .string("https://example.com"))
        XCTAssertNil(RemoteConfigValue.json(from: Date()))
        XCTAssertNil(RemoteConfigValue.json(from: ["a": Date()] as [String: Any]))
    }
}

// MARK: RevflareRemoteConfig

@MainActor
final class RemoteConfigTests: XCTestCase {
    func testGettersPreferRemoteThenDefaultsThenStatic() async {
        let app = RemoteConfigHarness()
        app.transport.enqueue(ok(contractJSON, etag: "\"a1b2c3d4\""))
        let config = app.configuredLaunch()
        config.setDefaults([
            "onboarding_version": "v0", "max_free_accounts": 3, "welcome_title": "Hello", "ratio": "not a number",
            "show_discounted_paywall": false, "empty": "fallback",
        ])
        XCTAssertEqual(config.string("onboarding_version"), "v0")
        XCTAssertEqual(config.source(for: "onboarding_version"), .default)

        let fetched = await config.fetchAndActivate()
        XCTAssertTrue(fetched)
        XCTAssertEqual(config.string("onboarding_version"), "v1")
        XCTAssertEqual(config.source(for: "onboarding_version"), .remote)
        XCTAssertEqual(config.int("max_free_accounts"), 1)
        XCTAssertEqual(config.bool("show_discounted_paywall"), true)
        XCTAssertEqual(config.double("ratio"), 0.25)
        XCTAssertEqual(config.string("welcome_title"), "Hello")
        XCTAssertEqual(config.source(for: "welcome_title"), .default)
        XCTAssertEqual(config.string("unknown", default: "static"), "static")
        XCTAssertEqual(config.int("unknown", default: 7), 7)
        XCTAssertEqual(config.source(for: "unknown"), .static)
        // A remote null is no value.
        XCTAssertEqual(config.string("empty"), "fallback")
        XCTAssertEqual(config.source(for: "empty"), .default)
        // Type mismatches convert, or fall back.
        XCTAssertEqual(config.string("max_free_accounts"), "1")
        XCTAssertEqual(config.string("show_discounted_paywall"), "true")
        XCTAssertEqual(config.int("onboarding_version", default: 9), 9)
        XCTAssertEqual(config.string("paywall"), #"{"features":["No ads","Sync"],"title":"Go Pro"}"#)
        XCTAssertEqual(config["paywall"]?["title"]?.stringValue, "Go Pro")
        XCTAssertEqual(config.json("paywall")?["features"]?[1], "Sync")
        XCTAssertEqual(config.decode("paywall", as: [String: RevflareJSON].self)?["title"], "Go Pro")
        XCTAssertNil(config.decode("onboarding_version", as: Int.self))
        XCTAssertEqual(config.conditions, ["china"])
        XCTAssertEqual(config.country, "CN")
        XCTAssertEqual(config.version, "a1b2c3d4")
        XCTAssertEqual(config.lastFetchStatus, .success)
        XCTAssertEqual(config.lastFetchDate, app.clock.now)
        XCTAssertTrue(config.allKeys.contains("welcome_title") && config.allKeys.contains("paywall"))
    }

    func testBoolDefaultFromStringAndMismatchFallsBackToTheDefault() async {
        let app = RemoteConfigHarness()
        app.transport.enqueue(ok(#"{ "version": "v", "values": { "flag": "true", "limit": "abc" } }"#))
        let config = app.configuredLaunch()
        config.setDefaults(["limit": 5])
        await config.fetchAndActivate()
        XCTAssertTrue(config.bool("flag"))
        XCTAssertEqual(config.int("limit"), 5)
        XCTAssertEqual(config.source(for: "limit"), .remote)
    }

    func testSetDefaultsReplacesAndIgnoresUnsupported() {
        let config = RemoteConfigHarness().launch()
        config.setDefaults(["a": 1, "b": Date()])
        XCTAssertEqual(config.int("a"), 1)
        XCTAssertNil(config.json("b"))
        config.setDefaults(["c": true])
        XCTAssertNil(config.json("a"))
        XCTAssertTrue(config.bool("c"))
        XCTAssertFalse(config.setDefaults(plistNamed: "NoSuchDefaults"))
    }

    func testValuesPersistAndApplyAtLaunchOffline() async {
        let app = RemoteConfigHarness()
        app.transport.enqueue(ok(contractJSON, etag: "\"a1b2c3d4\""))
        let first = app.configuredLaunch()
        await first.fetchAndActivate()
        let fetchDate = app.clock.now

        // Next launch, offline: values are there on first access, before configure.
        app.clock.advance(86_400)
        app.transport.defaultReply = .networkError
        let second = app.launch()
        XCTAssertTrue(second.isLoaded)
        XCTAssertEqual(second.string("onboarding_version"), "v1")
        XCTAssertEqual(second.conditions, ["china"])
        XCTAssertEqual(second.country, "CN")
        XCTAssertEqual(second.version, "a1b2c3d4")
        XCTAssertEqual(second.lastFetchDate, fetchDate)
        XCTAssertEqual(second.lastFetchStatus, .never)

        // The fetch fails: cached values stay.
        second.autoFetch = false
        second.start(app.fetcher())
        let fetched = await second.fetchAndActivate()
        XCTAssertFalse(fetched)
        XCTAssertEqual(second.lastFetchStatus, .failure)
        XCTAssertEqual(second.string("onboarding_version"), "v1")
        XCTAssertEqual(second.lastFetchDate, fetchDate)
    }

    func testEtagAnd304() async {
        let app = RemoteConfigHarness()
        app.transport.enqueue(ok(contractJSON, etag: "\"a1b2c3d4\""), .status(304, ""))
        let config = app.configuredLaunch()
        await config.fetchAndActivate()
        XCTAssertNil(app.configRequests[0].value(forHTTPHeaderField: "If-None-Match"))

        app.clock.advance(120)
        let status = await config.fetch()
        XCTAssertEqual(status, .success)
        XCTAssertEqual(app.configRequests[1].value(forHTTPHeaderField: "If-None-Match"), "\"a1b2c3d4\"")
        XCTAssertFalse(config.activate())
        XCTAssertEqual(config.string("onboarding_version"), "v1")
        XCTAssertEqual(config.lastFetchDate, app.clock.now)
        XCTAssertEqual(config.storedState.active?.fetchedAt, app.clock.now)
    }

    func testEtagFromVersionWhenTheHeaderIsMissing() async {
        let app = RemoteConfigHarness()
        app.transport.enqueue(.status(200, contractJSON))
        let config = app.configuredLaunch()
        await config.fetchAndActivate()
        XCTAssertEqual(config.storedState.active?.etag, "\"a1b2c3d4\"")
    }

    func testChangedContextSendsNoEtag() async {
        let app = RemoteConfigHarness()
        app.transport.enqueue(ok(contractJSON, etag: "\"a1b2c3d4\""), ok(updatedJSON, etag: "\"b2c3d4e5\""))
        let config = app.configuredLaunch()
        await config.fetchAndActivate()
        app.context.value.withLock { $0.storefront = "US" }
        await config.fetchAndActivate()
        XCTAssertNil(app.configRequests[1].value(forHTTPHeaderField: "If-None-Match"))
        XCTAssertTrue(app.configRequests[1].url!.query!.contains("storefront=US"))
        XCTAssertEqual(config.string("onboarding_version"), "v2")
        XCTAssertEqual(config.country, "US")
    }

    func testFailuresKeepTheCachedValues() async {
        let app = RemoteConfigHarness()
        app.transport.enqueue(ok(contractJSON, etag: "\"a1b2c3d4\""), .status(500, "boom"), .status(429, ""),
                              .status(404, "unknown key"), .status(200, "not json"), .networkError)
        let config = app.configuredLaunch()
        await config.fetchAndActivate()
        let expected: [RevflareRemoteConfig.FetchStatus] = [.failure, .throttled, .failure, .failure, .failure]
        for status in expected {
            let result = await config.fetchAndActivate()
            XCTAssertFalse(result)
            XCTAssertEqual(config.lastFetchStatus, status)
            XCTAssertEqual(config.string("onboarding_version"), "v1")
            XCTAssertEqual(config.version, "a1b2c3d4")
        }
        XCTAssertEqual(config.storedState.active?.etag, "\"a1b2c3d4\"")
    }

    func testTimeoutReturnsFalseAndTheLateAnswerIsActivated() async throws {
        let app = RemoteConfigHarness()
        app.responseDelay = 0.4
        app.transport.enqueue(ok(contractJSON, etag: "\"a1b2c3d4\""))
        let config = app.configuredLaunch()
        config.setDefaults(["onboarding_version": "v0"])
        let started = Date()
        let fetched = await config.fetchAndActivate(timeout: 0.05)
        XCTAssertFalse(fetched)
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.35)
        XCTAssertEqual(config.string("onboarding_version"), "v0")
        XCTAssertFalse(config.isLoaded)

        // A second call joins the same request.
        let joined = await config.fetchAndActivate(timeout: 5)
        XCTAssertTrue(joined)
        XCTAssertEqual(app.configRequests.count, 1)
        XCTAssertEqual(config.string("onboarding_version"), "v1")
        XCTAssertTrue(config.isLoaded)
    }

    func testLateAnswerActivatesWithoutAnotherCall() async throws {
        let app = RemoteConfigHarness()
        app.responseDelay = 0.2
        app.transport.enqueue(ok(contractJSON))
        let config = app.configuredLaunch()
        let fetched = await config.fetchAndActivate(timeout: 0.01)
        XCTAssertFalse(fetched)
        try await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertEqual(config.string("onboarding_version"), "v1")
        XCTAssertEqual(config.lastFetchStatus, .success)
    }

    func testIsLoaded() async {
        let app = RemoteConfigHarness()
        // No cache, not configured.
        let config = app.launch()
        XCTAssertFalse(config.isLoaded)
        let notConfigured = await config.fetch()
        XCTAssertEqual(notConfigured, .failure)
        XCTAssertFalse(config.isLoaded)
        XCTAssertEqual(config.lastFetchStatus, .never)

        // Configured without auto fetch: still waiting.
        app.rememberScope()
        config.autoFetch = false
        config.start(app.fetcher())
        XCTAssertFalse(config.isLoaded)
        XCTAssertTrue(app.configRequests.isEmpty)

        // A failed first attempt also ends the wait.
        app.transport.enqueue(.networkError)
        await config.fetchAndActivate()
        XCTAssertTrue(config.isLoaded)
        XCTAssertEqual(config.lastFetchStatus, .failure)
    }

    func testAutoFetchAtStart() async {
        let app = RemoteConfigHarness()
        app.transport.enqueue(ok(contractJSON))
        let config = app.configuredLaunch(autoFetch: true)
        // A splash awaiting fetchAndActivate shares the automatic request.
        await config.fetchAndActivate()
        XCTAssertEqual(app.configRequests.count, 1)
        XCTAssertEqual(config.string("onboarding_version"), "v1")
        XCTAssertTrue(config.isLoaded)
    }

    func testFetchThenActivateOnNextLaunch() async {
        let app = RemoteConfigHarness()
        app.transport.enqueue(ok(contractJSON, etag: "\"a1b2c3d4\""), ok(updatedJSON, etag: "\"b2c3d4e5\""), .status(304, ""))
        let first = app.configuredLaunch()
        await first.fetchAndActivate()

        // Fetched, not applied in this run.
        let status = await first.fetch()
        XCTAssertEqual(status, .success)
        XCTAssertEqual(first.string("onboarding_version"), "v1")
        XCTAssertNotNil(first.storedState.pending)

        // Next launch: the old values first, the fetched ones after activate().
        let second = app.configuredLaunch()
        XCTAssertEqual(second.string("onboarding_version"), "v1")
        // A revalidation uses the newest (pending) ETag and keeps it pending.
        await second.fetch()
        XCTAssertEqual(app.configRequests.last?.value(forHTTPHeaderField: "If-None-Match"), "\"b2c3d4e5\"")
        XCTAssertEqual(second.string("onboarding_version"), "v1")
        XCTAssertTrue(second.activate())
        XCTAssertEqual(second.string("onboarding_version"), "v2")
        XCTAssertEqual(second.version, "b2c3d4e5")
        XCTAssertFalse(second.activate())

        let third = app.launch()
        XCTAssertEqual(third.string("onboarding_version"), "v2")
    }

    func testForegroundRefetchHonoursTheMinimumInterval() async {
        let app = RemoteConfigHarness()
        app.transport.enqueue(ok(contractJSON, etag: "\"a1b2c3d4\""), ok(updatedJSON, etag: "\"b2c3d4e5\""))
        let config = app.configuredLaunch(autoFetch: true)
        await config.fetchAndActivate()
        XCTAssertEqual(app.configRequests.count, 1)

        app.clock.advance(10 * 60)
        await config.foregroundRefresh()
        XCTAssertEqual(app.configRequests.count, 1)

        app.clock.advance(60 * 60)
        await config.foregroundRefresh()
        XCTAssertEqual(app.configRequests.count, 2)
        XCTAssertEqual(config.string("onboarding_version"), "v2")

        // A shorter interval, then a context change, refetch sooner.
        app.transport.enqueue(.status(304, ""), ok(contractJSON))
        config.minimumFetchInterval = 0
        await config.foregroundRefresh()
        XCTAssertEqual(app.configRequests.count, 3)
        config.minimumFetchInterval = 3600
        app.context.value.withLock { $0.appVersion = "2.2" }
        await config.foregroundRefresh()
        XCTAssertEqual(app.configRequests.count, 4)

        // Not with autoFetch off.
        config.autoFetch = false
        config.minimumFetchInterval = 0
        await config.foregroundRefresh()
        XCTAssertEqual(app.configRequests.count, 4)
    }

    func testValuesAreScopedToServerAndKey() async {
        let app = RemoteConfigHarness()
        app.transport.enqueue(ok(contractJSON))
        let first = app.configuredLaunch()
        await first.fetchAndActivate()

        app.sdkKey = "rfp_other"
        let other = app.configuredLaunch()
        XCTAssertNil(other.json("onboarding_version"))
        XCTAssertFalse(other.isLoaded)
        XCTAssertNil(other.version)

        app.sdkKey = "rfp_test"
        XCTAssertEqual(app.configuredLaunch().string("onboarding_version"), "v1")
    }
}

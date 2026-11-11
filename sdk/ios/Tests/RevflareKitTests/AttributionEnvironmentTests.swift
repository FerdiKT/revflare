import Foundation
import XCTest
@testable import RevflareKit

private func reply(_ json: String) -> FakeTransport.Reply { .status(200, json) }
private let pendingUnknown = #"{"ok":true,"attribution":"pending","source":"unknown","campaignId":null,"adGroupId":null,"keywordId":null}"#
private let resolvedAds = #"{"ok":true,"attribution":"resolved","source":"apple_ads","campaignId":"123","adGroupId":"456","keywordId":"789"}"#
private let resolvedOrganic = #"{"ok":true,"attribution":"resolved","source":"organic","campaignId":null,"adGroupId":null,"keywordId":null}"#

// MARK: Report response

final class ReportResponseTests: XCTestCase {
    func testDecodesTheNewShape() throws {
        let response = try JSONDecoder().decode(ReportResponse.self, from: Data(resolvedAds.utf8))
        XCTAssertEqual(response, ReportResponse(ok: true, attribution: "resolved", source: "apple_ads", campaignId: "123",
                                                adGroupId: "456", keywordId: "789"))
        let unknown = try JSONDecoder().decode(ReportResponse.self, from: Data(pendingUnknown.utf8))
        XCTAssertEqual(unknown.source, "unknown")
        XCTAssertNil(unknown.campaignId)
    }

    func testDecodesTheOldShapeAndNumericIds() throws {
        let old = try JSONDecoder().decode(ReportResponse.self, from: Data(#"{"ok":true,"attribution":"pending"}"#.utf8))
        XCTAssertEqual(old, ReportResponse(ok: true, attribution: "pending"))
        let numeric = try JSONDecoder().decode(ReportResponse.self,
                                               from: Data(#"{"source":"apple_ads","campaignId":123,"keywordId":""}"#.utf8))
        XCTAssertEqual(numeric.campaignId, "123")
        XCTAssertNil(numeric.keywordId)
    }

    func testOldStateDecodesWithoutTheNewFields() throws {
        let old = #"{"server":"https://revflare.example.com","attribution":"pending","failures":0,"reportedTransactionIds":[]}"#
        let state = try JSONDecoder().decode(ReporterState.self, from: Data(old.utf8))
        XCTAssertEqual(state.attribution, .pending)
        XCTAssertNil(state.source)
        XCTAssertNil(state.pollCount)
        XCTAssertNil(state.nextPollAt)
        XCTAssertEqual(state.publicAttribution, .unknown)
        // And the new fields survive a round trip.
        var updated = state
        updated.source = "apple_ads"
        updated.campaignId = "123"
        let decoded = try JSONDecoder().decode(ReporterState.self, from: JSONEncoder().encode(updated))
        XCTAssertEqual(decoded.publicAttribution, RevflareAttribution(source: .appleAds, campaignId: "123"))
    }

    func testPublicAttributionOfLocalPhases() {
        XCTAssertEqual(ReporterState(attribution: .expired).publicAttribution.source, .organic)
        XCTAssertEqual(ReporterState(attribution: .waiting).publicAttribution.source, .unknown)
        // Ids only for Apple Ads.
        var state = ReporterState(attribution: .resolved)
        state.source = "organic"
        state.campaignId = "123"
        XCTAssertEqual(state.publicAttribution, RevflareAttribution(source: .organic))
    }
}

// MARK: Polling until resolved

final class AttributionPollingTests: XCTestCase {
    func testPollsWithoutTokenUntilResolved() async {
        let h = Harness()
        h.environment = "production"
        h.transport.enqueue(reply(pendingUnknown), reply(pendingUnknown), reply(resolvedAds))
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        var state = await reporter.snapshot
        XCTAssertEqual(state.source, "unknown")
        XCTAssertEqual(state.nextPollAt, h.clock.now.addingTimeInterval(60))
        XCTAssertEqual(h.firstReports.current, 1)

        // Too early.
        h.clock.advance(30)
        await reporter.sync(.retry)
        XCTAssertEqual(h.transport.bodies.count, 1)

        // 1 minute: still unknown, next in 5.
        h.clock.advance(31)
        await reporter.sync(.retry)
        XCTAssertEqual(h.transport.bodies.count, 2)
        state = await reporter.snapshot
        XCTAssertEqual(state.nextPollAt, h.clock.now.addingTimeInterval(5 * 60))

        h.clock.advance(5 * 60)
        await reporter.sync(.retry)
        XCTAssertEqual(h.transport.bodies.count, 3)
        // Token-less polls carry only the install id (and the environment).
        let poll = h.transport.requests(to: "/sdk/v1/report").last!
        let json = try? JSONSerialization.jsonObject(with: poll.httpBody!) as? [String: String]
        XCTAssertEqual(json, ["installId": h.identity.resolve().id.uuidString.lowercased(), "environment": "production"])

        state = await reporter.snapshot
        XCTAssertEqual(state.attribution, .resolved)
        XCTAssertNil(state.nextPollAt)
        let attribution = await reporter.attribution
        XCTAssertEqual(attribution, RevflareAttribution(source: .appleAds, campaignId: "123", adGroupId: "456", keywordId: "789"))
        XCTAssertEqual(h.attributionChanges.current, [attribution])

        // Resolved: no more reports, also on later launches.
        h.clock.advance(3 * 3600)
        await h.makeReporter().sync(.launch)
        XCTAssertEqual(h.transport.bodies.count, 3)
        XCTAssertEqual(h.firstReports.current, 2)
    }

    func testScheduleThenStopsAfter24Hours() async {
        XCTAssertEqual((0..<6).map { Reporter.pollDelay(polls: $0) }, [60, 300, 900, 3600, 10800, 10800])
        let h = Harness()
        h.transport.defaultReply = reply(pendingUnknown)
        await h.makeReporter().sync(.launch)
        // Launch passes at every due time.
        for _ in 0..<40 {
            h.clock.advance(3 * 3600)
            await h.makeReporter().sync(.launch)
        }
        let bodies = h.transport.bodies
        XCTAssertEqual(bodies.filter { $0.attributionToken != nil }.count, 1)
        // Launches at 3, 6, ... 21 h poll (7), none from 24 h on.
        XCTAssertEqual(bodies.count, 1 + 7)
        let reporter = h.makeReporter()
        let state = await reporter.snapshot
        XCTAssertNil(state.nextPollAt)
        let attribution = await reporter.attribution
        XCTAssertEqual(attribution, .unknown)
    }

    func testOrganicStopsAtOnceAndOldServerResolvedStops() async {
        let h = Harness()
        h.transport.enqueue(reply(resolvedOrganic))
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        let attribution = await reporter.attribution
        XCTAssertEqual(attribution, RevflareAttribution(source: .organic))
        XCTAssertEqual(h.attributionChanges.current, [RevflareAttribution(source: .organic)])
        h.clock.advance(3600)
        await h.makeReporter().sync(.launch)
        XCTAssertEqual(h.transport.bodies.count, 1)

        let old = Harness()
        old.transport.enqueue(reply(#"{"ok":true,"attribution":"resolved"}"#))
        await old.makeReporter().sync(.launch)
        old.clock.advance(3600)
        await old.makeReporter().sync(.launch)
        XCTAssertEqual(old.transport.bodies.count, 1)
    }

    func testStateFromBeforeOneEightAsksOnceEvenWhenOld() async {
        let h = Harness()
        let old = #"{"server":"https://revflare.example.com","attribution":"resolved","failures":0,"firstAttemptAt":0,"reportedTransactionIds":[]}"#
        h.store.set(Data(old.utf8), forKey: Reporter.stateKey)
        h.transport.enqueue(reply(resolvedAds))
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        XCTAssertEqual(h.transport.bodies.map(\.attributionToken), [nil])
        let attribution = await reporter.attribution
        XCTAssertEqual(attribution.source, .appleAds)
        await h.makeReporter().sync(.launch)
        XCTAssertEqual(h.transport.bodies.count, 1)
    }

    func testNetworkErrorWhilePollingBacksOffWithoutAdvancingTheSchedule() async {
        let h = Harness()
        h.transport.enqueue(reply(pendingUnknown), .networkError, .networkError, reply(pendingUnknown), reply(resolvedOrganic))
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        var state = await reporter.snapshot
        XCTAssertEqual(state.pollCount, 0)
        // First poll (due after 1 minute) fails: retried after the failure backoff, the poll not counted.
        h.clock.advance(61)
        await reporter.sync(.retry)
        state = await reporter.snapshot
        XCTAssertEqual(state.pollCount, 0)
        XCTAssertEqual(state.failures, 1)
        XCTAssertEqual(state.nextPollAt, h.clock.now.addingTimeInterval(Reporter.backoff(failures: 1)))
        // Fails again: the backoff grows.
        h.clock.advance(61)
        await reporter.sync(.retry)
        state = await reporter.snapshot
        XCTAssertEqual(state.pollCount, 0)
        XCTAssertEqual(state.failures, 2)
        XCTAssertEqual(state.nextPollAt, h.clock.now.addingTimeInterval(Reporter.backoff(failures: 2)))
        // Answered (still unknown): counted as the first poll, next on the schedule (5 minutes), failures cleared.
        h.clock.advance(121)
        await reporter.sync(.retry)
        state = await reporter.snapshot
        XCTAssertEqual(state.pollCount, 1)
        XCTAssertEqual(state.failures, 0)
        XCTAssertEqual(state.nextPollAt, h.clock.now.addingTimeInterval(300))
        h.clock.advance(301)
        await reporter.sync(.retry)
        state = await reporter.snapshot
        XCTAssertEqual(state.pollCount, 2)
        XCTAssertEqual(state.source, "organic")
        XCTAssertNil(state.nextPollAt)
        XCTAssertEqual(h.transport.bodies.count, 5)
    }
}

// MARK: First-launch gate

final class AttributionGateTests: XCTestCase {
    func testOpenWithExistingStateClosedOnFirstLaunch() {
        let store = MemoryStore()
        XCTAssertFalse(AttributionGate(store: store).isOpen)
        store.set(Data("{}".utf8), forKey: Reporter.stateKey)
        XCTAssertTrue(AttributionGate(store: store).isOpen)
        XCTAssertEqual(AttributionGate.defaultTimeout, 3)
    }

    func testWaitReturnsWhenOpened() async {
        let gate = AttributionGate(open: false)
        let started = Date()
        Task {
            try? await Task.sleep(nanoseconds: 100_000_000)
            gate.open()
        }
        await gate.wait(timeout: 5)
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
        XCTAssertTrue(gate.isOpen)
    }

    func testWaitIsCappedAndOnlyOnce() async {
        let gate = AttributionGate(open: false)
        let started = Date()
        await gate.wait(timeout: 0.2)
        let waited = Date().timeIntervalSince(started)
        XCTAssertGreaterThanOrEqual(waited, 0.15)
        XCTAssertLessThan(waited, 2)
        // Timed out: later fetches don't wait.
        XCTAssertTrue(gate.isOpen)
        let again = Date()
        await gate.wait(timeout: 5)
        XCTAssertLessThan(Date().timeIntervalSince(again), 0.1)
    }

    func testOpenGateDoesNotWait() async {
        let started = Date()
        await AttributionGate(open: true).wait(timeout: 5)
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.1)
    }

    /// The real context provider waits on the gate before reading the attribution.
    func testContextProviderReadsAttributionAfterTheGate() async {
        let gate = AttributionGate(open: false)
        let current = Locked(RevflareAttribution.unknown)
        let provider = SystemRemoteConfigContextProvider(
            identity: InstallIdentity(secure: MemorySecureStore(), defaults: MemoryStore()),
            gate: gate,
            attribution: { current.current },
            environment: { "sandbox" }
        )
        Task {
            try? await Task.sleep(nanoseconds: 100_000_000)
            current.withLock { $0 = RevflareAttribution(source: .organic) }
            gate.open()
        }
        let context = await provider.context()
        XCTAssertEqual(context.attribution.source, .organic)
        XCTAssertEqual(context.environment, "sandbox")
    }
}

// MARK: Remote config

final class AttributionRemoteConfigTests: XCTestCase {
    private let base = RemoteConfigContext(
        installId: FakeContextProvider.installId, appVersion: "2.1", appBuild: "12", osVersion: "18.1",
        locale: "zh_CN", storefront: "CN"
    )

    func testQueryCarriesSourceIdsAndEnvironment() {
        var context = base
        context.attribution = RevflareAttribution(source: .appleAds, campaignId: "123", adGroupId: "456", keywordId: "789")
        context.environment = "sandbox"
        let client = ReportClient(server: URL(string: "https://revflare.example.com")!, sdkKey: "rfp_test", transport: FakeTransport())
        let request = client.remoteConfigRequest(context: context, etag: nil)
        XCTAssertEqual(request.url?.absoluteString,
                       "https://revflare.example.com/sdk/v1/config?installId=16fd2706-8baf-433b-82eb-8c7fada847da"
                        + "&appVersion=2.1&appBuild=12&osVersion=18.1&locale=zh_CN&storefront=CN&source=apple_ads"
                        + "&campaign=123&adGroup=456&keyword=789&environment=sandbox&sdk=\(Revflare.version)")

        // Organic / unknown: no ids.
        context.attribution = RevflareAttribution(source: .unknown)
        let items = URLComponents(url: client.remoteConfigRequest(context: context, etag: nil).url!,
                                  resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.first { $0.name == "source" }?.value, "unknown")
        XCTAssertFalse(items.contains { ["campaign", "adGroup", "keyword"].contains($0.name) })
    }

    func testFingerprintCoversAttributionAndEnvironment() {
        var other = base
        other.attribution = RevflareAttribution(source: .organic)
        XCTAssertNotEqual(other.fingerprint, base.fingerprint)
        var ads = base
        ads.attribution = RevflareAttribution(source: .appleAds, campaignId: "1")
        var ads2 = ads
        ads2.attribution = RevflareAttribution(source: .appleAds, campaignId: "2")
        XCTAssertNotEqual(ads.fingerprint, ads2.fingerprint)
        var env = base
        env.environment = "xcode"
        XCTAssertNotEqual(env.fingerprint, base.fingerprint)
    }

    @MainActor
    func testAttributionChangeRefetchesIntoPendingOnly() async {
        let app = RemoteConfigHarness()
        app.transport.enqueue(
            .response(200, #"{"version":"a","values":{"paywall":"soft"},"conditions":[]}"#, [:]),
            .response(200, #"{"version":"b","values":{"paywall":"hard"},"conditions":["apple_ads"]}"#, [:])
        )
        let config = app.configuredLaunch(autoFetch: true)
        await config.fetchAndActivate()
        XCTAssertEqual(config.string("paywall"), "soft")

        // The reporter learns the source.
        let ads = RevflareAttribution(source: .appleAds, campaignId: "123")
        app.context.value.withLock { $0.attribution = ads }
        await config.attributionChanged(ads)
        XCTAssertEqual(config.attribution, ads)
        XCTAssertEqual(app.configRequests.count, 2)
        let items = URLComponents(url: app.configRequests.last!.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.first { $0.name == "source" }?.value, "apple_ads")
        XCTAssertEqual(items.first { $0.name == "campaign" }?.value, "123")
        // Fetched, not applied mid-screen.
        XCTAssertEqual(config.string("paywall"), "soft")
        XCTAssertNotNil(config.storedState.pending)

        // The same attribution again: nothing to fetch.
        await config.attributionChanged(ads)
        XCTAssertEqual(app.configRequests.count, 2)

        // The next foreground (autoFetch) applies them without another request.
        await config.foregroundRefresh()
        XCTAssertEqual(app.configRequests.count, 2)
        XCTAssertEqual(config.string("paywall"), "hard")
    }

    @MainActor
    func testFetchAndActivateBeforeThePaywallApplies() async {
        let app = RemoteConfigHarness()
        app.transport.enqueue(
            .response(200, #"{"version":"a","values":{"paywall":"soft"},"conditions":[]}"#, [:]),
            .response(200, #"{"version":"b","values":{"paywall":"hard"},"conditions":[]}"#, [:]),
            .status(304, "")
        )
        let config = app.configuredLaunch()
        await config.fetchAndActivate()
        let ads = RevflareAttribution(source: .appleAds)
        app.context.value.withLock { $0.attribution = ads }
        await config.attributionChanged(ads)
        XCTAssertEqual(config.string("paywall"), "soft")
        await config.fetchAndActivate()
        XCTAssertEqual(config.string("paywall"), "hard")
    }
}

// MARK: Environment

private struct FakeSignals: EnvironmentSignals {
    var isSimulator = false
    var isDebuggerAttached = false
    var transactionEnvironment: RevflareEnvironment?
    var receiptFileName: String? = "receipt"
}

final class EnvironmentDetectionTests: XCTestCase {
    func testMatrix() {
        let cases: [(FakeSignals, RevflareEnvironment)] = [
            (FakeSignals(), .production),
            (FakeSignals(receiptFileName: nil), .production),
            (FakeSignals(isSimulator: true), .xcode),
            (FakeSignals(isSimulator: true, receiptFileName: "sandboxReceipt"), .xcode),
            (FakeSignals(isDebuggerAttached: true), .xcode),
            (FakeSignals(isDebuggerAttached: true, transactionEnvironment: .sandbox), .xcode),
            (FakeSignals(transactionEnvironment: .xcode), .xcode),
            (FakeSignals(transactionEnvironment: .sandbox), .sandbox),
            (FakeSignals(transactionEnvironment: .xcode, receiptFileName: "sandboxReceipt"), .xcode),
            (FakeSignals(transactionEnvironment: .production, receiptFileName: "sandboxReceipt"), .sandbox),
            (FakeSignals(receiptFileName: "sandboxReceipt"), .sandbox),
        ]
        for (index, (signals, expected)) in cases.enumerated() {
            XCTAssertEqual(EnvironmentDetector.detect(signals), expected, "case \(index)")
        }
    }

    func testOverride() {
        let simulator = FakeSignals(isSimulator: true)
        XCTAssertEqual(EnvironmentDetector.resolve(override: .automatic, signals: simulator), .xcode)
        XCTAssertEqual(EnvironmentDetector.resolve(override: .production, signals: simulator), .production)
        XCTAssertEqual(EnvironmentDetector.resolve(override: .sandbox, signals: FakeSignals()), .sandbox)
        XCTAssertEqual(EnvironmentDetector.resolve(override: .xcode, signals: FakeSignals()), .xcode)
    }

    func testRecorderKeepsTheLatest() {
        let previous = TransactionEnvironmentRecorder.seen.current
        defer { TransactionEnvironmentRecorder.seen.withLock { $0 = previous } }
        TransactionEnvironmentRecorder.record(.sandbox)
        XCTAssertEqual(SystemEnvironmentSignals().transactionEnvironment, .sandbox)
    }

    func testResolvedValueIsNeverAutomatic() {
        // `swift test` runs under a test host, never an App Store build.
        XCTAssertNotEqual(Revflare.environment, .automatic)
    }
}

final class EnvironmentBodyTests: XCTestCase {
    private let client = ReportClient(server: URL(string: "https://revflare.example.com")!, sdkKey: "rfp_abc",
                                      transport: FakeTransport(), environment: { "sandbox" })

    private func object(_ request: URLRequest) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
    }

    func testEveryBodyCarriesTheEnvironment() throws {
        let installId = UUID(uuidString: "0F8FAD5B-D9CB-469F-A165-70867728950E")!

        let report = try client.makeRequest(ReportBody(installId: "0f8fad5b-d9cb-469f-a165-70867728950e",
                                                       attributionToken: "tok", appVersion: "2.0"))
        let reportJSON = try XCTUnwrap(String(data: XCTUnwrap(report.httpBody), encoding: .utf8))
        XCTAssertEqual(reportJSON, #"{"appVersion":"2.0","attributionToken":"tok","environment":"sandbox","installId":"0f8fad5b-d9cb-469f-a165-70867728950e"}"#)

        let identifiers = try object(client.makeRequest(
            IdentifiersBody(installId: installId, fbAnonId: nil, device: FakeDeviceIdentifiers().info.current), to: .identifiers))
        XCTAssertEqual(identifiers["environment"] as? String, "sandbox")
        // Explicit nulls stay.
        XCTAssertTrue(identifiers["fbAnonId"] is NSNull)

        let events = try object(client.makeRequest(
            EventsBody(installId: installId, context: Harness.eventsContext, events: []), to: .events))
        XCTAssertEqual(events["environment"] as? String, "sandbox")
        XCTAssertNotNil(events["events"])

        let offer = try object(OfferSignatureClient(client: client).request(
            OfferSignatureRequest(installId: installId, productId: "com.example.annual", offerId: "winback", appAccountToken: nil)))
        XCTAssertEqual(offer["environment"] as? String, "sandbox")
        XCTAssertEqual(offer["offerId"] as? String, "winback")
    }

    func testReporterBodiesCarryIt() async {
        let h = Harness()
        h.environment = "xcode"
        h.transactions.ids.withLock { $0 = ["1000000000000001"] }
        h.collectDeviceIdentifiers()
        await h.makeReporter().sync(.launch)
        let requests = h.transport.requests.current
        XCTAssertEqual(requests.count, 3)
        for request in requests {
            let json = try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
            XCTAssertEqual(json?["environment"] as? String, "xcode", request.url?.path ?? "")
        }
    }
}

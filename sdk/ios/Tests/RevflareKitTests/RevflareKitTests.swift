import Foundation
import XCTest
@testable import RevflareKit

final class InstallIdentityTests: XCTestCase {
    func testCreatesOnceAndStoresInBoth() {
        let secure = MemorySecureStore()
        let defaults = MemoryStore()
        let first = InstallIdentity(secure: secure, defaults: defaults).resolve()
        XCTAssertTrue(first.persisted)
        XCTAssertEqual(secure.stored.current, first.id)
        XCTAssertEqual(defaults.string(forKey: InstallIdentity.defaultsKey), first.id.uuidString)
        // A new launch reads the same id.
        XCTAssertEqual(InstallIdentity(secure: secure, defaults: defaults).resolve().id, first.id)
    }

    func testKeychainSurvivesReinstall() {
        let secure = MemorySecureStore()
        let id = InstallIdentity(secure: secure, defaults: MemoryStore()).resolve().id
        // Reinstall: UserDefaults are gone, the keychain item is not.
        let fresh = MemoryStore()
        XCTAssertEqual(InstallIdentity(secure: secure, defaults: fresh).resolve().id, id)
        XCTAssertEqual(fresh.string(forKey: InstallIdentity.defaultsKey), id.uuidString)
    }

    func testUserDefaultsFallbackRefillsKeychain() {
        let defaults = MemoryStore()
        let id = UUID()
        defaults.set(id.uuidString, forKey: InstallIdentity.defaultsKey)
        let secure = MemorySecureStore()
        XCTAssertEqual(InstallIdentity(secure: secure, defaults: defaults).resolve().id, id)
        XCTAssertEqual(secure.stored.current, id)
    }

    func testLockedKeychainDoesNotInventAPersistentId() {
        let secure = MemorySecureStore()
        secure.isLocked.withLock { $0 = true }
        let identity = InstallIdentity(secure: secure, defaults: MemoryStore())
        let locked = identity.resolve()
        XCTAssertFalse(locked.persisted)
        XCTAssertEqual(secure.writes.current, 0)
        // After unlock, a real id is created and kept.
        secure.isLocked.withLock { $0 = false }
        let unlocked = identity.resolve()
        XCTAssertTrue(unlocked.persisted)
        XCTAssertNotEqual(unlocked.id, locked.id)
        XCTAssertEqual(identity.resolve().id, unlocked.id)
    }

    func testLockedKeychainUsesUserDefaultsCopy() {
        let secure = MemorySecureStore()
        secure.isLocked.withLock { $0 = true }
        let defaults = MemoryStore()
        let id = UUID()
        defaults.set(id.uuidString, forKey: InstallIdentity.defaultsKey)
        let resolved = InstallIdentity(secure: secure, defaults: defaults).resolve()
        XCTAssertEqual(resolved.id, id)
        XCTAssertTrue(resolved.persisted)
    }
}

final class RequestTests: XCTestCase {
    func testRequestShape() throws {
        let client = ReportClient(server: URL(string: "https://revflare.example.com")!, sdkKey: "rfp_abc", transport: FakeTransport())
        let request = try client.makeRequest(ReportBody(installId: "0f8fad5b-d9cb-469f-a165-70867728950e", attributionToken: "tok", appVersion: "2.0"))
        XCTAssertEqual(request.url?.absoluteString, "https://revflare.example.com/sdk/v1/report")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Revflare-Key"), "rfp_abc")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let json = try XCTUnwrap(String(data: XCTUnwrap(request.httpBody), encoding: .utf8))
        // Absent fields are left out, not sent as null.
        XCTAssertEqual(json, #"{"appVersion":"2.0","attributionToken":"tok","installId":"0f8fad5b-d9cb-469f-a165-70867728950e"}"#)
    }

    func testServerWithPath() {
        let client = ReportClient(server: URL(string: "https://example.com/revflare/")!, sdkKey: "k", transport: FakeTransport())
        XCTAssertEqual(client.endpoint.absoluteString, "https://example.com/revflare/sdk/v1/report")
    }

    func testOutcomes() async {
        let transport = FakeTransport()
        let client = ReportClient(server: URL(string: "https://x.test")!, sdkKey: "k", transport: transport)
        let body = ReportBody(installId: UUID().uuidString)
        transport.enqueue(
            .status(200, #"{"ok":true,"attribution":"resolved"}"#),
            .status(404, #"{"error":"Unknown SDK key"}"#),
            .status(503, ""),
            .status(429, ""),
            .networkError,
            .status(200, "not json")
        )
        let first = await client.send(body)
        XCTAssertEqual(first, .accepted(ReportResponse(ok: true, attribution: "resolved")))
        let second = await client.send(body)
        XCTAssertEqual(second, .rejected(status: 404, message: #"{"error":"Unknown SDK key"}"#))
        let third = await client.send(body)
        if case .retryable = third {} else { XCTFail("503 should be retryable") }
        let fourth = await client.send(body)
        if case .retryable = fourth {} else { XCTFail("429 should be retryable") }
        let fifth = await client.send(body)
        if case .retryable = fifth {} else { XCTFail("network errors should be retryable") }
        let sixth = await client.send(body)
        XCTAssertEqual(sixth, .accepted(ReportResponse()))
    }

    func testBackoff() {
        XCTAssertEqual(Reporter.backoff(failures: 1), 60)
        XCTAssertEqual(Reporter.backoff(failures: 2), 120)
        XCTAssertEqual(Reporter.backoff(failures: 5), 960)
        XCTAssertEqual(Reporter.backoff(failures: 30), 6 * 3600)
    }
}

final class AttributionTests: XCTestCase {
    func testSendsTokenOnceAndStopsWhenResolved() async {
        let h = Harness()
        h.transport.enqueue(.status(200, #"{"ok":true,"attribution":"resolved"}"#))
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        let bodies = h.transport.bodies
        XCTAssertEqual(bodies.count, 1)
        XCTAssertEqual(bodies.first?.attributionToken, "token-abcdefghijklmnop")
        XCTAssertEqual(bodies.first?.appVersion, "1.2.3")
        XCTAssertNil(bodies.first?.originalTransactionIds)
        XCTAssertEqual(bodies.first?.installId, h.identity.resolve().id.uuidString.lowercased())
        // The first launch is the install time.
        XCTAssertEqual(bodies.first?.installedAt, 1_800_000_000_000)
        let resolved = await reporter.snapshot.attribution
        XCTAssertEqual(resolved, .resolved)

        // Next launch: nothing more to send.
        h.clock.advance(3600)
        await h.makeReporter().sync(.launch)
        XCTAssertEqual(h.transport.requests.current.count, 1)
    }

    func testPendingIsNotResentButPolledWithoutToken() async {
        let h = Harness()
        await h.makeReporter().sync(.launch)
        h.clock.advance(7200)
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        // The token went once; the next report only asks (old server shape: still pending).
        XCTAssertEqual(h.transport.bodies.map { $0.attributionToken != nil }, [true, false])
        let phase = await reporter.snapshot.attribution
        XCTAssertEqual(phase, .pending)
    }

    func testFailedIsFinal() async {
        let h = Harness()
        h.transport.enqueue(.status(200, #"{"ok":true,"attribution":"failed"}"#))
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        let phase = await reporter.snapshot.attribution
        XCTAssertEqual(phase, .failed)
    }

    func testNetworkErrorBacksOffThenRetries() async {
        let h = Harness()
        h.transport.enqueue(.networkError)
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        var state = await reporter.snapshot
        XCTAssertEqual(state.attribution, .waiting)
        XCTAssertEqual(state.failures, 1)
        XCTAssertEqual(state.nextAttemptAt, h.clock.now.addingTimeInterval(60))

        // Too early: no request.
        h.clock.advance(30)
        await h.makeReporter().sync(.launch)
        XCTAssertEqual(h.transport.requests.current.count, 1)

        // Later launch: retried, accepted.
        h.clock.advance(60)
        let later = h.makeReporter()
        await later.sync(.launch)
        XCTAssertEqual(h.transport.requests.current.count, 2)
        state = await later.snapshot
        XCTAssertEqual(state.attribution, .pending)
        XCTAssertEqual(state.failures, 0)
        XCTAssertNil(state.nextAttemptAt)
    }

    func testGivesUpAfter24Hours() async {
        let h = Harness()
        h.transport.defaultReply = .networkError
        await h.makeReporter().sync(.launch)
        h.clock.advance(6 * 3600)
        await h.makeReporter().sync(.launch)
        XCTAssertEqual(h.transport.requests.current.count, 2)
        h.clock.advance(18 * 3600)
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        XCTAssertEqual(h.transport.requests.current.count, 2)
        let phase = await reporter.snapshot.attribution
        XCTAssertEqual(phase, .expired)
    }

    func testTokenErrorsRetryThreeTimesThenBackOff() async {
        let h = Harness()
        h.tokens.fallback = .error("internal")
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        XCTAssertEqual(h.tokens.calls.current, 3)
        XCTAssertEqual(h.sleeps.current, [5, 5])
        XCTAssertEqual(h.transport.requests.current.count, 0)
        let state = await reporter.snapshot
        XCTAssertEqual(state.failures, 1)
        XCTAssertNotNil(state.nextAttemptAt)
    }

    func testTokenErrorThenSuccess() async {
        let h = Harness()
        h.tokens.enqueue(.error("network"))
        await h.makeReporter().sync(.launch)
        XCTAssertEqual(h.tokens.calls.current, 2)
        XCTAssertEqual(h.transport.bodies.first?.attributionToken, "token-abcdefghijklmnop")
    }

    func testUnavailablePlatformRegistersInstallWithoutToken() async {
        let h = Harness()
        h.tokens.fallback = .unavailable
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        XCTAssertEqual(h.transport.bodies.count, 1)
        XCTAssertNil(h.transport.bodies.first?.attributionToken)
        let phase = await reporter.snapshot.attribution
        XCTAssertEqual(phase, .unavailable)
    }

    func testRejectedKeyWaitsAnHour() async {
        let h = Harness()
        h.transport.enqueue(.status(404, #"{"error":"Unknown SDK key"}"#))
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        let state = await reporter.snapshot
        XCTAssertEqual(state.attribution, .waiting)
        XCTAssertEqual(state.nextAttemptAt, h.clock.now.addingTimeInterval(3600))
    }

    func testDeviceLockedWaits() async {
        let h = Harness()
        h.secure.isLocked.withLock { $0 = true }
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        XCTAssertEqual(h.transport.requests.current.count, 0)
        h.secure.isLocked.withLock { $0 = false }
        await reporter.sync(.manual)
        XCTAssertEqual(h.transport.requests.current.count, 1)
    }

    func testOtherServerStartsOver() async {
        let h = Harness()
        h.transport.enqueue(.status(200, #"{"ok":true,"attribution":"resolved"}"#))
        h.transactions.ids.withLock { $0 = ["1000000000000001"] }
        await h.makeReporter().sync(.launch)
        XCTAssertEqual(h.transport.requests.current.count, 2)
        h.server = URL(string: "https://other.example.com")!
        await h.makeReporter().sync(.launch)
        XCTAssertEqual(h.transport.requests.current.count, 4)
        XCTAssertEqual(h.transport.requests.current.last?.url?.host, "other.example.com")
    }
}

final class LinkingTests: XCTestCase {
    private func ids(_ count: Int, from start: Int = 2_000_000_000_000_000) -> Set<String> {
        Set((0..<count).map { String(start + $0) })
    }

    func testBatchesOf90AndRemembersReportedIds() async {
        let h = Harness()
        h.transport.enqueue(.status(200, #"{"ok":true,"attribution":"resolved"}"#))
        h.transactions.ids.withLock { $0 = ids(200) }
        await h.makeReporter().sync(.launch)
        let linkBodies = h.transport.bodies.filter { $0.originalTransactionIds != nil }
        XCTAssertEqual(linkBodies.map { $0.originalTransactionIds?.count }, [90, 90, 20])
        XCTAssertTrue(linkBodies.allSatisfy { $0.attributionToken == nil })
        XCTAssertEqual(Set(linkBodies.flatMap { $0.originalTransactionIds ?? [] }), ids(200))

        // Relaunch with one new purchase: only that one is sent.
        h.transactions.ids.withLock { $0.insert("9000000000000001") }
        await h.makeReporter().sync(.launch)
        let last = h.transport.bodies.last
        XCTAssertEqual(last?.originalTransactionIds, ["9000000000000001"])
        // Link reports carry the first launch too (the server may get them before the token).
        XCTAssertTrue(h.transport.bodies.allSatisfy { $0.installedAt == 1_800_000_000_000 })
        XCTAssertEqual(h.transport.requests.current.count, 5)

        // Nothing new: no request.
        await h.makeReporter().sync(.launch)
        XCTAssertEqual(h.transport.requests.current.count, 5)
    }

    func testFailedBatchIsRetriedLater() async {
        let h = Harness()
        h.transactions.ids.withLock { $0 = ids(100) }
        h.transport.enqueue(
            .status(200, #"{"ok":true,"attribution":"pending"}"#), // token
            .status(200, #"{"ok":true,"attribution":"pending"}"#), // first 90
            .networkError // last 10
        )
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        var state = await reporter.snapshot
        XCTAssertEqual(state.reportedTransactionIds.count, 90)

        // Backing off: a transaction update right away sends nothing.
        await reporter.sync(.transactionUpdate)
        XCTAssertEqual(h.transport.requests.current.count, 3)

        h.clock.advance(61)
        await reporter.sync(.transactionUpdate)
        XCTAssertEqual(h.transport.bodies.last?.originalTransactionIds?.count, 10)
        state = await reporter.snapshot
        XCTAssertEqual(state.reportedTransactionIds, ids(100))
    }

    func testForegroundIsDebounced() async {
        let h = Harness()
        h.transport.defaultReply = .status(200, #"{"ok":true,"attribution":"resolved","source":"organic"}"#)
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        XCTAssertEqual(h.transport.requests.current.count, 1)
        h.transactions.ids.withLock { $0 = ["3000000000000001"] }
        h.clock.advance(10)
        await reporter.sync(.foreground)
        XCTAssertEqual(h.transport.requests.current.count, 1)
        h.clock.advance(60)
        await reporter.sync(.foreground)
        XCTAssertEqual(h.transport.requests.current.count, 2)
    }

    func testConcurrentTriggersCoalesce() async {
        let h = Harness()
        h.transactions.ids.withLock { $0 = ids(5) }
        let reporter = h.makeReporter()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<10 { group.addTask { await reporter.sync(.transactionUpdate) } }
        }
        // Token once, ids once, whatever the interleaving.
        XCTAssertEqual(h.transport.bodies.filter { $0.attributionToken != nil }.count, 1)
        XCTAssertEqual(h.transport.bodies.filter { $0.originalTransactionIds != nil }.count, 1)
    }
}

final class PublicAPITests: XCTestCase {
    func testPurchaseOptionsUseInstallId() {
        XCTAssertEqual(Revflare.purchaseOptions, [.appAccountToken(Revflare.installId)])
        XCTAssertEqual(Revflare.installId, Revflare.installId)
    }

    func testDebugLoggingToggle() {
        Revflare.debugLogging = true
        XCTAssertTrue(Revflare.debugLogging)
        Revflare.debugLogging = false
        XCTAssertFalse(Revflare.debugLogging)
    }
}

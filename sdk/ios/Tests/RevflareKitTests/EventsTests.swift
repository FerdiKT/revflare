import Foundation
import XCTest
import StoreKit
@testable import RevflareKit

// MARK: Fakes

/// Timers that only fire when a test says so.
final class FakeScheduler: EventScheduler, @unchecked Sendable {
    private struct Item {
        let id: Int
        let delay: TimeInterval
        let action: @Sendable () async -> Void
    }

    private let items = Locked<[Item]>([])
    private let counter = Locked(0)
    /// Every delay ever scheduled, in order.
    let scheduled = Locked<[TimeInterval]>([])

    func schedule(after delay: TimeInterval, _ action: @escaping @Sendable () async -> Void) -> ScheduledWork {
        let id = counter.withLock { $0 += 1; return $0 }
        items.withLock { $0.append(Item(id: id, delay: delay, action: action)) }
        scheduled.withLock { $0.append(delay) }
        return ScheduledWork { [items] in items.withLock { $0.removeAll { $0.id == id } } }
    }

    /// Delays of the timers still waiting.
    var pendingDelays: [TimeInterval] { items.current.map(\.delay) }

    /// Fires the oldest waiting timer.
    func fire() async {
        guard let item = items.withLock({ $0.isEmpty ? nil : $0.removeFirst() }) else {
            XCTFail("no timer scheduled")
            return
        }
        await item.action()
    }
}

/// Sequential, recognizable UUIDs.
final class IdMaker: @unchecked Sendable {
    private let counter = Locked(0)
    func next() -> UUID {
        let n = counter.withLock { $0 += 1; return $0 }
        return UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", n))!
    }
}

extension Harness {
    static let eventsContext = EventsContext(appVersion: "1.0", appBuild: "1", osVersion: "18.1", locale: "en_US")

    func makeTracker(storage: EventStorage, scheduler: FakeScheduler, ids: IdMaker = IdMaker()) -> EventTracker {
        let clock = self.clock
        let env = EventsEnvironment(
            storage: storage,
            store: store,
            identity: InstallIdentity(secure: secure, defaults: store),
            context: { Harness.eventsContext },
            scheduler: scheduler,
            now: { clock.now },
            makeId: { ids.next() }
        )
        return EventTracker(client: ReportClient(server: server, sdkKey: sdkKey, transport: transport), environment: env)
    }

    /// Bodies sent to `/sdk/v1/events`, decoded loosely.
    var eventBodies: [[String: Any]] {
        transport.requests(to: "/sdk/v1/events").compactMap { $0.httpBody }
            .compactMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }

    /// Event names of every request sent, in order.
    var sentEventNames: [[String]] {
        eventBodies.map { ($0["events"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String } }
    }
}

private func event(_ name: String, _ props: [String: String] = [:], id: Int = 0, ts: Int64 = 1_800_000_000_000) -> TrackedEvent {
    TrackedEvent(id: String(format: "e0000000-0000-4000-8000-%012d", id), name: name, ts: ts, props: props)
}

private func queued(_ count: Int) -> [QueuedEvent] {
    (0..<count).map {
        QueuedEvent(id: String(format: "q0000000-0000-4000-8000-%012d", $0), name: "screen_view", ts: 1_800_000_000_000 + Int64($0),
                    sessionId: "50000000-0000-4000-8000-000000000001", props: ["screen": "home"])
    }
}

private func temporaryQueueFile() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("revflarekit-tests-\(UUID().uuidString)")
        .appendingPathComponent("events.jsonl")
}

// MARK: Sanitizing

final class EventSanitizerTests: XCTestCase {
    private enum Plan: String { case annual }

    func testValuesBecomeStrings() {
        let optional: String? = "x"
        let none: String? = nil
        XCTAssertEqual(EventSanitizer.props([
            "int": 3, "negative": -12, "double": 2.5, "whole": 2.0, "bool": true, "no": false,
            "nsTrue": NSNumber(value: true), "nsInt": NSNumber(value: 7), "nsDouble": NSNumber(value: 1.5),
        ]), [
            "int": "3", "negative": "-12", "double": "2.5", "whole": "2", "bool": "true", "no": "false",
            "nsTrue": "true", "nsInt": "7", "nsDouble": "1.5",
        ])
        XCTAssertEqual(EventSanitizer.props([
            "uuid": UUID(uuidString: "0F8FAD5B-D9CB-469F-A165-70867728950E")!, "url": URL(string: "https://example.com/a")!,
            "plan": Plan.annual, "optional": optional as Any, "none": none as Any, "int64": Int64(9), "float": Float(0.5),
        ]), [
            "uuid": "0f8fad5b-d9cb-469f-a165-70867728950e", "url": "https://example.com/a", "plan": "annual",
            "optional": "x", "int64": "9", "float": "0.5",
        ])
    }

    func testUnsupportedValuesAndInvalidKeysAreDropped() {
        let props = EventSanitizer.props([
            "list": [1, 2], "dict": ["a": 1], "nan": Double.nan, "infinite": Double.infinity,
            "bad key": "x", "": "x", "ünicode": "x", String(repeating: "k", count: 41): "x",
            "ok.key-1_2": "kept", String(repeating: "k", count: 40): "max",
        ])
        XCTAssertEqual(props, ["ok.key-1_2": "kept", String(repeating: "k", count: 40): "max"])
    }

    func testAtMostTenPropertiesFirstKeysInSortedOrder() {
        var input: [String: Any] = [:]
        for i in 0..<15 { input[String(format: "k%02d", i)] = i }
        let props = EventSanitizer.props(input)
        XCTAssertEqual(props.count, 10)
        XCTAssertEqual(props.keys.sorted(), (0..<10).map { String(format: "k%02d", $0) })
        // Dropped invalid values do not use up the 10 slots.
        input = ["a_bad": [1]]
        for i in 0..<10 { input["k\(i)"] = "v" }
        XCTAssertEqual(EventSanitizer.props(input).count, 10)
    }

    func testValuesAreCutTo100UTF16UnitsWithoutSplittingCharacters() {
        XCTAssertEqual(EventSanitizer.truncate(String(repeating: "a", count: 150)).count, 100)
        XCTAssertEqual(EventSanitizer.truncate(String(repeating: "a", count: 100)).count, 100)
        // "😀" is 2 UTF-16 units: 99 a + 😀 would be 101 units, so the emoji goes.
        let cut = EventSanitizer.truncate(String(repeating: "a", count: 99) + "😀")
        XCTAssertEqual(cut, String(repeating: "a", count: 99))
        XCTAssertLessThanOrEqual(EventSanitizer.truncate(String(repeating: "👍🏽", count: 60)).utf16.count, 100)
    }

    func testNames() {
        for valid in ["paywall_view", "onboarding:step-1.done", "a", String(repeating: "x", count: 64)] {
            XCTAssertTrue(EventSanitizer.isValidName(valid), valid)
        }
        for invalid in ["", "has space", "emoji😀", "ünicode", "slash/name", String(repeating: "x", count: 65)] {
            XCTAssertFalse(EventSanitizer.isValidName(invalid), invalid)
            XCTAssertNil(EventSanitizer.event(name: invalid, properties: [:], at: Date()))
        }
    }

    func testEventCarriesIdAndMilliseconds() throws {
        let id = UUID(uuidString: "0F8FAD5B-D9CB-469F-A165-70867728950E")!
        let tracked = try XCTUnwrap(EventSanitizer.event(name: "export_pdf", properties: ["pages": 3],
                                                         at: Date(timeIntervalSince1970: 1_792_400_000.123), id: id))
        XCTAssertEqual(tracked.id, "0f8fad5b-d9cb-469f-a165-70867728950e")
        XCTAssertEqual(tracked.ts, 1_792_400_000_123)
        XCTAssertEqual(tracked.props, ["pages": "3"])
    }

    func testPaywallProperties() {
        XCTAssertEqual(Revflare.paywallProperties(placement: "onboarding", offeringId: "default") as? [String: String],
                       ["placement": "onboarding", "offering": "default"])
        XCTAssertTrue(Revflare.paywallProperties(placement: nil, offeringId: "").isEmpty)
    }
}

// MARK: Wire format

final class EventsRequestTests: XCTestCase {
    func testExactBodyShape() throws {
        let client = ReportClient(server: URL(string: "https://revflare.example.com")!, sdkKey: "rfp_abc", transport: FakeTransport())
        let body = EventsBody(
            installId: UUID(uuidString: "0F8FAD5B-D9CB-469F-A165-70867728950E")!,
            context: Harness.eventsContext,
            events: [
                QueuedEvent(id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", name: "paywall_view", ts: 1_792_400_000_123,
                            sessionId: "16fd2706-8baf-433b-82eb-8c7fada847da",
                            props: ["placement": "onboarding", "offering": "default"]),
                QueuedEvent(id: "8c9e6679-7425-40de-944b-e07fc1f90ae7", name: "app_open", ts: 1_792_400_000_000,
                            sessionId: "16fd2706-8baf-433b-82eb-8c7fada847da", props: [:]),
            ]
        )
        let request = try client.makeRequest(body, to: .events)
        XCTAssertEqual(request.url?.absoluteString, "https://revflare.example.com/sdk/v1/events")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Revflare-Key"), "rfp_abc")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let json = try XCTUnwrap(String(data: XCTUnwrap(request.httpBody), encoding: .utf8))
        XCTAssertEqual(json, #"{"appBuild":"1","appVersion":"1.0","events":["#
            + #"{"id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","name":"paywall_view","props":{"offering":"default","placement":"onboarding"},"sessionId":"16fd2706-8baf-433b-82eb-8c7fada847da","ts":1792400000123},"#
            + #"{"id":"8c9e6679-7425-40de-944b-e07fc1f90ae7","name":"app_open","props":{},"sessionId":"16fd2706-8baf-433b-82eb-8c7fada847da","ts":1792400000000}],"#
            + #""installId":"0f8fad5b-d9cb-469f-a165-70867728950e","locale":"en_US","osVersion":"18.1"}"#)
    }

    func testOutcomes() async {
        let transport = FakeTransport()
        let client = ReportClient(server: URL(string: "https://revflare.example.com")!, sdkKey: "k", transport: transport)
        let body = EventsBody(installId: UUID(), context: Harness.eventsContext, events: [])
        transport.enqueue(
            .status(200, #"{"ok":true,"accepted":3,"dropped":1}"#),
            .status(400, #"{"error":"bad body"}"#),
            .status(413, ""),
            .response(429, "", ["Retry-After": "120"]),
            .status(503, ""),
            .networkError
        )
        let accepted = await client.sendEvents(body)
        XCTAssertEqual(accepted, .accepted(accepted: 3, dropped: 1))
        let badBody = await client.sendEvents(body)
        XCTAssertEqual(badBody, .rejected(status: 400, message: #"{"error":"bad body"}"#))
        let tooLarge = await client.sendEvents(body)
        XCTAssertEqual(tooLarge, .rejected(status: 413, message: ""))
        let limited = await client.sendEvents(body)
        XCTAssertEqual(limited, .retry(after: 120, message: "HTTP 429"))
        let unavailable = await client.sendEvents(body)
        XCTAssertEqual(unavailable, .retry(after: nil, message: "HTTP 503"))
        if case .retry(nil, _) = await client.sendEvents(body) {} else { XCTFail("network errors are retried") }
        XCTAssertEqual(ReportClient.retryAfterSeconds(" 30 "), 30)
        XCTAssertNil(ReportClient.retryAfterSeconds("Wed, 21 Oct 2026 07:28:00 GMT"))
        XCTAssertNil(ReportClient.retryAfterSeconds("-1"))
    }
}

// MARK: Tracker

final class EventTrackerTests: XCTestCase {
    func testLaunchSendsFirstOpenAppOpenAndSessionStart() async throws {
        let h = Harness()
        let tracker = h.makeTracker(storage: MemoryEventStorage(), scheduler: FakeScheduler())
        await tracker.handle(.launch(h.clock.now, existingInstall: false))
        await tracker.waitForFlush()
        XCTAssertEqual(h.sentEventNames, [["first_open", "app_open", "session_start"]])
        let body = try XCTUnwrap(h.eventBodies.first)
        XCTAssertEqual(body["installId"] as? String, h.identity.resolve().id.uuidString.lowercased())
        XCTAssertEqual(body["appVersion"] as? String, "1.0")
        let events = try XCTUnwrap(body["events"] as? [[String: Any]])
        let session = await tracker.sessionId
        XCTAssertTrue(events.allSatisfy { $0["sessionId"] as? String == session })
        XCTAssertEqual(events.first?["ts"] as? Int64, 1_800_000_000_000)
        let pending = await tracker.pending
        XCTAssertTrue(pending.isEmpty, "deleted after the 200")
    }

    func testFirstOpenOnlyOncePerInstall() async {
        let h = Harness()
        let first = h.makeTracker(storage: MemoryEventStorage(), scheduler: FakeScheduler())
        await first.handle(.launch(h.clock.now, existingInstall: false))
        await first.waitForFlush()
        let second = h.makeTracker(storage: MemoryEventStorage(), scheduler: FakeScheduler())
        await second.handle(.launch(h.clock.now, existingInstall: false))
        await second.waitForFlush()
        XCTAssertEqual(h.sentEventNames, [["first_open", "app_open", "session_start"], ["app_open", "session_start"]])
    }

    func testAppUpdatedFromAnOlderKitGetsNoFirstOpen() async {
        let h = Harness()
        let tracker = h.makeTracker(storage: MemoryEventStorage(), scheduler: FakeScheduler())
        await tracker.handle(.launch(h.clock.now, existingInstall: true))
        await tracker.waitForFlush()
        XCTAssertEqual(h.sentEventNames, [["app_open", "session_start"]])
        XCTAssertEqual(h.store.string(forKey: EventTracker.firstOpenKey), "1")
    }

    func testTimerFlushesPendingEventsEvery30Seconds() async {
        let h = Harness()
        let scheduler = FakeScheduler()
        let tracker = h.makeTracker(storage: MemoryEventStorage(), scheduler: scheduler)
        await tracker.handle(.track(event("onboarding_step", ["step": "1"], id: 1)))
        XCTAssertTrue(h.transport.requests(to: "/sdk/v1/events").isEmpty)
        XCTAssertEqual(scheduler.pendingDelays, [30])
        await tracker.handle(.track(event("onboarding_step", ["step": "2"], id: 2)))
        XCTAssertEqual(scheduler.pendingDelays, [30], "one timer at a time")
        await scheduler.fire()
        await tracker.waitForFlush()
        XCTAssertEqual(h.sentEventNames, [["onboarding_step", "onboarding_step"]])
        XCTAssertTrue(scheduler.pendingDelays.isEmpty, "nothing pending, no timer")
    }

    func testFiftyQueuedEventsFlushAtOnce() async {
        let h = Harness()
        let tracker = h.makeTracker(storage: MemoryEventStorage(), scheduler: FakeScheduler())
        for i in 0..<49 { await tracker.handle(.track(event("tap", id: i))) }
        XCTAssertTrue(h.transport.requests(to: "/sdk/v1/events").isEmpty)
        await tracker.handle(.track(event("tap", id: 49)))
        await tracker.waitForFlush()
        XCTAssertEqual(h.sentEventNames.map(\.count), [50])
    }

    func testBatchesOfAtMost200() async {
        let h = Harness()
        let storage = MemoryEventStorage()
        storage.replace(with: queued(450))
        let tracker = h.makeTracker(storage: storage, scheduler: FakeScheduler())
        await tracker.requestFlush()
        await tracker.waitForFlush()
        XCTAssertEqual(h.sentEventNames.map(\.count), [200, 200, 50])
        XCTAssertTrue(storage.load().isEmpty)
    }

    func testBackgroundRecordsAppBackgroundFlushesAndReportsDone() async throws {
        let h = Harness()
        let tracker = h.makeTracker(storage: MemoryEventStorage(), scheduler: FakeScheduler())
        await tracker.handle(.track(event("export_pdf", id: 1)))
        let done = Locked(false)
        await tracker.handle(.background(h.clock.now, done: { done.withLock { $0 = true } }))
        await tracker.waitForFlush()
        for _ in 0..<200 where !done.current { try await Task.sleep(nanoseconds: 2_000_000) }
        XCTAssertTrue(done.current)
        XCTAssertEqual(h.sentEventNames, [["export_pdf", "app_background"]])
    }

    func testQueueSurvivesRelaunch() async throws {
        let h = Harness()
        let url = temporaryQueueFile()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let first = h.makeTracker(storage: FileEventStorage(url: url), scheduler: FakeScheduler())
        await first.handle(.track(event("onboarding_step", ["step": "1"], id: 1)))
        await first.handle(.track(event("onboarding_step", ["step": "2"], id: 2)))
        let before = await first.pending
        // The app is killed before the timer fires; the next launch finds the queue on disk.
        let relaunched = h.makeTracker(storage: FileEventStorage(url: url), scheduler: FakeScheduler())
        let after = await relaunched.pending
        XCTAssertEqual(after, before)
        XCTAssertEqual(after.map(\.props["step"]), ["1", "2"])
        await relaunched.handle(.launch(h.clock.now, existingInstall: false))
        await relaunched.waitForFlush()
        XCTAssertEqual(h.sentEventNames, [["onboarding_step", "onboarding_step", "first_open", "app_open", "session_start"]])
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "sent: the file is removed")
    }

    func testFileStorageSkipsALineCutShortAndCaps() throws {
        let url = temporaryQueueFile()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let storage = FileEventStorage(url: url)
        storage.append(queued(2))
        // A kill in the middle of a write.
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(#"{"id":"cut","na"#.utf8))
        try handle.close()
        XCTAssertEqual(storage.load().count, 2)
        storage.append(queued(1))
        XCTAssertEqual(FileEventStorage(url: url).load().count, 3, "the damaged line was rewritten away")
        storage.replace(with: queued(1200))
        XCTAssertEqual(storage.load().count, EventTracker.maxQueue)
    }

    func testQueueKeepsTheNewest1000() async {
        let h = Harness()
        h.transport.defaultReply = .networkError
        let storage = MemoryEventStorage()
        storage.replace(with: queued(1000))
        let tracker = h.makeTracker(storage: storage, scheduler: FakeScheduler())
        // Backing off: no request, the queue grows past its cap.
        await tracker.requestFlush()
        await tracker.waitForFlush()
        await tracker.handle(.track(event("newest", id: 1)))
        let pending = await tracker.pending
        XCTAssertEqual(pending.count, 1000)
        XCTAssertEqual(pending.last?.name, "newest")
        XCTAssertEqual(pending.first?.ts, 1_800_000_000_001, "the oldest event was dropped")
        XCTAssertEqual(storage.load().count, 1000)
    }

    func testExponentialBackoffOnNetworkAnd5xx() async {
        let h = Harness()
        let scheduler = FakeScheduler()
        let storage = MemoryEventStorage()
        storage.replace(with: queued(3))
        let tracker = h.makeTracker(storage: storage, scheduler: scheduler)
        h.transport.enqueue(.networkError, .status(503, ""), .status(500, ""))
        await tracker.requestFlush()
        await tracker.waitForFlush()
        var retryAt = await tracker.retryAt
        XCTAssertEqual(retryAt, h.clock.now.addingTimeInterval(5))
        XCTAssertEqual(scheduler.pendingDelays, [5])

        // A flush asked for during the backoff waits for it.
        await tracker.requestFlush()
        await tracker.waitForFlush()
        XCTAssertEqual(h.transport.requests(to: "/sdk/v1/events").count, 1)

        h.clock.advance(5)
        await scheduler.fire()
        await tracker.waitForFlush()
        retryAt = await tracker.retryAt
        XCTAssertEqual(retryAt, h.clock.now.addingTimeInterval(10))
        h.clock.advance(10)
        await scheduler.fire()
        await tracker.waitForFlush()
        retryAt = await tracker.retryAt
        XCTAssertEqual(retryAt, h.clock.now.addingTimeInterval(20))
        let pending = await tracker.pending
        XCTAssertEqual(pending.count, 3, "kept until a 200")

        h.clock.advance(20)
        await scheduler.fire()
        await tracker.waitForFlush()
        let afterSuccess = await tracker.pending
        XCTAssertTrue(afterSuccess.isEmpty)
        retryAt = await tracker.retryAt
        XCTAssertNil(retryAt)
        XCTAssertEqual(h.transport.requests(to: "/sdk/v1/events").count, 4)

        XCTAssertEqual(EventTracker.backoff(failures: 1), 5)
        XCTAssertEqual(EventTracker.backoff(failures: 4), 40)
        XCTAssertEqual(EventTracker.backoff(failures: 30), 600)
    }

    func testRetryAfterIsRespected() async {
        let h = Harness()
        let scheduler = FakeScheduler()
        let storage = MemoryEventStorage()
        storage.replace(with: queued(2))
        let tracker = h.makeTracker(storage: storage, scheduler: scheduler)
        h.transport.enqueue(.response(429, "", ["Retry-After": "120"]))
        await tracker.requestFlush()
        await tracker.waitForFlush()
        let retryAt = await tracker.retryAt
        XCTAssertEqual(retryAt, h.clock.now.addingTimeInterval(120))
        XCTAssertEqual(scheduler.pendingDelays, [120])
        // Too early: the timer is scheduled again for the rest of the wait.
        h.clock.advance(60)
        await scheduler.fire()
        await tracker.waitForFlush()
        XCTAssertEqual(h.transport.requests(to: "/sdk/v1/events").count, 1)
        XCTAssertEqual(scheduler.pendingDelays, [60])
        h.clock.advance(60)
        await scheduler.fire()
        await tracker.waitForFlush()
        XCTAssertEqual(h.transport.requests(to: "/sdk/v1/events").count, 2)
        let pending = await tracker.pending
        XCTAssertTrue(pending.isEmpty)
    }

    func testClientErrorsDropTheBatch() async {
        for status in [400, 404, 413] {
            let h = Harness()
            let storage = MemoryEventStorage()
            storage.replace(with: queued(250))
            let tracker = h.makeTracker(storage: storage, scheduler: FakeScheduler())
            h.transport.enqueue(.status(status, #"{"error":"x"}"#))
            await tracker.requestFlush()
            await tracker.waitForFlush()
            // The refused batch is gone; the next one still went out.
            XCTAssertEqual(h.sentEventNames.map(\.count), [200, 50], "\(status)")
            let pending = await tracker.pending
            XCTAssertTrue(pending.isEmpty, "\(status)")
            let retryAt = await tracker.retryAt
            XCTAssertNil(retryAt, "\(status)")
        }
    }

    func testDisablingDropsTheQueueAndStops() async {
        let h = Harness()
        let scheduler = FakeScheduler()
        let storage = MemoryEventStorage()
        storage.replace(with: queued(5))
        let tracker = h.makeTracker(storage: storage, scheduler: scheduler)
        await tracker.handle(.track(event("tap", id: 1)))
        await tracker.handle(.setEnabled(false))
        var pending = await tracker.pending
        XCTAssertTrue(pending.isEmpty)
        XCTAssertTrue(storage.load().isEmpty)
        XCTAssertTrue(scheduler.pendingDelays.isEmpty, "timer cancelled")
        await tracker.handle(.track(event("tap", id: 2)))
        await tracker.handle(.launch(h.clock.now, existingInstall: false))
        await tracker.handle(.background(h.clock.now, done: nil))
        await tracker.waitForFlush()
        pending = await tracker.pending
        XCTAssertTrue(pending.isEmpty)
        XCTAssertTrue(h.transport.requests(to: "/sdk/v1/events").isEmpty)

        // Back on: events are recorded again.
        await tracker.handle(.setEnabled(true))
        await tracker.handle(.track(event("tap", id: 3)))
        pending = await tracker.pending
        XCTAssertEqual(pending.map(\.name), ["tap"])
    }

    func testDisabledAtLaunchClearsTheStoredQueue() async {
        let h = Harness()
        h.store.set("0", forKey: EventTracker.enabledKey)
        let storage = MemoryEventStorage()
        storage.replace(with: queued(5))
        let tracker = h.makeTracker(storage: storage, scheduler: FakeScheduler())
        let enabled = await tracker.isEnabled
        XCTAssertFalse(enabled)
        XCTAssertTrue(storage.load().isEmpty)
        await tracker.handle(.launch(h.clock.now, existingInstall: false))
        await tracker.waitForFlush()
        XCTAssertTrue(h.transport.requests(to: "/sdk/v1/events").isEmpty)
        XCTAssertNil(h.store.string(forKey: EventTracker.firstOpenKey))
    }

    func testSessionRotatesAfter30MinutesInBackground() async throws {
        let h = Harness()
        let tracker = h.makeTracker(storage: MemoryEventStorage(), scheduler: FakeScheduler())
        await tracker.handle(.launch(h.clock.now, existingInstall: false))
        let first = await tracker.sessionId

        // 29 minutes away: same session, no session_start.
        await tracker.handle(.background(h.clock.now, done: nil))
        h.clock.advance(29 * 60)
        await tracker.handle(.foreground(h.clock.now))
        var session = await tracker.sessionId
        XCTAssertEqual(session, first)

        // 30 minutes away: a new session.
        await tracker.handle(.background(h.clock.now, done: nil))
        h.clock.advance(30 * 60)
        await tracker.handle(.foreground(h.clock.now))
        session = await tracker.sessionId
        XCTAssertNotEqual(session, first)
        await tracker.handle(.track(event("tap", id: 9)))
        await tracker.requestFlush()
        await tracker.waitForFlush()

        let sent = h.eventBodies.flatMap { $0["events"] as? [[String: Any]] ?? [] }
        let names = sent.compactMap { $0["name"] as? String }
        XCTAssertEqual(names, ["first_open", "app_open", "session_start", "app_background", "app_background", "session_start", "tap"])
        XCTAssertEqual(sent.suffix(2).compactMap { $0["sessionId"] as? String }, [session, session])
        XCTAssertTrue(sent.prefix(5).allSatisfy { $0["sessionId"] as? String == first })
    }

    func testLockedDeviceWaits() async {
        let h = Harness()
        h.secure.isLocked.withLock { $0 = true }
        let storage = MemoryEventStorage()
        storage.replace(with: queued(2))
        let tracker = h.makeTracker(storage: storage, scheduler: FakeScheduler())
        await tracker.requestFlush()
        await tracker.waitForFlush()
        XCTAssertTrue(h.transport.requests(to: "/sdk/v1/events").isEmpty)
        let pending = await tracker.pending
        XCTAssertEqual(pending.count, 2)
    }

    func testPipeKeepsOrder() async {
        let pipe = EventPipe(buffer: 10)
        pipe.send(.track(event("a", id: 1)))
        pipe.send(.setEnabled(false))
        pipe.send(.track(event("b", id: 2)))
        var names: [String] = []
        for await command in pipe.stream {
            switch command {
            case .track(let e): names.append(e.name)
            case .setEnabled: names.append("off")
            default: break
            }
            if names.count == 3 { break }
        }
        XCTAssertEqual(names, ["a", "off", "b"])
    }
}

// MARK: RevflareStore purchase events

@MainActor
final class StorePurchaseEventsTests: XCTestCase {
    private var backend: FakePurchaseBackend!
    private var events: Locked<[(String, [String: String])]>!

    override func setUp() async throws {
        backend = FakePurchaseBackend()
        events = Locked([])
    }

    private func makeStore() -> RevflareStore {
        let events = self.events!
        return RevflareStore(productIds: ["com.example.annual"],
                             mapping: EntitlementMapping(["pro": ["com.example.annual"]]),
                             backend: backend, productLoader: { _ in [] },
                             now: { Date(timeIntervalSince1970: 1_800_000_000) }, linkPurchases: {},
                             trackEvent: { name, props in events.withLock { $0.append((name, props)) } },
                             start: false)
    }

    private var names: [String] { events.current.map(\.0) }

    private let context = PurchaseEventContext(productId: "com.example.annual", offering: "default",
                                               package: "$annual", placement: "onboarding")
    private let props = ["product": "com.example.annual", "offering": "default", "package": "$annual",
                         "placement": "onboarding"]

    private func transaction() -> RevflareTransaction {
        RevflareTransaction(id: 10, productId: "com.example.annual", kind: .autoRenewable, subscriptionGroupId: "group1",
                            purchaseDate: Date(timeIntervalSince1970: 1_800_000_000),
                            expirationDate: Date(timeIntervalSince1970: 1_800_000_000 + 365 * 86_400))
    }

    func testSuccess() async throws {
        let store = makeStore()
        let bought = transaction()
        _ = try await store.purchase(productId: bought.productId, context: context) { .completed(backend.event(bought)) }
        XCTAssertEqual(names, ["purchase_start", "purchase_success"])
        XCTAssertEqual(events.current[0].1, props)
        XCTAssertEqual(events.current[1].1, props)
    }

    func testCancelPendingAndProductOnly() async throws {
        let store = makeStore()
        _ = try await store.purchase(productId: "com.example.annual", context: context) { .userCancelled }
        _ = try await store.purchase(productId: "com.example.annual") { .pending }
        XCTAssertEqual(names, ["purchase_start", "purchase_cancel", "purchase_start", "purchase_pending"])
        XCTAssertEqual(events.current[3].1, ["product": "com.example.annual"])
    }

    func testFailures() async {
        let store = makeStore()
        do {
            _ = try await store.purchase(productId: "com.example.annual", context: context) { throw URLError(.notConnectedToInternet) }
            XCTFail("expected an error")
        } catch {}
        do {
            _ = try await store.purchase(productId: "com.example.annual") { .completed(backend.unverifiedEvent()) }
            XCTFail("expected an error")
        } catch {}
        do {
            _ = try await store.purchase(productId: "com.example.annual") { throw StoreKitError.userCancelled }
            XCTFail("expected an error")
        } catch {}
        XCTAssertEqual(names, ["purchase_start", "purchase_failed", "purchase_start", "purchase_failed", "purchase_start", "purchase_cancel"])
        XCTAssertEqual(events.current[1].1, props.merging(["error": "NSURLErrorDomain:-1009"]) { a, _ in a })
        XCTAssertEqual(events.current[3].1["error"], "failed_verification")
        XCTAssertEqual(PurchaseEventContext.errorCode(StoreKitError.networkError(URLError(.timedOut))), "network_error")
        XCTAssertEqual(PurchaseEventContext.errorCode(Product.PurchaseError.purchaseNotAllowed), "purchase_not_allowed")
    }

    func testRestore() async throws {
        let store = makeStore()
        backend.entitlements.withLock { $0 = [self.transaction()] }
        try await store.restore()
        backend.syncError.withLock { $0 = URLError(.userCancelledAuthentication) }
        do {
            try await store.restore()
            XCTFail("expected an error")
        } catch {}
        XCTAssertEqual(names, ["restore_start", "restore_success", "restore_start", "restore_failed"])
        XCTAssertEqual(events.current[1].1, ["entitlements": "pro"])
        XCTAssertEqual(events.current[3].1, ["error": "NSURLErrorDomain:-1012"])
    }
}

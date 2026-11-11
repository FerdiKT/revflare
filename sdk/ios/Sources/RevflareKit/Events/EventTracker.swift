import Foundation

/// What the app tells the tracker, in order.
enum EventCommand: Sendable {
    case track(TrackedEvent)
    /// `configure` ran. `existingInstall`: the app ran an older RevflareKit before (no `first_open` then).
    case launch(Date, existingInstall: Bool)
    case foreground(Date)
    /// The app went to the background; `done` is called once the flush that follows has finished.
    case background(Date, done: (@Sendable () -> Void)?)
    case setEnabled(Bool)
}

/// Carries commands from any thread to the tracker, in order, without blocking the caller. Commands sent before
/// ``Revflare/configure(sdkKey:server:)`` wait in the buffer (the newest 1,000 are kept).
final class EventPipe: Sendable {
    let stream: AsyncStream<EventCommand>
    private let continuation: AsyncStream<EventCommand>.Continuation

    init(buffer: Int = EventTracker.maxQueue) {
        let pair = Self.makeStream(buffer: buffer)
        stream = pair.0
        continuation = pair.1
    }

    private static func makeStream(buffer: Int) -> (AsyncStream<EventCommand>, AsyncStream<EventCommand>.Continuation) {
        var continuation: AsyncStream<EventCommand>.Continuation?
        let stream = AsyncStream<EventCommand>(bufferingPolicy: .bufferingNewest(buffer)) { continuation = $0 }
        return (stream, continuation!)
    }

    func send(_ command: EventCommand) { continuation.yield(command) }
}

/// Injected dependencies (real ones in the app, fakes in tests).
struct EventsEnvironment: Sendable {
    var storage: EventStorage
    var store: KeyValueStore
    var identity: InstallIdentity
    var context: @Sendable () -> EventsContext = { EventsContext.current }
    var scheduler: EventScheduler = TaskEventScheduler()
    var now: @Sendable () -> Date = { Date() }
    var makeId: @Sendable () -> UUID = { UUID() }
}

/// The event queue: sessions, automatic events, persistence and delivery to `POST /sdk/v1/events`.
///
/// Events are kept in a file until the server answers 200 (at most 1,000, the oldest dropped first). Flushes run at
/// launch, every 30 seconds while events are pending, when 50 are queued and when the app goes to the background;
/// each request carries at most 200 events. 429 / 5xx / network errors back off (5 s doubling to 10 min, or the
/// server's `Retry-After`); any other 4xx drops the batch.
actor EventTracker {
    static let maxQueue = 1000
    static let maxBatch = 200
    static let flushThreshold = 50
    static let flushInterval: TimeInterval = 30
    /// A foreground after at least this long in the background starts a new session.
    static let sessionTimeout: TimeInterval = 30 * 60
    static let maxRetryAfter: TimeInterval = 3600

    /// "0" when the app turned analytics off (``Revflare/analyticsEnabled``).
    static let enabledKey = "app.revflare.kit.analyticsEnabled"
    /// "1" once `first_open` was queued for this install.
    static let firstOpenKey = "app.revflare.kit.firstOpen"

    static func isEnabled(store: KeyValueStore) -> Bool { store.string(forKey: enabledKey) != "0" }

    /// Backoff after `failures` consecutive failed flushes: 5, 10, 20... seconds, at most 10 minutes.
    static func backoff(failures: Int) -> TimeInterval {
        let exponent = min(max(failures - 1, 0), 16)
        return min(5 * pow(2, Double(exponent)), 600)
    }

    private let client: ReportClient
    private let env: EventsEnvironment
    private var queue: [QueuedEvent]
    private var enabled: Bool
    private(set) var sessionId: String
    private var backgroundedAt: Date?

    private var failures = 0
    private var nextAttemptAt: Date?
    private var flushTask: Task<Void, Never>?
    private var flushAgain = false
    private var timer: ScheduledWork?
    private var rejectionLogged = false

    init(client: ReportClient, environment: EventsEnvironment) {
        self.client = client
        env = environment
        enabled = Self.isEnabled(store: environment.store)
        if enabled {
            queue = environment.storage.load()
        } else {
            queue = []
            environment.storage.clear()
        }
        sessionId = environment.makeId().uuidString.lowercased()
    }

    /// The queued events (tests and diagnostics).
    var pending: [QueuedEvent] { queue }
    var isEnabled: Bool { enabled }
    /// When the next attempt may run after a failure.
    var retryAt: Date? { nextAttemptAt }

    func handle(_ command: EventCommand) {
        switch command {
        case .track(let event):
            enqueue(event)
        case .launch(let date, let existingInstall):
            guard enabled else { return }
            if env.store.string(forKey: Self.firstOpenKey) != "1" {
                if !existingInstall { enqueue(automatic("first_open", at: date)) }
                env.store.set("1", forKey: Self.firstOpenKey)
            }
            enqueue(automatic("app_open", at: date))
            enqueue(automatic("session_start", at: date))
            requestFlush()
        case .foreground(let date):
            if let since = backgroundedAt, date.timeIntervalSince(since) >= Self.sessionTimeout {
                sessionId = env.makeId().uuidString.lowercased()
                if enabled { enqueue(automatic("session_start", at: date)) }
            }
            backgroundedAt = nil
            scheduleIfPending()
        case .background(let date, let done):
            backgroundedAt = date
            if enabled { enqueue(automatic("app_background", at: date)) }
            requestFlush()
            if let done {
                Task {
                    await self.waitForFlush()
                    done()
                }
            }
        case .setEnabled(let value):
            guard value != enabled else { return }
            enabled = value
            if !value {
                queue = []
                env.storage.clear()
                timer?.cancel()
                timer = nil
                failures = 0
                nextAttemptAt = nil
                Log.debug("Events: analytics off, queue dropped")
            }
        }
    }

    /// Waits until no flush is running (tests; background time).
    func waitForFlush() async {
        while let task = flushTask { await task.value }
    }

    /// Starts a flush now unless one is running (then it goes round once more).
    func requestFlush() {
        guard enabled, !queue.isEmpty else { return }
        if flushTask != nil {
            flushAgain = true
            return
        }
        flushTask = Task { await self.runFlushes() }
    }

    // MARK: Queue

    private func automatic(_ name: String, at date: Date) -> TrackedEvent {
        TrackedEvent(id: env.makeId().uuidString.lowercased(), name: name, ts: EventSanitizer.milliseconds(date), props: [:])
    }

    private func enqueue(_ event: TrackedEvent) {
        guard enabled else { return }
        let queued = QueuedEvent(id: event.id, name: event.name, ts: event.ts, sessionId: sessionId, props: event.props)
        queue.append(queued)
        if queue.count > Self.maxQueue {
            queue.removeFirst(queue.count - Self.maxQueue)
            env.storage.replace(with: queue)
        } else {
            env.storage.append([queued])
        }
        if queue.count >= Self.flushThreshold {
            requestFlush()
        } else {
            scheduleIfPending()
        }
    }

    private func remove(_ ids: Set<String>) {
        queue.removeAll { ids.contains($0.id) }
        env.storage.replace(with: queue)
    }

    // MARK: Delivery

    private func runFlushes() async {
        repeat {
            flushAgain = false
            await flushOnce()
        } while flushAgain && enabled && !queue.isEmpty && !isBackingOff
        flushTask = nil
        scheduleIfPending()
    }

    private var isBackingOff: Bool {
        guard let next = nextAttemptAt else { return false }
        return next > env.now()
    }

    private func flushOnce() async {
        guard enabled, !queue.isEmpty, !isBackingOff else { return }
        let identity = env.identity.resolve()
        guard identity.persisted else {
            Log.debug("Events: install id not readable yet (device locked), sending later")
            return
        }
        let context = env.context()
        while enabled, !queue.isEmpty {
            let batch = Array(queue.prefix(Self.maxBatch))
            let ids = Set(batch.map(\.id))
            switch await client.sendEvents(EventsBody(installId: identity.id, context: context, events: batch)) {
            case .accepted(let accepted, let dropped):
                failures = 0
                nextAttemptAt = nil
                remove(ids)
                Log.debug("Events: sent \(batch.count) (accepted \(accepted.map(String.init) ?? "?"), dropped \(dropped.map(String.init) ?? "?"))")
            case .rejected(let status, let message):
                remove(ids)
                if !rejectionLogged {
                    rejectionLogged = true
                    Log.error("Revflare refused \(batch.count) event(s) (HTTP \(status)): \(message). They were dropped. Check the SDK key.")
                }
            case .retry(let after, let message):
                failures += 1
                let delay = after.map { min(max($0, 1), Self.maxRetryAfter) } ?? Self.backoff(failures: failures)
                nextAttemptAt = env.now().addingTimeInterval(delay)
                Log.debug("Events: sending failed (\(message)), retrying in \(Int(delay)) s")
                schedule(after: delay, replacing: true)
                return
            }
        }
    }

    // MARK: Timer

    /// While events are pending, makes sure a flush is scheduled (30 s, or when the backoff ends).
    private func scheduleIfPending() {
        guard enabled, !queue.isEmpty, timer == nil, flushTask == nil else { return }
        if let next = nextAttemptAt, next > env.now() {
            schedule(after: next.timeIntervalSince(env.now()), replacing: false)
        } else {
            schedule(after: Self.flushInterval, replacing: false)
        }
    }

    private func schedule(after delay: TimeInterval, replacing: Bool) {
        if timer != nil {
            guard replacing else { return }
            timer?.cancel()
        }
        timer = env.scheduler.schedule(after: delay) { [weak self] in
            await self?.timerFired()
        }
    }

    private func timerFired() {
        timer = nil
        guard enabled, !queue.isEmpty else { return }
        if isBackingOff {
            scheduleIfPending()
        } else {
            requestFlush()
        }
    }
}

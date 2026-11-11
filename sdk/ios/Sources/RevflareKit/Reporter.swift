import Foundation

/// Where the attribution token stands for this install.
enum AttributionPhase: String, Codable, Sendable {
    /// Not sent yet (or every attempt so far failed).
    case waiting
    /// The server stored the token and is still asking Apple (it retries on its own; RevflareKit asks again with
    /// token-less reports until it learns the source, see ``ReporterState/nextPollAt``).
    case pending
    /// Apple answered: attributed to a campaign, or organic.
    case resolved
    /// Apple refused the token, or the server gave up.
    case failed
    /// 24 hours passed since the first attempt without the server accepting a token (tokens expire).
    case expired
    /// AdServices is not available on this platform; the install was registered without a token.
    case unavailable

    /// The token needs no more sending.
    var isFinished: Bool { self != .waiting }
}

/// Everything the reporter remembers between launches (one JSON blob in UserDefaults).
struct ReporterState: Codable, Equatable, Sendable {
    /// The server the state belongs to: pointing an app at another server starts over.
    var server: String?
    var attribution: AttributionPhase = .waiting
    /// First attribution attempt: the first launch with RevflareKit (sent as `installedAt`).
    var firstAttemptAt: Date?
    var failures: Int = 0
    var nextAttemptAt: Date?
    /// Original transaction ids the server has accepted for this install.
    var reportedTransactionIds: Set<String> = []
    /// Fingerprint of the last device identifiers the server accepted (``IdentifiersBody/fingerprint``).
    /// Optional so state stored by older versions still decodes.
    var identifiersFingerprint: String?
    /// What the server resolved: `apple_ads`, `organic` or `unknown` (nil: not told yet, or a server before 1.8).
    /// Optional, like everything below, so state stored by older versions still decodes.
    var source: String?
    var campaignId: String?
    var adGroupId: String?
    var keywordId: String?
    /// Token-less reports sent to learn the source while the server says pending / unknown (nil: never asked, state
    /// stored before 1.8).
    var pollCount: Int?
    /// When to ask the server again; nil when there is nothing more to learn.
    var nextPollAt: Date?
}

/// Why a sync runs.
enum SyncTrigger: Sendable, Equatable {
    case launch
    case foreground
    case transactionUpdate
    case manual
    case retry
    /// ``Revflare/setMetaAnonymousID(_:)`` or ``Revflare/collectDeviceIdentifiers()``: re-check the identifiers now,
    /// skipping a network-error backoff.
    case identifiers
}

/// Injected dependencies (real ones in the app, fakes in tests).
struct ReporterEnvironment: Sendable {
    var transport: Transport
    var tokenProvider: AttributionTokenProvider
    var transactions: TransactionSource
    var store: KeyValueStore
    var identity: InstallIdentity
    var appVersion: String?
    var deviceIdentifiers: DeviceIdentifierProvider = SystemDeviceIdentifierProvider()
    var now: @Sendable () -> Date = { Date() }
    /// Called (off the main actor) when what ``Revflare/attribution`` returns changes.
    var onAttributionChange: @Sendable (RevflareAttribution) -> Void = { _ in }
    /// Called once per process, after the first attribution step of the first pass (whatever its outcome).
    var onFirstAttributionReport: @Sendable () -> Void = {}
    var sleep: @Sendable (TimeInterval) async -> Void = { seconds in
        try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }
    /// Schedules a retry inside the running process after a failure (off in tests).
    var retryInSession = true
}

/// The state machine: sends the attribution token once, links original transaction ids in batches, and (only after
/// the app opted in) reports the device identifiers for Meta matching whenever they change. The three paths keep
/// their own state and backoff: a failure in one never holds back the others.
/// All work is serialized: overlapping triggers coalesce into one more pass.
actor Reporter {
    static let stateKey = "app.revflare.kit.state"
    /// The Facebook SDK anonymous id set by ``Revflare/setMetaAnonymousID(_:)``.
    static let metaAnonymousIdKey = "app.revflare.kit.metaAnonymousId"
    /// "1" once the app opted in to device identifiers (``Revflare/collectDeviceIdentifiers()`` or
    /// ``Revflare/setMetaAnonymousID(_:)``).
    static let collectIdentifiersKey = "app.revflare.kit.collectIdentifiers"

    /// Records the app's opt-in (and the Facebook anonymous id, when given).
    static func optIn(store: KeyValueStore, metaAnonymousId: String?) {
        if let metaAnonymousId { store.set(metaAnonymousId, forKey: metaAnonymousIdKey) }
        store.set("1", forKey: collectIdentifiersKey)
    }

    static func isOptedIn(store: KeyValueStore) -> Bool {
        store.string(forKey: collectIdentifiersKey) == "1" || !(store.string(forKey: metaAnonymousIdKey) ?? "").isEmpty
    }
    /// Tokens live 24 hours: after that, stop trying.
    static let tokenLifetime: TimeInterval = 24 * 3600
    /// Foreground triggers closer than this to the previous pass are ignored.
    static let foregroundDebounce: TimeInterval = 60
    /// Apple recommends up to 3 attempts, 5 seconds apart, when `attributionToken()` fails.
    static let tokenAttempts = 3
    static let tokenRetryDelay: TimeInterval = 5
    /// Retries scheduled inside the running process only when they are this close.
    static let maxInSessionRetryDelay: TimeInterval = 15 * 60

    /// Backoff after `failures` consecutive failed attempts: 1, 2, 4, ... minutes, at most 6 hours.
    static func backoff(failures: Int) -> TimeInterval {
        let exponent = min(max(failures - 1, 0), 16)
        return min(60 * pow(2, Double(exponent)), 6 * 3600)
    }

    /// Long pause after the server refused a report (wrong SDK key...): the app needs a new build or the key fixed.
    static let rejectedBackoff: TimeInterval = 3600

    /// Delay before the next token-less report while the source is unknown, after `polls` of them: 1, 5, 15, 60
    /// minutes, then every 3 hours (until 24 hours after the first attempt).
    static func pollDelay(polls: Int) -> TimeInterval {
        let schedule: [TimeInterval] = [60, 5 * 60, 15 * 60, 60 * 60]
        return polls < schedule.count ? schedule[max(polls, 0)] : 3 * 3600
    }

    private let client: ReportClient
    private let env: ReporterEnvironment
    private var state: ReporterState

    private var running = false
    private var rerun = false
    private var lastPassAt: Date?
    private var linkFailures = 0
    private var linkNextAttemptAt: Date?
    private var retryTask: Task<Void, Never>?
    private var identifiersFailures = 0
    private var identifiersNextAttemptAt: Date?
    /// The last identifiers report was refused (4xx): an explicit re-check does not skip that backoff.
    private var identifiersRejected = false
    /// An explicit re-check was asked for (possibly while a pass was running).
    private var identifiersForced = false
    private var firstAttributionReportDone = false

    init(client: ReportClient, environment: ReporterEnvironment) {
        self.client = client
        self.env = environment
        let serverKey = client.server.absoluteString
        var loaded = environment.store.data(forKey: Self.stateKey)
            .flatMap { try? JSONDecoder().decode(ReporterState.self, from: $0) } ?? ReporterState()
        if loaded.server != serverKey { loaded = ReporterState(server: serverKey) }
        self.state = loaded
    }

    /// Current state (for tests and diagnostics).
    var snapshot: ReporterState { state }

    /// What ``Revflare/attribution`` returns.
    var attribution: RevflareAttribution { state.publicAttribution }

    /// Runs a pass now. If one is already running, it returns at once and the running pass goes round once more.
    func sync(_ trigger: SyncTrigger) async {
        if trigger == .identifiers { identifiersForced = true }
        if trigger == .foreground, let last = lastPassAt, env.now().timeIntervalSince(last) < Self.foregroundDebounce {
            Log.debug("Foreground sync skipped (debounced)")
            return
        }
        if running {
            rerun = true
            return
        }
        running = true
        repeat {
            rerun = false
            await pass(trigger)
        } while rerun
        running = false
        lastPassAt = env.now()
    }

    private func pass(_ trigger: SyncTrigger) async {
        let identity = env.identity.resolve()
        guard identity.persisted else {
            Log.debug("Install id not readable yet (device locked): waiting for the next trigger")
            return
        }
        Log.debug("Sync (\(trigger)) for install \(identity.id.uuidString)")
        let before = state.publicAttribution
        if state.attribution.isFinished {
            await pollAttribution(installId: identity.id)
        } else {
            await reportAttribution(installId: identity.id)
        }
        let after = state.publicAttribution
        if after != before {
            Log.debug("Attribution: \(after.source.rawValue)")
            env.onAttributionChange(after)
        }
        if !firstAttributionReportDone {
            firstAttributionReportDone = true
            env.onFirstAttributionReport()
        }
        await linkTransactions(installId: identity.id)
        await reportIdentifiers(installId: identity.id)
    }

    // MARK: Device identifiers (Meta)

    /// Sends the device identifiers when the app opted in and they changed since the server last accepted them.
    private func reportIdentifiers(installId: UUID) async {
        let forced = identifiersForced
        identifiersForced = false
        guard Self.isOptedIn(store: env.store) else { return }
        if forced, !identifiersRejected { identifiersNextAttemptAt = nil }
        if let next = identifiersNextAttemptAt, next > env.now() { return }

        let anonId = env.store.string(forKey: Self.metaAnonymousIdKey).flatMap { $0.isEmpty ? nil : $0 }
        let device = await env.deviceIdentifiers.deviceIdentifiers()
        let body = IdentifiersBody(installId: installId, fbAnonId: anonId, device: device)
        let fingerprint = body.fingerprint
        guard fingerprint != state.identifiersFingerprint else { return }

        // Never log the identifiers themselves.
        Log.debug("Reporting device identifiers (fbAnonId: \(body.fbAnonId == nil ? "none" : "set"), "
            + "IDFA: \(body.idfa == nil ? "none" : "set"), IDFV: \(body.idfv == nil ? "none" : "set"), ATT: \(body.attStatus))")
        switch await client.send(body, to: .identifiers) {
        case .accepted:
            state.identifiersFingerprint = fingerprint
            identifiersFailures = 0
            identifiersNextAttemptAt = nil
            identifiersRejected = false
            save()
            Log.debug("Device identifiers accepted")
        case .rejected(let status, let message):
            Log.error("Revflare refused the device identifiers (HTTP \(status)): \(message)")
            identifiersFailures += 1
            identifiersRejected = true
            identifiersNextAttemptAt = env.now().addingTimeInterval(Self.rejectedBackoff)
        case .retryable(let message):
            Log.debug("Device identifiers report failed: \(message)")
            identifiersFailures += 1
            identifiersRejected = false
            let delay = Self.backoff(failures: identifiersFailures)
            identifiersNextAttemptAt = env.now().addingTimeInterval(delay)
            scheduleRetry(after: delay)
        }
    }

    /// The first sync attempt of this install (its first launch with RevflareKit), sent as the install time.
    private var installedAt: Int64? {
        state.firstAttemptAt.map { Int64(($0.timeIntervalSince1970 * 1000).rounded()) }
    }

    // MARK: Attribution token

    private func reportAttribution(installId: UUID) async {
        let now = env.now()
        if let first = state.firstAttemptAt {
            if now.timeIntervalSince(first) >= Self.tokenLifetime {
                Log.debug("Attribution token: 24 hours passed without success, giving up")
                state.attribution = .expired
                save()
                return
            }
        } else {
            state.firstAttemptAt = now
            save()
        }
        if let next = state.nextAttemptAt, next > now { return }

        var token: String?
        var unavailable = false
        var lastError = ""
        for attempt in 1...Self.tokenAttempts {
            switch await env.tokenProvider.attributionToken() {
            case .token(let value): token = value
            case .unavailable: unavailable = true
            case .error(let message): lastError = message
            }
            if token != nil || unavailable { break }
            if attempt < Self.tokenAttempts { await env.sleep(Self.tokenRetryDelay) }
        }
        if token == nil && !unavailable {
            Log.debug("Attribution token unavailable for now: \(lastError)")
            recordFailure(backoff: nil)
            return
        }

        let body = ReportBody(installId: installId.uuidString.lowercased(), attributionToken: token, appVersion: env.appVersion, installedAt: installedAt)
        let outcome = await client.send(body)
        switch outcome {
        case .accepted(let response):
            state.failures = 0
            state.nextAttemptAt = nil
            if unavailable {
                state.attribution = .unavailable
            } else {
                switch response.attribution {
                case "resolved": state.attribution = .resolved
                case "failed": state.attribution = .failed
                default: state.attribution = .pending
                }
            }
            state.pollCount = 0
            Log.debug("Attribution token accepted: \(response.attribution ?? "?") -> \(state.attribution.rawValue), "
                + "source \(response.source ?? "?")")
            applyResolution(response)
            save()
        case .rejected(let status, let message):
            Log.error("Revflare refused the attribution report (HTTP \(status)): \(message). Check the SDK key.")
            recordFailure(backoff: Self.rejectedBackoff)
        case .retryable(let message):
            Log.debug("Attribution report failed: \(message)")
            recordFailure(backoff: nil)
        }
    }

    // MARK: Attribution resolution

    /// Sources that end the polling.
    private static let finalSources: Set<String> = [
        RevflareAttribution.Source.appleAds.rawValue, RevflareAttribution.Source.organic.rawValue,
    ]

    /// Keeps the source and ids from a report answer and plans the next token-less report when there is more to learn.
    private func applyResolution(_ response: ReportResponse) {
        if let source = response.source {
            state.source = source
            let attributed = source == RevflareAttribution.Source.appleAds.rawValue
            state.campaignId = attributed ? response.campaignId : nil
            state.adGroupId = attributed ? response.adGroupId : nil
            state.keywordId = attributed ? response.keywordId : nil
        }
        let learnMore: Bool
        if let source = state.source, Self.finalSources.contains(source) {
            learnMore = false
        } else if response.source == RevflareAttribution.Source.unknown.rawValue {
            learnMore = true
        } else {
            // A server before 1.8 (no source): only its "pending" can still change.
            learnMore = response.source == nil && response.attribution == "pending"
        }
        state.nextPollAt = learnMore ? env.now().addingTimeInterval(Self.pollDelay(polls: state.pollCount ?? 0)) : nil
        if let next = state.nextPollAt { scheduleRetry(after: next.timeIntervalSince(env.now())) }
    }

    /// While the server says pending / unknown, asks again with a report holding only the install id (the token was
    /// already stored), on the ``pollDelay(polls:)`` schedule, until 24 hours after the first attempt. State stored
    /// before 1.8 (no source, never polled) is asked once whatever its age, so existing installs learn their source.
    private func pollAttribution(installId: UUID) async {
        let now = env.now()
        let migrating = state.pollCount == nil && state.source == nil
            && [.pending, .resolved, .unavailable].contains(state.attribution)
        if migrating {
            state.nextPollAt = state.nextPollAt ?? now
        }
        guard let next = state.nextPollAt else { return }
        if !migrating, let first = state.firstAttemptAt, now.timeIntervalSince(first) >= Self.tokenLifetime {
            Log.debug("Attribution: 24 hours passed without a resolution, no more polling")
            state.nextPollAt = nil
            save()
            return
        }
        guard next <= now else { return }

        let body = ReportBody(installId: installId.uuidString.lowercased())
        let polls = (state.pollCount ?? 0) + 1
        switch await client.send(body) {
        case .accepted(let response):
            // Only answered polls move along the schedule.
            state.pollCount = polls
            state.failures = 0
            switch response.attribution {
            case "resolved" where state.attribution == .pending: state.attribution = .resolved
            case "failed" where state.attribution == .pending: state.attribution = .failed
            default: break
            }
            Log.debug("Attribution poll \(polls): \(response.attribution ?? "?"), source \(response.source ?? "?")")
            applyResolution(response)
            if migrating, response.source == nil {
                // A server before 1.8: nothing to learn from it.
                state.nextPollAt = nil
            }
        case .rejected(let status, let message):
            Log.error("Revflare refused the attribution report (HTTP \(status)): \(message). Check the SDK key.")
            state.nextPollAt = now.addingTimeInterval(Self.rejectedBackoff)
        case .retryable(let message):
            // Network error: the same poll again after the failure backoff (1, 2, 4... minutes); the schedule waits.
            Log.debug("Attribution poll failed: \(message)")
            state.failures += 1
            let delay = Self.backoff(failures: state.failures)
            state.nextPollAt = now.addingTimeInterval(delay)
            scheduleRetry(after: delay)
        }
        save()
    }

    private func recordFailure(backoff fixed: TimeInterval?) {
        state.failures += 1
        let delay = fixed ?? Self.backoff(failures: state.failures)
        state.nextAttemptAt = env.now().addingTimeInterval(delay)
        save()
        scheduleRetry(after: delay)
    }

    // MARK: Transaction links

    private func linkTransactions(installId: UUID) async {
        let now = env.now()
        if let next = linkNextAttemptAt, next > now { return }
        let owned = await env.transactions.originalTransactionIds()
        let unreported = owned.subtracting(state.reportedTransactionIds).sorted()
        guard !unreported.isEmpty else { return }
        Log.debug("Linking \(unreported.count) transaction(s)")
        for start in stride(from: 0, to: unreported.count, by: ReportClient.maxTransactionIdsPerReport) {
            let batch = Array(unreported[start..<min(start + ReportClient.maxTransactionIdsPerReport, unreported.count)])
            let body = ReportBody(installId: installId.uuidString.lowercased(), originalTransactionIds: batch, appVersion: env.appVersion, installedAt: installedAt)
            let outcome = await client.send(body)
            switch outcome {
            case .accepted:
                state.reportedTransactionIds.formUnion(batch)
                linkFailures = 0
                linkNextAttemptAt = nil
                save()
            case .rejected(let status, let message):
                Log.error("Revflare refused the transaction report (HTTP \(status)): \(message). Check the SDK key.")
                linkFailures += 1
                linkNextAttemptAt = env.now().addingTimeInterval(Self.rejectedBackoff)
                return
            case .retryable(let message):
                Log.debug("Transaction report failed: \(message)")
                linkFailures += 1
                let delay = Self.backoff(failures: linkFailures)
                linkNextAttemptAt = env.now().addingTimeInterval(delay)
                scheduleRetry(after: delay)
                return
            }
        }
    }

    // MARK: Persistence and retries

    private func save() {
        guard let data = try? JSONEncoder().encode(state) else { return }
        env.store.set(data, forKey: Self.stateKey)
    }

    private func scheduleRetry(after delay: TimeInterval) {
        guard env.retryInSession, delay <= Self.maxInSessionRetryDelay, retryTask == nil else { return }
        let sleep = env.sleep
        retryTask = Task { [weak self] in
            await sleep(delay + 1)
            await self?.retryFired()
        }
    }

    private func retryFired() async {
        retryTask = nil
        await sync(.retry)
    }
}

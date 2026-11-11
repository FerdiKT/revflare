import Foundation
import Combine

/// Remote config: parameters set in Revflare (web → the app → Remote config), with values the server picks for this
/// device by ordered conditions (country, app version, language, percentage rollout...). Replaces Firebase Remote
/// Config.
///
/// Use the one instance, ``Revflare/remoteConfig``:
///
/// ```swift
/// Revflare.remoteConfig.setDefaults(["onboarding_version": "v1", "max_free_accounts": 1])
/// Revflare.configure(sdkKey: "rfp_…", server: URL(string: "https://revflare.example.com")!)
///
/// let config = Revflare.remoteConfig
/// config.string("onboarding_version")            // "v2" when a condition matched, else the default
/// config.int("max_free_accounts", default: 1)
/// config.decode("paywall", as: PaywallConfig.self)
/// ```
///
/// - The last activated values are kept on the device and applied at once on the next launch (before any request),
///   so the app has them offline.
/// - ``Revflare/configure(sdkKey:server:)`` fetches and activates in the background (``autoFetch``); the app refetches
///   when it comes to the foreground and the values are older than ``minimumFetchInterval``.
/// - Getters never fail: remote value → ``setDefaults(_:)`` value → the `default:` argument.
/// - Requests carry the install's acquisition source (``attribution``) and ``Revflare/environment``, so conditions can
///   target them. When the source becomes known later (Apple can take minutes), RevflareKit refetches at once into the
///   fetched-not-active slot: values on screen never change by themselves. They apply on the next ``activate()`` /
///   ``fetchAndActivate(timeout:)``, the next foreground (with ``autoFetch``) or the next launch. Call
///   `fetchAndActivate` right before showing a screen that depends on the source (a paywall).
@MainActor
public final class RevflareRemoteConfig: ObservableObject {
    /// What came of the last fetch in this run of the app.
    public enum FetchStatus: Sendable, Equatable {
        /// No fetch finished yet in this run.
        case never
        /// The server answered (new values, or 304: unchanged).
        case success
        /// The server could not be reached or answered with an error; cached values or defaults stay in use.
        case failure
        /// The server asked to slow down (HTTP 429); cached values or defaults stay in use.
        case throttled
    }

    /// Where a value comes from.
    public enum ValueSource: Sendable, Equatable {
        /// The server (active values).
        case remote
        /// ``RevflareRemoteConfig/setDefaults(_:)``.
        case `default`
        /// Neither: the getter's `default:` argument.
        case `static`
    }

    /// The status of the last fetch in this run (``FetchStatus/never`` before the first one finishes).
    @Published public private(set) var lastFetchStatus: FetchStatus = .never
    /// When the server last sent or confirmed the values (kept across launches).
    @Published public private(set) var lastFetchDate: Date?
    /// True once values can be relied on for this launch: cached values were applied at start, or the first fetch
    /// attempt finished (whatever its outcome). Show a splash until then if the first screen depends on the config.
    @Published public private(set) var isLoaded = false
    /// Names of the conditions that matched for the active values (handy as analytics properties).
    @Published public private(set) var conditions: [String] = []
    /// The country the server resolved the active values for (App Store storefront, else the IP country), ISO
    /// alpha-2 ("CN"), nil when unknown or before the first fetch.
    @Published public private(set) var country: String?
    /// The version of the active values (changes whenever the configuration changes), nil when none are active.
    @Published public private(set) var version: String?
    /// The running A/B experiments this device is enrolled in, with its variant (set up in Revflare web → the app →
    /// Experiments). Kept with the active values, so available offline. The variant's values are already in the
    /// config: read the parameters as usual.
    ///
    /// Exposure: the first time the app reads (any getter, subscript or ``decode(_:as:)``) a parameter of an
    /// experiment (whatever the value's source: the control may keep the app's default), RevflareKit tracks
    /// `experiment_exposure` (once per install, experiment and variant). Read the parameter where the user actually sees the variant (e.g. when the paywall
    /// appears), not at launch, so only users who saw it count. Apps that branch on ``variant(forExperiment:)`` call
    /// ``trackExposure(experiment:)`` themselves.
    @Published public private(set) var experiments: [RevflareExperiment] = []
    /// The install's acquisition source as RevflareKit knows it now (same as ``Revflare/attribution``), sent with
    /// config requests. ``RevflareAttribution/Source/unknown`` until Revflare resolved it.
    @Published public private(set) var attribution: RevflareAttribution

    @Published private var remoteValues: [String: RevflareJSON] = [:]
    @Published private var defaultValues: [String: RevflareJSON] = [:]

    /// Fetch and activate automatically: at ``Revflare/configure(sdkKey:server:)`` and on foreground (when older than
    /// ``minimumFetchInterval``). Default true. Set it to false **before** `configure` to fetch and activate only when
    /// the app calls ``fetch()`` / ``activate()`` / ``fetchAndActivate(timeout:)``.
    public var autoFetch = true

    /// Foreground refetches happen only when the values are older than this (seconds, default 1 hour). A launch
    /// always fetches (a cheap 304 when nothing changed). Set it to 0 in debug builds to see changes at once.
    public var minimumFetchInterval: TimeInterval = 3600

    private let storage: RemoteConfigStorage
    private let now: @Sendable () -> Date
    private var scope: String?
    private var state = RemoteConfigState()
    private var fetcher: RemoteConfigFetcher?
    private var inFlight: Task<FetchStatus, Never>?
    /// Parameter key → the experiments that change it (active values only).
    private var experimentsByKey: [String: [RevflareExperiment]] = [:]
    /// Not `@Published`: getters update it, also while SwiftUI renders.
    private var exposures: ExperimentExposureStore
    private let analyticsEnabled: () -> Bool
    private let trackEvent: (String, [String: String]) -> Void

    static let exposureEvent = "experiment_exposure"

    init(store: KeyValueStore, now: @escaping @Sendable () -> Date = { Date() },
         analyticsEnabled: @escaping () -> Bool = { Revflare.analyticsEnabled },
         trackEvent: @escaping (String, [String: String]) -> Void = { Revflare.track($0, properties: $1) }) {
        storage = RemoteConfigStorage(store: store)
        exposures = ExperimentExposureStore(store: store)
        self.now = now
        self.analyticsEnabled = analyticsEnabled
        self.trackEvent = trackEvent
        attribution = store.data(forKey: Reporter.stateKey)
            .flatMap { try? JSONDecoder().decode(ReporterState.self, from: $0) }?.publicAttribution ?? .unknown
        // The values of the last configured server + SDK key, available at once (even before `configure`).
        if let scope = storage.lastScope { load(scope: scope) }
    }

    // MARK: Defaults

    /// In-app default values, used for parameters the server did not send (or before any fetch). Replaces the previous
    /// defaults. Values: `String`, `Int`, `Double`, `Bool`, `[String: Any]`, `[Any]` (and ``RevflareJSON``); others are
    /// ignored.
    public func setDefaults(_ defaults: [String: Any]) {
        var values: [String: RevflareJSON] = [:]
        for (key, value) in defaults {
            if let json = RemoteConfigValue.json(from: value) {
                values[key] = json
            } else {
                Log.error("Remote config: default for \"\(key)\" ignored (unsupported type \(type(of: value)))")
            }
        }
        defaultValues = values
    }

    /// Sets the defaults from a property list in the bundle (a dictionary at the root), like Firebase's
    /// `setDefaults(fromPlist:)`. Returns false when the file is missing or unreadable.
    @discardableResult
    public func setDefaults(plistNamed name: String, bundle: Bundle = .main) -> Bool {
        let resource = name.hasSuffix(".plist") ? String(name.dropLast(6)) : name
        guard let url = bundle.url(forResource: resource, withExtension: "plist"),
              let dictionary = NSDictionary(contentsOf: url) as? [String: Any] else {
            Log.error("Remote config: no defaults plist named \(name)")
            return false
        }
        setDefaults(dictionary)
        return true
    }

    // MARK: Values

    /// The value as a string: strings as they are, numbers ("1", "2.5"), booleans ("true" / "false"), JSON values as
    /// compact JSON text.
    public func string(_ key: String, default fallback: String = "") -> String {
        resolve(key, RemoteConfigValue.string) ?? fallback
    }

    /// The value as a boolean: booleans; numbers (non-zero = true); strings "true" / "yes" / "on" / "1" and "false" /
    /// "no" / "off" / "0" (any case).
    public func bool(_ key: String, default fallback: Bool = false) -> Bool {
        resolve(key, RemoteConfigValue.bool) ?? fallback
    }

    /// The value as an integer (numbers are truncated; numeric strings are parsed; booleans give 1 / 0).
    public func int(_ key: String, default fallback: Int = 0) -> Int {
        resolve(key, RemoteConfigValue.int) ?? fallback
    }

    /// The value as a double (numeric strings are parsed; booleans give 1 / 0).
    public func double(_ key: String, default fallback: Double = 0) -> Double {
        resolve(key, RemoteConfigValue.double) ?? fallback
    }

    /// The raw JSON value (remote, else the default), nil when neither exists.
    public func json(_ key: String) -> RevflareJSON? {
        resolve(key) { $0 }
    }

    /// The value decoded as a `Decodable` of your own (a JSON parameter, or a string holding JSON, as Firebase JSON
    /// parameters are), nil when missing or of another shape.
    public func decode<T: Decodable>(_ key: String, as type: T.Type = T.self) -> T? {
        resolve(key) { RemoteConfigValue.decode($0, as: T.self) }
    }

    /// The raw JSON value: `Revflare.remoteConfig["paywall"]?["title"]?.stringValue`.
    public subscript(key: String) -> RevflareJSON? { json(key) }

    /// Where the value of `key` comes from (a remote value of a type the getter can't convert falls back to the
    /// default; this reports the first source that has a value).
    public func source(for key: String) -> ValueSource {
        if let value = remoteValues[key], !value.isNull { return .remote }
        if let value = defaultValues[key], !value.isNull { return .default }
        return .static
    }

    /// Every key that has a remote or default value, sorted.
    public var allKeys: [String] {
        Set(remoteValues.keys).union(defaultValues.keys).sorted()
    }

    // MARK: Experiments

    /// The enrolled experiment with this id, nil when the device is not in it (or it is not running).
    public func experiment(_ id: String) -> RevflareExperiment? {
        experiments.first { $0.id == id }
    }

    /// This device's variant in the experiment, nil when it is not enrolled. Reading it records no exposure: call
    /// ``trackExposure(experiment:)`` when the user sees the variant.
    public func variant(forExperiment id: String) -> String? {
        experiment(id)?.variant
    }

    /// Records that the user saw the experiment's variant (`experiment_exposure`, once per install, experiment and
    /// variant), for apps that branch on ``variant(forExperiment:)`` without reading a parameter. Reading a parameter
    /// of the experiment does this already.
    ///
    /// - Returns: false when the device is not enrolled in the experiment.
    @discardableResult
    public func trackExposure(experiment id: String) -> Bool {
        guard let experiment = experiment(id) else {
            Log.debug("Remote config: not enrolled in experiment \(id), no exposure")
            return false
        }
        expose(experiment)
        return true
    }

    private func exposeExperiments(of key: String) {
        guard let enrolled = experimentsByKey[key] else { return }
        for experiment in enrolled { expose(experiment) }
    }

    private func expose(_ experiment: RevflareExperiment) {
        guard !exposures.contains(experiment: experiment.id, variant: experiment.variant) else { return }
        // Not remembered while analytics is off, so it is recorded once the user opts in.
        guard analyticsEnabled() else { return }
        _ = exposures.insert(experiment: experiment.id, variant: experiment.variant)
        trackEvent(Self.exposureEvent, [
            "experiment": experiment.id,
            "variant": "\(experiment.id):\(experiment.variant)",
        ])
        Log.debug("Remote config: exposure to \(experiment.id), variant \(experiment.variant)")
    }

    /// The remote value when it converts, else the default when it converts.
    ///
    /// Reading a parameter of an enrolled experiment is an exposure whatever the value's source: the control may keep
    /// the in-app default (no remote value), and counting only remote values would under-expose it.
    private func resolve<T>(_ key: String, _ convert: (RevflareJSON) -> T?) -> T? {
        exposeExperiments(of: key)
        if let value = remoteValues[key], !value.isNull, let converted = convert(value) { return converted }
        if let value = defaultValues[key], !value.isNull, let converted = convert(value) { return converted }
        return nil
    }

    // MARK: Fetching

    /// Fetches the values for this device and activates them. Never throws: on failure (offline, server error, timeout)
    /// the cached values or the defaults stay in use.
    ///
    /// Joins a fetch already running (e.g. the automatic one at launch). When the server answers after `timeout`, the
    /// values are still activated when they arrive (observe this object to follow).
    ///
    /// - Parameter timeout: Seconds to wait at most (`.infinity`: until the request ends).
    /// - Returns: true when the server answered in time and its values are active (also when unchanged).
    @discardableResult
    public func fetchAndActivate(timeout: TimeInterval = 3) async -> Bool {
        let status = await firstResult(timeout: timeout) { @MainActor in await self.fetch(activating: true) }
        guard let status else {
            Log.debug("Remote config: no answer within \(timeout) s; using the cached values or defaults")
            return false
        }
        return status == .success
    }

    /// Fetches the values for this device without applying them: call ``activate()`` when the app is ready for them
    /// (e.g. at the next launch, so nothing changes under the user). Fetched values are kept on the device.
    @discardableResult
    public func fetch() async -> FetchStatus {
        await fetch(activating: false)
    }

    /// Applies the values fetched by ``fetch()`` (also those fetched in an earlier run). Returns true when new values
    /// were applied.
    @discardableResult
    public func activate() -> Bool {
        guard let pending = state.pending else { return false }
        state.pending = nil
        guard let response = Self.decodeBody(pending.body) else {
            save()
            return false
        }
        state.active = pending
        save()
        apply(response)
        isLoaded = true
        Log.debug("Remote config: activated version \(response.version), conditions \(response.conditions)")
        return true
    }

    // MARK: Internal

    /// Called by ``Revflare/configure(sdkKey:server:)``.
    func start(_ fetcher: RemoteConfigFetcher) {
        guard self.fetcher == nil else { return }
        self.fetcher = fetcher
        if scope != fetcher.cacheKey { load(scope: fetcher.cacheKey) }
        storage.rememberScope(fetcher.cacheKey)
        if autoFetch {
            Task { await self.fetch(activating: true) }
        }
    }

    /// Called when the app comes to the foreground: refetches (and activates) when the values are older than
    /// ``minimumFetchInterval`` or the device context changed (app version, locale, storefront...).
    func foregroundRefresh() async {
        guard autoFetch, let fetcher, inFlight == nil else { return }
        let context = await fetcher.context()
        guard isDue(context) else {
            // Values fetched in the background (e.g. after the attribution resolved) apply now, between screens.
            if state.pending?.context == context.fingerprint { activate() }
            return
        }
        await fetch(activating: true, context: context)
    }

    /// Called when ``Revflare/attribution`` changes: refetches for the new context into the pending slot (values in
    /// use stay until the app or ``autoFetch`` activates them).
    func attributionChanged(_ attribution: RevflareAttribution) async {
        if self.attribution != attribution { self.attribution = attribution }
        guard let fetcher else { return }
        if let inFlight { _ = await inFlight.value }
        let context = await fetcher.context()
        guard state.newest?.context != context.fingerprint else { return }
        Log.debug("Remote config: attribution is now \(attribution.source.rawValue); fetching for it")
        await fetch(activating: false, context: context)
    }

    func isDue(_ context: RemoteConfigContext) -> Bool {
        guard let newest = state.newest else { return true }
        if newest.context != context.fingerprint { return true }
        return now().timeIntervalSince(newest.fetchedAt) >= minimumFetchInterval
    }

    /// For tests.
    var storedState: RemoteConfigState { state }

    @discardableResult
    func fetch(activating: Bool, context: RemoteConfigContext? = nil) async -> FetchStatus {
        guard fetcher != nil else {
            Log.error("Remote config: call Revflare.configure(sdkKey:server:) before fetching")
            return .failure
        }
        if let inFlight {
            let status = await inFlight.value
            if activating { activate() }
            return status
        }
        let task = Task { await self.performFetch(activating: activating, context: context) }
        inFlight = task
        return await task.value
    }

    private func performFetch(activating: Bool, context known: RemoteConfigContext?) async -> FetchStatus {
        defer { inFlight = nil }
        guard let fetcher else { return .failure }
        var context = known
        if context == nil { context = await fetcher.context() }
        guard let context else { return .failure }
        let newest = state.newest
        // A different context may resolve to other values: don't let a 304 confirm the old ones.
        let etag = newest?.context == context.fingerprint ? newest?.etag : nil
        let outcome = await fetcher.fetch(context: context, etag: etag)
        let status: FetchStatus
        switch outcome {
        case .fetched(let entry, let response):
            state.pending = entry
            save()
            lastFetchDate = entry.fetchedAt
            status = .success
            Log.debug("Remote config: fetched version \(response.version) (\(response.values.count) value(s))")
        case .notModified:
            let date = now()
            if state.pending != nil {
                state.pending?.fetchedAt = date
            } else {
                state.active?.fetchedAt = date
            }
            save()
            lastFetchDate = date
            status = .success
            Log.debug("Remote config: unchanged")
        case .throttled:
            status = .throttled
            Log.debug("Remote config: throttled by the server (429); keeping the current values")
        case .failed(let message):
            status = .failure
            Log.debug("Remote config: fetch failed (\(message)); keeping the current values")
        }
        if activating { activate() }
        lastFetchStatus = status
        isLoaded = true
        return status
    }

    private func load(scope key: String) {
        scope = key
        state = storage.load(key)
        if let active = state.active, let response = Self.decodeBody(active.body) {
            apply(response)
            isLoaded = true
        } else {
            state.active = nil
            apply(nil)
            isLoaded = false
        }
        lastFetchDate = state.newest?.fetchedAt
    }

    private func apply(_ response: RemoteConfigResponse?) {
        remoteValues = response?.values ?? [:]
        conditions = response?.conditions ?? []
        country = response?.country
        version = response?.version
        let enrolled = response?.experiments ?? []
        if experiments != enrolled { experiments = enrolled }
        var byKey: [String: [RevflareExperiment]] = [:]
        for experiment in enrolled {
            for key in Set(experiment.keys) { byKey[key, default: []].append(experiment) }
        }
        experimentsByKey = byKey
    }

    private func save() {
        guard let scope else { return }
        storage.save(state, key: scope)
    }

    private static func decodeBody(_ body: Data) -> RemoteConfigResponse? {
        try? JSONDecoder().decode(RemoteConfigResponse.self, from: body)
    }
}

// MARK: Conversions

/// Converts values between the types apps ask for (pure functions, tested on their own).
enum RemoteConfigValue {
    static func string(_ value: RevflareJSON) -> String? {
        switch value {
        case .null: return nil
        case .string(let string): return string
        case .bool(let bool): return bool ? "true" : "false"
        case .number(let number): return format(number)
        case .array, .object:
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) }
        }
    }

    static func bool(_ value: RevflareJSON) -> Bool? {
        switch value {
        case .bool(let bool): return bool
        case .number(let number): return number != 0
        case .string(let string):
            switch string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "true", "yes", "on", "1", "y": return true
            case "false", "no", "off", "0", "n", "": return false
            default: return nil
            }
        default: return nil
        }
    }

    static func double(_ value: RevflareJSON) -> Double? {
        switch value {
        case .number(let number): return number
        case .bool(let bool): return bool ? 1 : 0
        case .string(let string):
            guard let number = Double(string.trimmingCharacters(in: .whitespacesAndNewlines)), number.isFinite else { return nil }
            return number
        default: return nil
        }
    }

    static func int(_ value: RevflareJSON) -> Int? {
        if case .string(let string) = value, let int = Int(string.trimmingCharacters(in: .whitespacesAndNewlines)) {
            return int
        }
        guard let number = double(value), number.isFinite, abs(number) < 9.0e18 else { return nil }
        return Int(number.rounded(.towardZero))
    }

    static func decode<T: Decodable>(_ value: RevflareJSON, as type: T.Type) -> T? {
        if let decoded = try? value.decode(T.self) { return decoded }
        // A string holding JSON (Firebase JSON parameters, string defaults).
        if case .string(let string) = value,
           let json = try? JSONDecoder().decode(RevflareJSON.self, from: Data(string.utf8)),
           let decoded = try? json.decode(T.self) {
            return decoded
        }
        return nil
    }

    /// 1 → "1", 2.5 → "2.5".
    static func format(_ number: Double) -> String {
        if number.isFinite, number.rounded() == number, abs(number) < 1e15 { return String(Int64(number)) }
        return String(number)
    }

    /// A default value from `setDefaults`: String, Bool, numbers, arrays, dictionaries, `RevflareJSON`, `NSNull`, `URL`.
    static func json(from value: Any) -> RevflareJSON? {
        switch value {
        case let json as RevflareJSON: return json
        case let string as String: return .string(string)
        case let number as NSNumber:
            // Bool, Int, Double... bridge to NSNumber; only real booleans are CFBoolean.
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(number.boolValue) }
            return .number(number.doubleValue)
        case let array as [Any]:
            var items: [RevflareJSON] = []
            for item in array {
                guard let converted = json(from: item) else { return nil }
                items.append(converted)
            }
            return .array(items)
        case let dictionary as [String: Any]:
            var object: [String: RevflareJSON] = [:]
            for (key, item) in dictionary {
                guard let converted = json(from: item) else { return nil }
                object[key] = converted
            }
            return .object(object)
        case is NSNull: return .null
        case let url as URL: return .string(url.absoluteString)
        default: return nil
        }
    }
}

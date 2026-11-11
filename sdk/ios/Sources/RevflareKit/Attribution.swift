import Foundation

/// How this install was acquired, as Revflare resolved it from the Apple Ads attribution token
/// (``Revflare/attribution``). Remote config conditions can target it (`source`, `campaign`, `adGroup`, `keyword`).
public struct RevflareAttribution: Sendable, Equatable, Hashable {
    public enum Source: String, Sendable, Equatable, Hashable, CaseIterable {
        /// Apple answered: an Apple Ads campaign brought the install.
        case appleAds = "apple_ads"
        /// Apple answered "not attributed", or no answer is possible (no token, refused, expired).
        case organic
        /// Not known yet: on the first launch Apple usually takes a few seconds to minutes. RevflareKit keeps asking
        /// (1, 5, 15, 60 minutes, then every 3 hours, up to 24 hours after the first launch).
        case unknown
    }

    public let source: Source
    /// Apple Ads campaign id, only with ``Source/appleAds``.
    public let campaignId: String?
    public let adGroupId: String?
    public let keywordId: String?

    public init(source: Source, campaignId: String? = nil, adGroupId: String? = nil, keywordId: String? = nil) {
        self.source = source
        self.campaignId = Self.clean(campaignId)
        self.adGroupId = Self.clean(adGroupId)
        self.keywordId = Self.clean(keywordId)
    }

    public static let unknown = RevflareAttribution(source: .unknown)

    /// Resolution reached (Apple Ads or organic): nothing more will change.
    public var isResolved: Bool { source != .unknown }

    private static func clean(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }
}

extension ReporterState {
    /// What the app sees (``Revflare/attribution``).
    var publicAttribution: RevflareAttribution {
        guard let raw = source, let source = RevflareAttribution.Source(rawValue: raw) else {
            // Locally final phases without a server source (old servers, never accepted).
            switch attribution {
            case .expired, .failed: return RevflareAttribution(source: .organic)
            default: return .unknown
            }
        }
        guard source == .appleAds else { return RevflareAttribution(source: source) }
        return RevflareAttribution(source: .appleAds, campaignId: campaignId, adGroupId: adGroupId, keywordId: keywordId)
    }
}

/// Lets the first remote config fetch of a new install wait for the first attribution report (at most
/// ``defaultTimeout``), so a known source can already pick the values. Existing installs never wait.
final class AttributionGate: Sendable {
    static let defaultTimeout: TimeInterval = 3

    private struct State {
        var open: Bool
        var waiters: [CheckedContinuation<Void, Never>] = []
    }

    private let state: Locked<State>

    init(open: Bool) { state = Locked(State(open: open)) }

    /// Open unless this is the first launch (no reporter state stored yet).
    convenience init(store: KeyValueStore) {
        self.init(open: store.data(forKey: Reporter.stateKey) != nil)
    }

    var isOpen: Bool { state.current.open }

    /// Called after the first attribution report of this run (whatever its outcome).
    func open() {
        let waiters = state.withLock { state -> [CheckedContinuation<Void, Never>] in
            guard !state.open else { return [] }
            state.open = true
            defer { state.waiters = [] }
            return state.waiters
        }
        waiters.forEach { $0.resume() }
    }

    /// Returns once open, or after `timeout` seconds (then the gate opens: later fetches don't wait again).
    func wait(timeout: TimeInterval = AttributionGate.defaultTimeout) async {
        if isOpen { return }
        let opened = await firstResult(timeout: timeout) { [self] in
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let resumeNow = state.withLock { state -> Bool in
                    if state.open { return true }
                    state.waiters.append(continuation)
                    return false
                }
                if resumeNow { continuation.resume() }
            }
            return true
        }
        if opened == nil {
            Log.debug("Remote config: no attribution answer within \(timeout) s; fetching with source=unknown")
            open()
        }
    }
}

import Foundation

/// A running A/B experiment this device is enrolled in (set up in Revflare web → the app → Experiments).
///
/// The values of the device's variant are already in the remote config: read the parameters as usual. Reading one of
/// ``keys`` records the exposure (`experiment_exposure`) the first time; see ``RevflareRemoteConfig/experiments``.
public struct RevflareExperiment: Sendable, Equatable, Hashable, Codable, Identifiable {
    /// The experiment's id, e.g. `exp_paywall1`.
    public let id: String
    /// The variant this device was assigned, e.g. `a`, `b`.
    public let variant: String
    /// The remote config parameters the experiment changes.
    public let keys: [String]

    public init(id: String, variant: String, keys: [String]) {
        self.id = id
        self.variant = variant
        self.keys = keys
    }
}

/// Remembers which (experiment, variant) exposures this install already recorded, in a ``KeyValueStore``
/// (UserDefaults in the app), so each is tracked once across launches.
struct ExperimentExposureStore {
    static let key = "app.revflare.kit.experiments.exposed"
    /// The newest entries kept (old experiments drop out first).
    static let maxEntries = 500

    let store: KeyValueStore
    private var entries: [String]
    private var lookup: Set<String>

    init(store: KeyValueStore) {
        self.store = store
        let saved = store.data(forKey: Self.key).flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
        entries = saved
        lookup = Set(saved)
    }

    static func entry(experiment: String, variant: String) -> String { "\(experiment)\u{1F}\(variant)" }

    func contains(experiment: String, variant: String) -> Bool {
        lookup.contains(Self.entry(experiment: experiment, variant: variant))
    }

    /// Records the exposure; false when it was already recorded.
    mutating func insert(experiment: String, variant: String) -> Bool {
        let entry = Self.entry(experiment: experiment, variant: variant)
        guard lookup.insert(entry).inserted else { return false }
        entries.append(entry)
        if entries.count > Self.maxEntries {
            let dropped = entries.prefix(entries.count - Self.maxEntries)
            lookup.subtract(dropped)
            entries.removeFirst(dropped.count)
        }
        store.set(try? JSONEncoder().encode(entries), forKey: Self.key)
        return true
    }
}

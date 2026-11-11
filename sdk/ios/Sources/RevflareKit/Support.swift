import Foundation
import os

/// A value guarded by a lock, for the few pieces of static state.
final class Locked<Value>: @unchecked Sendable {
    private var value: Value
    private let lock = NSLock()

    init(_ value: Value) { self.value = value }

    func withLock<R>(_ body: (inout Value) throws -> R) rethrows -> R {
        lock.lock()
        defer { lock.unlock() }
        return try body(&value)
    }

    var current: Value { withLock { $0 } }
}

/// Logging through `os.Logger`. Debug messages only appear with ``Revflare/debugLogging``; configuration errors
/// (unknown SDK key, rejected request) are always logged.
enum Log {
    static let enabled = Locked(false)
    private static let logger = Logger(subsystem: "app.revflare.kit", category: "RevflareKit")

    static func debug(_ message: @autoclosure () -> String) {
        guard enabled.current else { return }
        let text = message()
        logger.debug("\(text, privacy: .public)")
    }

    static func error(_ message: @autoclosure () -> String) {
        let text = message()
        logger.error("\(text, privacy: .public)")
    }
}

/// Persistent key/value storage (UserDefaults in the app, in memory in tests).
protocol KeyValueStore: Sendable {
    func data(forKey key: String) -> Data?
    func set(_ data: Data?, forKey key: String)
    func string(forKey key: String) -> String?
    func set(_ string: String?, forKey key: String)
}

/// `UserDefaults` is thread-safe; the wrapper only exists to make that explicit to the compiler.
final class UserDefaultsStore: KeyValueStore, @unchecked Sendable {
    private let defaults: UserDefaults

    init(_ defaults: UserDefaults = .standard) { self.defaults = defaults }

    func data(forKey key: String) -> Data? { defaults.data(forKey: key) }
    func set(_ data: Data?, forKey key: String) { defaults.set(data, forKey: key) }
    func string(forKey key: String) -> String? { defaults.string(forKey: key) }
    func set(_ string: String?, forKey key: String) { defaults.set(string, forKey: key) }
}

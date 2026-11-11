import Foundation
import Security

/// Result of reading the install id from secure storage.
enum SecureReadResult: Equatable {
    case found(UUID)
    case notFound
    /// The keychain cannot be read right now (device locked since boot, e.g. a prewarmed launch).
    case locked
}

/// Secure storage for the install id (the keychain in the app, in memory in tests).
protocol SecureStore: Sendable {
    func readInstallId() -> SecureReadResult
    @discardableResult func writeInstallId(_ id: UUID) -> Bool
}

/// Generic password item in the app's keychain. Keychain items outlive the app on iOS (a reinstall finds them), so
/// the install id survives reinstalls; it is not synchronized through iCloud and does not move to other devices.
struct KeychainStore: SecureStore {
    var service = "app.revflare.kit"
    var account = "installId"

    private var baseQuery: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        #if os(macOS)
        query[kSecUseDataProtectionKeychain as String] = true
        #endif
        return query
    }

    func readInstallId() -> SecureReadResult {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            if let data = item as? Data, let text = String(data: data, encoding: .utf8), let id = UUID(uuidString: text) {
                return .found(id)
            }
            return .notFound
        case errSecInteractionNotAllowed:
            return .locked
        default:
            // errSecItemNotFound, or a keychain this process cannot use (e.g. unsigned macOS test binaries).
            return .notFound
        }
    }

    @discardableResult
    func writeInstallId(_ id: UUID) -> Bool {
        let data = Data(id.uuidString.utf8)
        let update = SecItemUpdate(baseQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return true }
        var add = baseQuery
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }
}

/// The install id: created once, kept in the keychain with a UserDefaults copy as fallback.
final class InstallIdentity: @unchecked Sendable {
    static let defaultsKey = "app.revflare.kit.installId"

    private let secure: SecureStore
    private let defaults: KeyValueStore
    private let cached = Locked<UUID?>(nil)

    init(secure: SecureStore, defaults: KeyValueStore) {
        self.secure = secure
        self.defaults = defaults
    }

    /// The install id. `persisted` is false only when neither store could be read (before the first unlock after a
    /// reboot); the id returned then is temporary and the next call tries again.
    func resolve() -> (id: UUID, persisted: Bool) {
        cached.withLock { cached in
            if let id = cached { return (id, true) }
            let fromDefaults = defaults.string(forKey: Self.defaultsKey).flatMap(UUID.init(uuidString:))
            switch secure.readInstallId() {
            case .found(let id):
                if fromDefaults != id { defaults.set(id.uuidString, forKey: Self.defaultsKey) }
                cached = id
                return (id, true)
            case .notFound:
                let id = fromDefaults ?? UUID()
                secure.writeInstallId(id)
                if fromDefaults == nil { defaults.set(id.uuidString, forKey: Self.defaultsKey) }
                cached = id
                return (id, true)
            case .locked:
                if let id = fromDefaults {
                    cached = id
                    return (id, true)
                }
                return (UUID(), false)
            }
        }
    }
}

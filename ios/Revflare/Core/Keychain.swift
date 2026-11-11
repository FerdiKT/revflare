import Foundation
import Security

/// The device token and server URL, kept in a keychain access group shared with the widget extension
/// (`keychain-access-groups` in both entitlements files; allowed by every provisioning profile of the team, so no
/// App Group registration is needed). Readable after the first unlock so widgets and background pushes can use it.
struct StoredCredentials: Codable, Equatable, Sendable {
    var server: URL
    var token: String
    var userEmail: String?
}

/// The app's bundle id and team, from the build settings (`ios/Config.xcconfig` + the git-ignored `ios/Local.xcconfig`)
/// through the `RevflareBundleID` / `RevflareKeychainGroup` Info.plist keys of the app and the widget extension.
enum AppIdentity {
    /// The app's bundle id (also for the extension, whose own id is `<this>.widgets`).
    static let bundleID: String = info("RevflareBundleID") ?? "revflare"
    /// `<team id>.<bundle id>.shared`, or nil when the build has no team (unsigned simulator builds).
    static let keychainGroup: String? = info("RevflareKeychainGroup").flatMap { $0.hasPrefix(".") ? nil : $0 }

    private static func info(_ key: String) -> String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String, !value.isEmpty, !value.contains("$(") else { return nil }
        return value
    }
}

enum Keychain {
    static let accessGroup = AppIdentity.keychainGroup
    private static let service = AppIdentity.bundleID

    private static func baseQuery(_ account: String, shared: Bool) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if shared, let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    static func data(_ account: String) -> Data? {
        for shared in [true, false] {
            var q = baseQuery(account, shared: shared)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var item: CFTypeRef?
            if SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data { return data }
        }
        return nil
    }

    @discardableResult
    static func set(_ data: Data, for account: String) -> Bool {
        for shared in [true, false] {
            let q = baseQuery(account, shared: shared)
            if SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary) == errSecSuccess { return true }
        }
        for shared in [true, false] {
            var q = baseQuery(account, shared: shared)
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            // -34018 (missing entitlement, e.g. unsigned simulator builds): fall back to the app's own keychain.
            if SecItemAdd(q as CFDictionary, nil) == errSecSuccess { return true }
        }
        return false
    }

    static func remove(_ account: String) {
        SecItemDelete(baseQuery(account, shared: true) as CFDictionary)
        SecItemDelete(baseQuery(account, shared: false) as CFDictionary)
    }

    // Credentials

    static func load() -> StoredCredentials? {
        data("credentials").flatMap { try? JSONDecoder().decode(StoredCredentials.self, from: $0) }
    }

    @discardableResult
    static func save(_ creds: StoredCredentials) -> Bool {
        guard let data = try? JSONEncoder().encode(creds) else { return false }
        return set(data, for: "credentials")
    }

    static func delete() { remove("credentials") }
}

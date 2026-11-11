import Foundation

/// Non-secret settings shared by the app, the widgets and the intents. Stored as one JSON item in the shared
/// keychain group (see `Keychain`), cached per process; `reload()` picks up changes made by the other process.
enum SharedSettings {
    private struct Values: Codable {
        var workspaceId: String?
        var workspaceName: String?
        var currency: String?
        var showProceeds = false
        var privacyMode = false
        var deviceId: String?
        var widgetPushToken: String?
        /// "<deviceId>:<token or ->" last reported with `PATCH /devices/:id { widgetToken }`.
        var widgetTokenSent: String?
        var spotlightIndex = 0
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var cached: Values?

    private static func read() -> Values {
        lock.lock()
        defer { lock.unlock() }
        if let cached { return cached }
        let v = Keychain.data("settings").flatMap { try? JSONDecoder().decode(Values.self, from: $0) } ?? Values()
        cached = v
        return v
    }

    private static func write(_ change: (inout Values) -> Void) {
        var v = read()
        change(&v)
        lock.lock()
        cached = v
        lock.unlock()
        if let data = try? JSONEncoder().encode(v) { Keychain.set(data, for: "settings") }
    }

    /// Drops the in-memory copy (widgets call this before building a timeline).
    static func reload() {
        lock.lock()
        cached = nil
        lock.unlock()
    }

    static var workspaceId: String? {
        get { read().workspaceId }
        set { write { $0.workspaceId = newValue } }
    }
    static var workspaceName: String? {
        get { read().workspaceName }
        set { write { $0.workspaceName = newValue } }
    }
    static var currency: String {
        get { read().currency ?? "USD" }
        set { write { $0.currency = newValue } }
    }
    /// Show proceeds (after Apple's commission) instead of gross revenue.
    static var showProceeds: Bool {
        get { read().showProceeds }
        set { write { $0.showProceeds = newValue } }
    }
    /// Hide amounts everywhere (screen sharing).
    static var privacyMode: Bool {
        get { read().privacyMode }
        set { write { $0.privacyMode = newValue } }
    }
    static var deviceId: String? {
        get { read().deviceId }
        set { write { $0.deviceId = newValue } }
    }
    /// Hex WidgetKit push token (iOS 26), reported by the widget extension.
    static var widgetPushToken: String? {
        get { read().widgetPushToken }
        set { write { $0.widgetPushToken = newValue } }
    }
    static var widgetTokenSent: String? {
        get { read().widgetTokenSent }
        set { write { $0.widgetTokenSent = newValue } }
    }
    /// Index of the app shown by the interactive "App spotlight" widget.
    static var spotlightIndex: Int {
        get { read().spotlightIndex }
        set { write { $0.spotlightIndex = newValue } }
    }

    /// Sign-out: forgets the workspace and device, keeps display preferences.
    static func reset() {
        let keep = read()
        write { v in
            v = Values()
            v.showProceeds = keep.showProceeds
            v.privacyMode = keep.privacyMode
            v.widgetPushToken = keep.widgetPushToken
        }
    }
}

/// JSON files in the process's caches directory: the last response of every screen shows instantly on launch
/// (offline cache). The app and the widget extension each keep their own.
enum ResponseCache {
    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()

    private static var root: URL { FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0] }

    private static var directory: URL {
        let url = root.appending(path: "api", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private static func fileURL(_ key: String) -> URL {
        let safe = key.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" }
        return directory.appending(path: String(safe) + ".json")
    }

    static func key(_ parts: String...) -> String {
        ([SharedSettings.workspaceId ?? "default"] + parts).joined(separator: "_")
    }

    static func load<T: Decodable>(_ type: T.Type, key: String) -> T? {
        guard let data = try? Data(contentsOf: fileURL(key)) else { return nil }
        return try? decoder.decode(T.self, from: data)
    }

    static func store<T: Encodable>(_ value: T, key: String) {
        guard let data = try? encoder.encode(value) else { return }
        try? data.write(to: fileURL(key), options: .atomic)
    }

    static func clear() {
        try? FileManager.default.removeItem(at: directory)
    }

    // App icons (widgets cannot load remote images, so the widget timeline downloads them into its cache first).
    private static var iconDirectory: URL {
        let url = root.appending(path: "icons", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static func iconFile(for url: String) -> URL {
        var hash: UInt64 = 1469598103934665603
        for b in url.utf8 { hash = (hash ^ UInt64(b)) &* 1099511628211 }
        return iconDirectory.appending(path: String(hash, radix: 36) + ".img")
    }

    static func cachedIcon(_ url: String?) -> Data? {
        guard let url else { return nil }
        return try? Data(contentsOf: iconFile(for: url))
    }

    /// Downloads (once) and returns the icon's bytes.
    static func icon(_ url: String?) async -> Data? {
        guard let url, let remote = URL(string: url) else { return nil }
        if let data = cachedIcon(url) { return data }
        guard let (data, response) = try? await URLSession.shared.data(from: remote),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        try? data.write(to: iconFile(for: url), options: .atomic)
        return data
    }
}

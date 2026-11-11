import Foundation

// MARK: Wire format (`POST /sdk/v1/events`)

/// One event as queued on the device and sent to the server.
struct QueuedEvent: Codable, Equatable, Sendable {
    /// Client event id (lowercased UUID), so the server can drop duplicates.
    var id: String
    var name: String
    /// Milliseconds since 1970, device clock.
    var ts: Int64
    /// Lowercased UUID of the session the event happened in.
    var sessionId: String
    var props: [String: String]
}

/// Body of `POST /sdk/v1/events`.
struct EventsBody: Encodable, Equatable, Sendable {
    var installId: String
    var appVersion: String
    var appBuild: String
    var osVersion: String
    var locale: String
    var events: [QueuedEvent]

    init(installId: UUID, context: EventsContext, events: [QueuedEvent]) {
        self.installId = installId.uuidString.lowercased()
        appVersion = context.appVersion
        appBuild = context.appBuild
        osVersion = context.osVersion
        locale = context.locale
        self.events = events
    }
}

/// Answer of `POST /sdk/v1/events`.
struct EventsResponse: Decodable, Equatable, Sendable {
    var ok: Bool?
    var accepted: Int?
    var dropped: Int?
}

/// The app and device fields sent with every batch (no identifiers).
struct EventsContext: Equatable, Sendable {
    var appVersion: String
    var appBuild: String
    var osVersion: String
    var locale: String

    static var current: EventsContext {
        let bundle = Bundle.main
        return EventsContext(
            appVersion: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
            appBuild: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
            osVersion: SystemDeviceIdentifierProvider.osVersion(),
            locale: SystemDeviceIdentifierProvider.localeIdentifier(Locale.current.identifier)
        )
    }
}

/// What came of one events request.
enum EventsOutcome: Equatable, Sendable {
    /// 2xx: the server took the batch (invalid events in it were dropped, not retried).
    case accepted(accepted: Int?, dropped: Int?)
    /// 4xx other than 429: the batch is refused for good (bad body, unknown key, too large). Dropped.
    case rejected(status: Int, message: String)
    /// 429, 5xx, network error: kept and retried. `after` is the server's `Retry-After`, in seconds.
    case retry(after: TimeInterval?, message: String)
}

extension ReportClient {
    /// `POST /sdk/v1/events`.
    func sendEvents(_ body: EventsBody) async -> EventsOutcome {
        let request: URLRequest
        do {
            request = try makeRequest(body, to: .events)
        } catch {
            return .rejected(status: 0, message: "Could not encode the events: \(error)")
        }
        do {
            let (data, response) = try await transport.send(request)
            switch response.statusCode {
            case 200..<300:
                let decoded = try? JSONDecoder().decode(EventsResponse.self, from: data)
                return .accepted(accepted: decoded?.accepted, dropped: decoded?.dropped)
            case 429, 500...:
                let after = response.value(forHTTPHeaderField: "Retry-After").flatMap(Self.retryAfterSeconds)
                return .retry(after: after, message: "HTTP \(response.statusCode)")
            default:
                let message = String(data: data.prefix(300), encoding: .utf8) ?? ""
                return .rejected(status: response.statusCode, message: message)
            }
        } catch {
            return .retry(after: nil, message: String(describing: error))
        }
    }

    /// `Retry-After` in seconds (the HTTP-date form is not used by Revflare and is ignored).
    static func retryAfterSeconds(_ value: String) -> TimeInterval? {
        guard let seconds = Double(value.trimmingCharacters(in: .whitespaces)), seconds.isFinite, seconds >= 0 else {
            return nil
        }
        return seconds
    }
}

// MARK: Sanitizing

/// An event as tracked, before the tracker gives it a session.
struct TrackedEvent: Sendable, Equatable {
    var id: String
    var name: String
    var ts: Int64
    var props: [String: String]
}

/// Applies the server's limits on the device, so a batch never carries an event the server would drop.
enum EventSanitizer {
    static let maxNameLength = 64
    static let maxProps = 10
    static let maxKeyLength = 40
    static let maxValueLength = 100

    private static let nameCharacters = CharacterSet(charactersIn:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:-")
    private static let keyCharacters = CharacterSet(charactersIn:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-")

    /// `^[A-Za-z0-9_.:-]{1,64}$`
    static func isValidName(_ name: String) -> Bool {
        !name.isEmpty && name.unicodeScalars.count <= maxNameLength
            && name.unicodeScalars.allSatisfy { nameCharacters.contains($0) }
    }

    /// `^[A-Za-z0-9_.-]{1,40}$`
    static func isValidKey(_ key: String) -> Bool {
        !key.isEmpty && key.unicodeScalars.count <= maxKeyLength
            && key.unicodeScalars.allSatisfy { keyCharacters.contains($0) }
    }

    static func milliseconds(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    /// The event, or nil (with a debug log) when its name is invalid.
    static func event(name: String, properties: [String: Any], at date: Date, id: UUID = UUID()) -> TrackedEvent? {
        guard isValidName(name) else {
            Log.debug("Event \"\(name.prefix(80))\" dropped: names are 1-64 characters of A-Z a-z 0-9 _ . : -")
            return nil
        }
        return TrackedEvent(id: id.uuidString.lowercased(), name: name, ts: milliseconds(date),
                            props: props(properties, event: name))
    }

    /// Valid keys with string values: numbers and booleans become strings, strings are cut to 100 characters,
    /// unsupported values and invalid keys are dropped; at most 10 properties (the first 10 keys in sorted order).
    static func props(_ properties: [String: Any], event: String = "") -> [String: String] {
        var result: [String: String] = [:]
        for key in properties.keys.sorted() {
            guard isValidKey(key) else {
                Log.debug("Event \(event): property \"\(key.prefix(60))\" dropped (keys are 1-40 characters of A-Z a-z 0-9 _ . -)")
                continue
            }
            guard let value = string(from: properties[key] as Any) else {
                Log.debug("Event \(event): property \(key) dropped (use strings, numbers or booleans)")
                continue
            }
            guard result.count < maxProps else {
                Log.debug("Event \(event): more than \(maxProps) properties, \(key) and later keys dropped")
                break
            }
            result[key] = truncate(value)
        }
        return result
    }

    /// At most 100 UTF-16 code units (the server measures JavaScript string length), never splitting a character.
    static func truncate(_ value: String) -> String {
        guard value.utf16.count > maxValueLength else { return value }
        var result = ""
        var length = 0
        for character in value {
            let count = character.utf16.count
            if length + count > maxValueLength { break }
            result.append(character)
            length += count
        }
        return result
    }

    /// A property value as a string, or nil when the type is not supported.
    static func string(from value: Any) -> String? {
        // Unwrap optionals hidden in `Any`.
        let mirror = Mirror(reflecting: value)
        if mirror.displayStyle == .optional {
            guard let wrapped = mirror.children.first?.value else { return nil }
            return string(from: wrapped)
        }
        if let text = value as? String { return text }
        if let text = value as? Substring { return String(text) }
        // Objective-C numbers (JSONSerialization, NSNumber): booleans are CFBoolean.
        if type(of: value) is NSNumber.Type, let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }
            if number is NSDecimalNumber { return number.stringValue }
            if CFNumberIsFloatType(number) { return format(number.doubleValue) }
            return number.stringValue
        }
        switch value {
        case let flag as Bool: return flag ? "true" : "false"
        case let number as Double: return format(number)
        case let number as Float: return format(Double(number))
        case let number as CGFloat: return format(Double(number))
        case let number as Decimal: return "\(number)"
        case let number as any BinaryInteger: return "\(number)"
        case let uuid as UUID: return uuid.uuidString.lowercased()
        case let url as URL: return url.absoluteString
        case let date as Date: return ISO8601DateFormatter().string(from: date)
        case let raw as any RawRepresentable: return string(from: raw.rawValue)
        default: return nil
        }
    }

    /// Whole numbers without a decimal point ("2", not "2.0"); NaN and infinities are not sent.
    static func format(_ number: Double) -> String? {
        guard number.isFinite else { return nil }
        if number.rounded() == number, abs(number) < 1e15 { return String(Int64(number)) }
        return String(number)
    }
}

// MARK: Storage

/// Where the queue survives app kills (a file in the app, memory in tests).
protocol EventStorage: Sendable {
    func load() -> [QueuedEvent]
    func append(_ events: [QueuedEvent])
    func replace(with events: [QueuedEvent])
    func clear()
}

/// JSON lines in `Application Support/app.revflare.kit/events.jsonl` (excluded from backups): adding an event appends
/// one line; removing events rewrites the file atomically. A line cut short by a kill is skipped at the next load.
final class FileEventStorage: EventStorage, @unchecked Sendable {
    let url: URL
    private let lock = NSLock()

    init(url: URL) { self.url = url }

    /// The app's queue file, or nil when Application Support can't be found.
    static func appDefault() -> FileEventStorage? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        return FileEventStorage(url: base.appendingPathComponent("app.revflare.kit", isDirectory: true)
            .appendingPathComponent("events.jsonl"))
    }

    func load() -> [QueuedEvent] {
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? Data(contentsOf: url), !data.isEmpty else { return [] }
        let decoder = JSONDecoder()
        var events: [QueuedEvent] = []
        var malformed = false
        for line in data.split(separator: UInt8(ascii: "\n")) where !line.isEmpty {
            if let event = try? decoder.decode(QueuedEvent.self, from: Data(line)) {
                events.append(event)
            } else {
                malformed = true
            }
        }
        if events.count > EventTracker.maxQueue { events.removeFirst(events.count - EventTracker.maxQueue) }
        // Rewrite a damaged file (a line cut short) so the next append starts on a clean line.
        if malformed || data.last != UInt8(ascii: "\n") { write(events) }
        return events
    }

    func append(_ events: [QueuedEvent]) {
        guard !events.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        let data = Self.encode(events)
        if FileManager.default.fileExists(atPath: url.path), let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            do {
                try handle.seekToEnd()
                try handle.write(contentsOf: data)
                return
            } catch {
                Log.debug("Events: could not append to the queue file: \(error)")
            }
        }
        // No file yet (or it could not be opened): write it.
        createDirectory()
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            Log.debug("Events: could not write the queue file: \(error)")
        }
    }

    func replace(with events: [QueuedEvent]) {
        lock.lock()
        defer { lock.unlock() }
        write(events)
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        try? FileManager.default.removeItem(at: url)
    }

    /// Call with the lock held.
    private func write(_ events: [QueuedEvent]) {
        guard !events.isEmpty else {
            try? FileManager.default.removeItem(at: url)
            return
        }
        createDirectory()
        do {
            try Self.encode(events).write(to: url, options: .atomic)
        } catch {
            Log.debug("Events: could not write the queue file: \(error)")
        }
    }

    private func createDirectory() {
        var directory = url.deletingLastPathComponent()
        guard !FileManager.default.fileExists(atPath: directory.path) else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? directory.setResourceValues(values)
    }

    private static func encode(_ events: [QueuedEvent]) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data = Data()
        for event in events {
            guard let line = try? encoder.encode(event) else { continue }
            data.append(line)
            data.append(UInt8(ascii: "\n"))
        }
        return data
    }
}

/// Keeps the queue in memory only (when no file can be used).
final class MemoryEventStorage: EventStorage, @unchecked Sendable {
    private let events = Locked<[QueuedEvent]>([])

    func load() -> [QueuedEvent] { events.current }
    func append(_ added: [QueuedEvent]) { events.withLock { $0.append(contentsOf: added) } }
    func replace(with replacement: [QueuedEvent]) { events.withLock { $0 = replacement } }
    func clear() { events.withLock { $0 = [] } }
}

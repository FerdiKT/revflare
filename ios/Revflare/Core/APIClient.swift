import Foundation

enum APIError: LocalizedError, Equatable {
    case notSignedIn
    case unauthorized
    case server(status: Int, message: String)
    /// `503 { code: "quota" }`: the server's Cloudflare Free plan database limit is used up until 00:00 UTC.
    case quota(message: String)
    case invalidResponse
    case network(String)

    var errorDescription: String? {
        switch self {
        case .notSignedIn: String(localized: "You are not signed in.")
        case .unauthorized: String(localized: "Your session has expired. Please sign in again.")
        case let .server(_, message): message
        case let .quota(message): message
        case .invalidResponse: String(localized: "The server sent an unexpected response.")
        case let .network(message): message
        }
    }

    var isQuota: Bool {
        if case .quota = self { return true }
        return false
    }

    /// When the database limit resets (the next 00:00 UTC).
    static func quotaReset(after date: Date = .now) -> Date {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        return utc.nextDate(after: date, matching: DateComponents(hour: 0, minute: 0, second: 0), matchingPolicy: .nextTime) ?? date.addingTimeInterval(3600)
    }
}

/// Talks to `/api/v1` with the device token. Used by the app, the widgets and the intents.
struct APIClient: Sendable {
    var server: URL
    var token: String?
    var workspaceId: String?

    /// The signed-in client (keychain + shared settings), or nil.
    static func current() -> APIClient? {
        guard let creds = Keychain.load() else { return nil }
        return APIClient(server: creds.server, token: creds.token, workspaceId: SharedSettings.workspaceId)
    }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpAdditionalHeaders = ["Accept": "application/json"]
        return URLSession(configuration: config)
    }()

    private static let decoder = JSONDecoder()

    /// `{ "error": "...", "code": "quota" | "budget" | ... }`
    private struct ErrorBody: Decodable {
        var error: String?
        var code: String?
    }

    /// Normalizes what the user typed ("revflare.example.com" → https://revflare.example.com).
    static func normalizeServer(_ text: String) -> URL? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        if s.isEmpty { return nil }
        if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") { s = "https://" + s }
        guard let url = URL(string: s), url.host() != nil else { return nil }
        return url
    }

    func url(_ path: String, query: [String: String?] = [:]) -> URL {
        var comps = URLComponents(url: server.appending(path: "api/v1" + path), resolvingAgainstBaseURL: false)!
        let items = query.compactMap { k, v in v.map { URLQueryItem(name: k, value: $0) } }.sorted { $0.name < $1.name }
        if !items.isEmpty { comps.queryItems = items }
        return comps.url!
    }

    func send<T: Decodable>(_ method: String = "GET", _ path: String, query: [String: String?] = [:], body: (any Encodable)? = nil, as type: T.Type = T.self) async throws -> T {
        var request = URLRequest(url: url(path, query: query))
        request.httpMethod = method
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let workspaceId { request.setValue(workspaceId, forHTTPHeaderField: "X-Workspace-Id") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: request)
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw APIError.network(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            let body = try? Self.decoder.decode(ErrorBody.self, from: data)
            let message = body?.error ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            if http.statusCode == 503, body?.code == "quota" { throw APIError.quota(message: message) }
            throw APIError.server(status: http.statusCode, message: message)
        }
        if T.self == IgnoredResponse.self, let ignored = IgnoredResponse() as? T { return ignored }
        do {
            return try Self.decoder.decode(T.self, from: data)
        } catch {
            #if DEBUG
            print("Decoding \(T.self) from \(path) failed: \(error)")
            #endif
            throw APIError.invalidResponse
        }
    }

    func get<T: Decodable>(_ path: String, query: [String: String?] = [:], as type: T.Type = T.self) async throws -> T {
        try await send("GET", path, query: query, as: type)
    }
}

// MARK: - Endpoints

/// Common metric query parameters (`apps=id1,id2`).
func appsParam(_ ids: Set<String>) -> String? {
    ids.isEmpty ? nil : ids.sorted().joined(separator: ",")
}

extension APIClient {
    func me() async throws -> Me { try await get("/me") }

    /// Dashboard summary; "today" / "yesterday" are the device's local days (`tzOffset`, minutes east of UTC).
    func overview(apps: Set<String> = []) async throws -> Overview {
        try await get("/overview", query: ["apps": appsParam(apps), "tzOffset": String(TimeZone.current.secondsFromGMT() / 60)])
    }

    func apps() async throws -> AppList { try await get("/apps") }

    func app(_ id: String) async throws -> AppDetail { try await get("/apps/\(id)") }

    func chart(_ metric: String, range: String, interval: String?, groupBy: String?, apps: Set<String> = []) async throws -> MetricChart {
        try await get("/charts/\(metric)", query: ["range": range, "interval": interval, "groupBy": groupBy, "apps": appsParam(apps)])
    }

    func mrrMovement(range: String, interval: String? = nil, apps: Set<String> = []) async throws -> MrrMovement {
        try await get("/mrr-movement", query: ["range": range, "interval": interval, "apps": appsParam(apps)])
    }

    /// Past transactions newest first (with `days` totals in the device's local days), or with `upcoming` the
    /// renewals Apple announced ahead of their period, oldest first (not counted anywhere yet).
    /// `source` ("apple_ads" | "organic" | "unknown") filters by acquisition: pages may then be short (even empty)
    /// with a `nextCursor`, keep loading.
    /// `quick`: bought within 5 minutes of the install or cancelled within 5 minutes of the purchase; `cancellations`: the
    /// cancellations stream (rows of kind "cancellation") instead of the sales.
    func transactions(limit: Int = 50, cursor: String? = nil, kinds: [String] = [], refunded: Bool = false, q: String? = nil, environment: String? = nil, source: String? = nil, apps: Set<String> = [], upcoming: Bool = false, quick: Bool = false, cancellations: Bool = false) async throws -> Page<Transaction> {
        try await get("/transactions", query: [
            "limit": String(limit), "cursor": cursor, "kinds": kinds.isEmpty ? nil : kinds.joined(separator: ","),
            "refunded": refunded ? "true" : nil, "q": q, "environment": environment, "source": source, "apps": appsParam(apps),
            "upcoming": upcoming ? "true" : nil, "tzOffset": String(TimeZone.current.secondsFromGMT() / 60),
            "quick": quick ? "true" : nil, "cancellations": cancellations ? "true" : nil,
        ])
    }

    func customer(_ id: String) async throws -> Customer { try await get("/customers/\(id)") }

    func atRisk(apps: Set<String> = []) async throws -> AtRisk { try await get("/at-risk", query: ["limit": "50", "apps": appsParam(apps)]) }

    func forecast(apps: Set<String> = []) async throws -> Forecast { try await get("/forecast", query: ["days": "30", "apps": appsParam(apps)]) }

    /// Every goal (archived ones too, flagged) in their order, with progress.
    func goals() async throws -> GoalList { try await get("/goals") }

    func goal(_ id: String) async throws -> GoalResponse { try await get("/goals/\(id)") }

    @discardableResult
    func createGoal(_ input: GoalInput) async throws -> GoalResponse { try await send("POST", "/goals", body: input) }

    @discardableResult
    func updateGoal(_ id: String, _ patch: GoalPatch) async throws -> GoalResponse { try await send("PATCH", "/goals/\(id)", body: patch) }

    private struct GoalArchive: Encodable { var archived: Bool }
    @discardableResult
    func setGoalArchived(_ id: String, _ archived: Bool) async throws -> GoalResponse {
        try await send("PATCH", "/goals/\(id)", body: GoalArchive(archived: archived))
    }

    private struct GoalOrder: Encodable { var ids: [String] }
    func reorderGoals(_ ids: [String]) async throws { _ = try await send("POST", "/goals/reorder", body: GoalOrder(ids: ids), as: IgnoredResponse.self) }

    func deleteGoal(_ id: String) async throws { _ = try await send("DELETE", "/goals/\(id)", as: IgnoredResponse.self) }

    // Events and funnels (read-only here; funnels are created in the web panel).
    func analyticsStatus(app id: String) async throws -> AnalyticsStatus { try await get("/apps/\(id)/analytics/status") }

    /// `range`: "7d" | "28d" | "90d".
    func eventSummary(app id: String, range: String) async throws -> EventSummary {
        try await get("/apps/\(id)/events/summary", query: ["range": range])
    }

    func funnels(app id: String) async throws -> [Funnel] {
        try await get("/apps/\(id)/funnels", as: ItemsResponse<Funnel>.self).items
    }

    /// `breakdown`: nil, "app_version", "os_version", "country", "locale", "placement", "offering", "product", ...
    func funnelReport(app id: String, funnel fid: String, range: String, breakdown: String?) async throws -> FunnelReport {
        try await get("/apps/\(id)/funnels/\(fid)/report", query: ["range": range, "breakdown": breakdown])
    }

    /// Apple Ads attributed revenue (RevflareKit) of one app; `range`: "7d" | "28d" | "90d".
    func attributedRevenue(app id: String, range: String, includeTest: Bool) async throws -> AttributedRevenue {
        try await get("/revenue/attributed", query: ["apps": id, "range": range, "includeTest": includeTest ? "true" : nil])
    }

    func resolveAlert(_ id: String) async throws { _ = try await send("POST", "/alerts/\(id)/resolve", as: IgnoredResponse.self) }

    // Devices
    struct NewDevice: Encodable { var apnsToken: String; var environment: String; var name: String; var prefs: DevicePrefs }
    func registerDevice(_ device: NewDevice) async throws -> Device { try await send("POST", "/devices", body: device) }

    struct PrefsPatch: Encodable { var prefs: DevicePrefs }
    func updateDevice(_ id: String, prefs: DevicePrefs) async throws -> Device {
        try await send("PATCH", "/devices/\(id)", body: PrefsPatch(prefs: prefs))
    }

    /// One push token (hex) for `PATCH /devices/:id`; nil is sent as an explicit `null` (the token ended).
    struct TokenPatch: Encodable {
        enum Kind: String, CodingKey { case activityToken, widgetToken }
        var kind: Kind
        var token: String?
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: Kind.self)
            try c.encode(token, forKey: kind)
        }
    }
    /// Live Activity push token, or nil when the activity ended.
    func updateDevice(_ id: String, activityToken: String?) async throws -> Device {
        try await send("PATCH", "/devices/\(id)", body: TokenPatch(kind: .activityToken, token: activityToken))
    }
    /// WidgetKit push token (`apns-push-type: widgets`), or nil when it was revoked.
    func updateDevice(_ id: String, widgetToken: String?) async throws -> Device {
        try await send("PATCH", "/devices/\(id)", body: TokenPatch(kind: .widgetToken, token: widgetToken))
    }

    func devices() async throws -> [Device] {
        if let r = try? await get("/devices", as: ItemsResponse<Device>.self) { return r.items }
        return try await get("/devices", as: [Device].self)
    }

    func deleteDevice(_ id: String) async throws { _ = try await send("DELETE", "/devices/\(id)", as: IgnoredResponse.self) }
    func testPush(_ id: String) async throws { _ = try await send("POST", "/devices/\(id)/test", as: IgnoredResponse.self) }

    // Auth
    struct DeviceLogin: Encodable { var email: String; var password: String; var deviceName: String }
    struct PairLogin: Encodable { var code: String; var deviceName: String }

    func signIn(email: String, password: String, deviceName: String) async throws -> DeviceTokenResponse {
        try await send("POST", "/auth/device", body: DeviceLogin(email: email, password: password, deviceName: deviceName))
    }

    func pair(code: String, deviceName: String) async throws -> DeviceTokenResponse {
        try await send("POST", "/auth/pair", body: PairLogin(code: code, deviceName: deviceName))
    }

    func signOut() async throws { _ = try await send("POST", "/auth/logout", as: IgnoredResponse.self) }

    // Signing a browser in (docs/app-login-spec.md): `nonce` from a QR code, `number` for push requests.
    struct WebLoginAnswer: Encodable { var nonce: String?; var number: Int? }

    func inspectWebLogin(_ id: String, nonce: String?) async throws -> WebLoginInfo {
        try await send("POST", "/auth/app-login/\(id)/inspect", body: WebLoginAnswer(nonce: nonce))
    }

    func approveWebLogin(_ id: String, nonce: String?, number: Int?) async throws {
        _ = try await send("POST", "/auth/app-login/\(id)/approve", body: WebLoginAnswer(nonce: nonce, number: number), as: IgnoredResponse.self)
    }

    func denyWebLogin(_ id: String, nonce: String?) async throws {
        _ = try await send("POST", "/auth/app-login/\(id)/deny", body: WebLoginAnswer(nonce: nonce), as: IgnoredResponse.self)
    }
}

/// Accepts any JSON body (or none).
struct IgnoredResponse: Decodable {
    init() {}
    init(from decoder: Decoder) throws {}
}

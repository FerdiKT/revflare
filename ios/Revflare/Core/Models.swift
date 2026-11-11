// REST API v1 contract, mirrored from shared/types.ts. Amounts are in the response's `currency` (the workspace's
// reporting currency) unless a field ends in `Usd`. Timestamps are Unix milliseconds unless noted.
// String-typed "enums" stay strings so a new server value never breaks decoding.

import Foundation

// MARK: - Account

struct User: Codable, Hashable, Sendable {
    var id: String
    var name: String
    var email: String
    var isAdmin: Bool
    /// Daily digest e-mail opt-in (servers with e-mail configured).
    var dailyDigestEmail: Bool?
}

struct WorkspaceSummary: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var role: String
    var currency: String
    var permissions: [String]?
}

struct Me: Codable, Sendable {
    struct Features: Codable, Sendable {
        var push: Bool
        var email: Bool?
    }
    var user: User
    var workspace: WorkspaceSummary?
    var workspaces: [WorkspaceSummary]
    var auth: String
    var version: String
    var apiVersion: Int
    var features: Features

    func can(_ permission: String) -> Bool { workspace?.permissions?.contains(permission) ?? false }
}

struct AuthStatus: Codable, Sendable {
    var setup: Bool
    var authenticated: Bool
    var setupToken: Bool?
    var magicLink: Bool?
    /// "Sign in with the iPhone app" is offered on the web (an iOS device is signed in); `pushLogin`: the push variant too.
    var appLogin: Bool?
    var pushLogin: Bool?
    var appStoreUrl: String?
}

/// `POST /auth/app-login/:id/inspect`: a browser asking to be signed in by this device (docs/app-login-spec.md).
struct WebLoginInfo: Codable, Hashable, Sendable {
    /// "qr" | "push"
    var kind: String
    var ip: String?
    var city: String?
    var country: String?
    var browser: String
    var os: String
    var createdAt: Double
    var expiresAt: Double
    /// Push requests: three numbers, one of them shown in the browser.
    var numbers: [Int]?

    var isPush: Bool { kind == "push" }
    var place: String? {
        let parts = [city, country].compactMap { $0?.isEmpty == false ? $0 : nil }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }
}

struct DeviceTokenResponse: Codable, Sendable {
    var token: String
    var user: User
    var workspace: WorkspaceSummary?
    var server: String
}

struct PairingCode: Codable, Sendable {
    var code: String
    var url: String
    var expiresAt: Double
}

struct DevicePrefs: Codable, Hashable, Sendable {
    enum Sound: String, Codable, CaseIterable, Sendable { case cash, `default`, none }

    var sales: Bool = true
    var renewals: Bool = true
    var trials: Bool = true
    var refunds: Bool = true
    var cancellations: Bool = false
    var alerts: Bool = true
    /// Event silence, funnel anomaly and release regression pushes (push kind "funnel").
    var funnelAlerts: Bool = true
    var dailySummary: Bool = true
    var weeklySummary: Bool = true
    var minUsd: Double = 0
    var apps: [String]? = nil
    /// Per app (id): `muted` silences the app's sale / event notifications; a kind set here wins over the global toggle.
    var appOverrides: [String: AppPushOverride] = [:]
    var sound: Sound = .cash
    var quietStart: String? = nil
    var quietEnd: String? = nil
    var timezone: String = TimeZone.current.identifier
    var locale: String = Locale.current.identifier

    /// The push texts (loc-keys in Localizable.strings) this build knows, always sent with the preferences: the server
    /// only sends newer pushes (funnel alerts, the summary's digest line) to builds that can show them. Bump it when
    /// adding push loc-keys (worker/lib/push.ts PUSH_VERSION_*).
    static let pushVersion = 4

    enum CodingKeys: String, CodingKey {
        case sales, renewals, trials, refunds, cancellations, alerts, funnelAlerts, dailySummary, weeklySummary, minUsd, apps, appOverrides
        case sound, quietStart, quietEnd, timezone, locale, pushVersion
    }

    // `apps`, `quietStart` and `quietEnd` must be sent as explicit nulls to clear them.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(sales, forKey: .sales)
        try c.encode(renewals, forKey: .renewals)
        try c.encode(trials, forKey: .trials)
        try c.encode(refunds, forKey: .refunds)
        try c.encode(cancellations, forKey: .cancellations)
        try c.encode(alerts, forKey: .alerts)
        try c.encode(funnelAlerts, forKey: .funnelAlerts)
        try c.encode(dailySummary, forKey: .dailySummary)
        try c.encode(weeklySummary, forKey: .weeklySummary)
        try c.encode(minUsd, forKey: .minUsd)
        try c.encode(apps, forKey: .apps)
        try c.encode(appOverrides, forKey: .appOverrides)
        try c.encode(sound, forKey: .sound)
        try c.encode(quietStart, forKey: .quietStart)
        try c.encode(quietEnd, forKey: .quietEnd)
        try c.encode(timezone, forKey: .timezone)
        try c.encode(locale, forKey: .locale)
        try c.encode(Self.pushVersion, forKey: .pushVersion)
    }
}

extension DevicePrefs {
    /// Missing keys keep their defaults (older servers have no `appOverrides`).
    init(from decoder: Decoder) throws {
        self.init()
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sales = try c.decodeIfPresent(Bool.self, forKey: .sales) ?? sales
        renewals = try c.decodeIfPresent(Bool.self, forKey: .renewals) ?? renewals
        trials = try c.decodeIfPresent(Bool.self, forKey: .trials) ?? trials
        refunds = try c.decodeIfPresent(Bool.self, forKey: .refunds) ?? refunds
        cancellations = try c.decodeIfPresent(Bool.self, forKey: .cancellations) ?? cancellations
        alerts = try c.decodeIfPresent(Bool.self, forKey: .alerts) ?? alerts
        funnelAlerts = try c.decodeIfPresent(Bool.self, forKey: .funnelAlerts) ?? funnelAlerts
        dailySummary = try c.decodeIfPresent(Bool.self, forKey: .dailySummary) ?? dailySummary
        weeklySummary = try c.decodeIfPresent(Bool.self, forKey: .weeklySummary) ?? weeklySummary
        minUsd = try c.decodeIfPresent(Double.self, forKey: .minUsd) ?? minUsd
        apps = try c.decodeIfPresent([String].self, forKey: .apps)
        appOverrides = try c.decodeIfPresent([String: AppPushOverride].self, forKey: .appOverrides) ?? [:]
        sound = (try? c.decodeIfPresent(Sound.self, forKey: .sound)) ?? sound
        quietStart = try c.decodeIfPresent(String.self, forKey: .quietStart)
        quietEnd = try c.decodeIfPresent(String.self, forKey: .quietEnd)
        timezone = try c.decodeIfPresent(String.self, forKey: .timezone) ?? timezone
        locale = try c.decodeIfPresent(String.self, forKey: .locale) ?? locale
    }

    /// Whether a kind notifies for an app: the app's explicit value, else the global toggle.
    func isOn(_ kind: AppPushOverride.Kind, app id: String) -> Bool {
        let o = appOverrides[id]
        if o?.muted == true { return false }
        return o?[kind] ?? self[keyPath: kind.globalKeyPath]
    }

    func isMuted(_ id: String) -> Bool { appOverrides[id]?.muted == true }

    /// Edits an app's override; an override left empty is removed (as the server does).
    mutating func editOverride(_ id: String, _ change: (inout AppPushOverride) -> Void) {
        var o = appOverrides[id] ?? AppPushOverride()
        change(&o)
        appOverrides[id] = o.isEmpty ? nil : o
    }
}

/// A device's notification settings for one app (`DevicePrefs.appOverrides`); nil = inherit the global toggle.
struct AppPushOverride: Codable, Hashable, Sendable {
    enum Kind: String, CaseIterable, Sendable, Identifiable {
        case sales, renewals, trials, refunds, cancellations, alerts, funnelAlerts
        var id: String { rawValue }

        var globalKeyPath: WritableKeyPath<DevicePrefs, Bool> {
            switch self {
            case .sales: \.sales
            case .renewals: \.renewals
            case .trials: \.trials
            case .refunds: \.refunds
            case .cancellations: \.cancellations
            case .alerts: \.alerts
            case .funnelAlerts: \.funnelAlerts
            }
        }

        var overrideKeyPath: WritableKeyPath<AppPushOverride, Bool?> {
            switch self {
            case .sales: \.sales
            case .renewals: \.renewals
            case .trials: \.trials
            case .refunds: \.refunds
            case .cancellations: \.cancellations
            case .alerts: \.alerts
            case .funnelAlerts: \.funnelAlerts
            }
        }
    }

    var muted: Bool?
    var sales: Bool?
    var renewals: Bool?
    var trials: Bool?
    var refunds: Bool?
    var cancellations: Bool?
    var alerts: Bool?
    var funnelAlerts: Bool?

    subscript(kind: Kind) -> Bool? {
        get { self[keyPath: kind.overrideKeyPath] }
        set { self[keyPath: kind.overrideKeyPath] = newValue }
    }

    var isEmpty: Bool { muted == nil && Kind.allCases.allSatisfy { self[$0] == nil } }
}

struct Device: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String?
    var environment: String
    var prefs: DevicePrefs
    var liveActivity: Bool
    var createdAt: Double
    var lastPushAt: Double?
}

// MARK: - Apps

struct RFApp: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    /// "ios" | "android". Apple-only features (App Store Connect, Apple Ads, refund requests, offers) are iOS only.
    var platform: String
    /// iOS: the bundle id; Android: the package name.
    var bundleId: String?
    var appleAppId: String?
    var iconUrl: String?
    var commissionPct: Double
    var archived: Bool
    /// "revflare" | "other" | "none" | "unknown"
    var notificationUrlStatus: String
    var revflareNotificationUrl: String
    var currentNotificationUrl: String?
    var lastNotificationAt: Double?
    var lastHistorySyncAt: Double?
    var historyBackfilledFrom: String?
    var rcProjectId: String?
    var storeAvailable: Bool?
    /// Android apps: Google Play setup summary; nil for iOS apps and older servers.
    var googlePlay: GooglePlayStatus?
    var mrr: Double
    var revenue28d: Double
    var activeSubscriptions: Int
    var activeTrials: Int

    var isAndroid: Bool { platform == "android" }
}

/// An Android app's Google Play setup (`App.googlePlay`): real-time developer notifications and the service account.
struct GooglePlayStatus: Codable, Hashable, Sendable {
    /// Push endpoint of the Pub/Sub subscription of the app's real-time developer notifications.
    var rtdnUrl: String
    /// A Google Play service account key is set up for the app.
    var configured: Bool
    /// Pub/Sub pushes are authenticated (OIDC token of the push service account).
    var pushAuth: Bool
    /// Last service account check or Play API call.
    var lastCheck: GooglePlayCheck?

    private enum CodingKeys: String, CodingKey { case rtdnUrl, configured, pushAuth, lastCheck }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rtdnUrl = c.lenient(.rtdnUrl, "")
        configured = c.lenient(.configured, false)
        pushAuth = c.lenient(.pushAuth, false)
        lastCheck = c.lenient(.lastCheck, nil)
    }
}

struct GooglePlayCheck: Codable, Hashable, Sendable {
    /// ms
    var at: Double
    var ok: Bool
    var error: String?
}

/// Store of an app or a sale: App Store or Google Play.
enum Store {
    /// Transaction.store value of Google Play sales.
    static let playStore = "play_store"

    static func title(android: Bool) -> String {
        android ? String(localized: "Google Play") : String(localized: "App Store")
    }
}

struct AppList: Codable, Sendable {
    var items: [RFApp]
    var currency: String
}

struct Product: Codable, Hashable, Sendable, Identifiable {
    var productId: String
    var name: String?
    var type: String?
    var period: String?
    var id: String { productId }
}

/// `GET /apps/:id` → `App & { products }`.
struct AppDetail: Codable, Sendable {
    var app: RFApp
    var products: [Product]

    init(from decoder: Decoder) throws {
        app = try RFApp(from: decoder)
        let c = try decoder.container(keyedBy: Keys.self)
        products = try c.decodeIfPresent([Product].self, forKey: .products) ?? []
    }

    func encode(to encoder: Encoder) throws {
        try app.encode(to: encoder)
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(products, forKey: .products)
    }

    private enum Keys: String, CodingKey { case products }
}

// MARK: - Metrics

struct Point: Codable, Hashable, Sendable {
    var date: String
    var value: Double
}

struct Series: Codable, Hashable, Sendable, Identifiable {
    var key: String
    var label: String
    var points: [Point]
    var total: Double?
    var id: String { key }
}

struct MetricChart: Codable, Sendable {
    var metric: String
    /// "money" | "count" | "percent"
    var format: String
    var currency: String
    var interval: String
    var from: String
    var to: String
    var points: [Point]
    var total: Double
    var previousTotal: Double?
    var series: [Series]?
    var importedUntil: String?
}

struct Kpi: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var metric: String
    var label: String
    var format: String
    var value: Double
    var previous: Double?
    var change: Double?
    var spark: [Double]
}

/// A goal with its progress in the current (or, for an ended custom goal, the last) period (`GET /goals`,
/// `Overview.goals`). Decoding is tolerant: fields missing from older servers keep defaults (monthly, all apps).
struct GoalProgress: Codable, Hashable, Sendable, Identifiable {
    struct Previous: Codable, Hashable, Sendable {
        var periodStart: String
        var periodEnd: String
        var periodLabel: String
        var value: Double
        var reached: Bool
    }

    var id: String
    /// Custom name; nil = unnamed (the app builds a localized label).
    var name: String?
    /// The server's English fallback (the name, else a generated label).
    var label: String?
    /// revenue | proceeds | mrr | new_subscriptions | trials_started | active_subscriptions | sales
    var metric: String
    /// "money" | "count"
    var format: String
    /// "flow" | "stock"
    var kind: String
    /// week | month | quarter | year | custom
    var period: String
    var startDate: String?
    var endDate: String?
    var target: Double
    /// all | include | exclude
    var scope: String
    var appIds: [String]
    /// Legacy: the app of a one-app include scope.
    var appId: String?
    var archived: Bool
    var notify: Bool
    var sortOrder: Int
    var createdAt: Double?

    var periodStart: String?
    var periodEnd: String?
    var periodLabel: String
    /// upcoming | active | ended
    var status: String
    var daysTotal: Int
    var daysElapsed: Int
    var daysLeft: Int
    var current: Double
    var startValue: Double?
    var progress: Double
    var projected: Double
    var expected: Double?
    var delta: Double?
    /// upcoming | on_track | behind | reached | missed (nil from older servers: derived from progress / projection)
    var pace: String?
    var requiredPerDay: Double?
    var reachedAt: String?
    var previous: Previous?

    enum CodingKeys: String, CodingKey {
        case id, name, label, metric, format, kind, period, startDate, endDate, target, scope, appIds, appId, archived, notify, sortOrder, createdAt
        case periodStart, periodEnd, periodLabel, status, daysTotal, daysElapsed, daysLeft, current, startValue, progress, projected, expected, delta
        case pace, requiredPerDay, reachedAt, previous
    }

    init(id: String, name: String? = nil, metric: String, period: String = "month", target: Double, scope: String = "all", appIds: [String] = [],
         current: Double, progress: Double, projected: Double, periodLabel: String, pace: String? = nil, daysLeft: Int = 0) {
        self.id = id
        self.name = name
        self.metric = metric
        format = GoalMetric.isMoney(metric) ? "money" : "count"
        kind = GoalMetric.isStock(metric) ? "stock" : "flow"
        self.period = period
        self.target = target
        self.scope = scope
        self.appIds = appIds
        appId = scope == "include" && appIds.count == 1 ? appIds[0] : nil
        archived = false
        notify = false
        sortOrder = 0
        self.periodLabel = periodLabel
        status = "active"
        daysTotal = 0
        daysElapsed = 0
        self.daysLeft = daysLeft
        self.current = current
        self.progress = progress
        self.projected = projected
        self.pace = pace
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        metric = try c.decodeIfPresent(String.self, forKey: .metric) ?? "revenue"
        format = try c.decodeIfPresent(String.self, forKey: .format) ?? (GoalMetric.isMoney(metric) ? "money" : "count")
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? (GoalMetric.isStock(metric) ? "stock" : "flow")
        period = try c.decodeIfPresent(String.self, forKey: .period) ?? "month"
        startDate = try c.decodeIfPresent(String.self, forKey: .startDate)
        endDate = try c.decodeIfPresent(String.self, forKey: .endDate)
        target = try c.decodeIfPresent(Double.self, forKey: .target) ?? 0
        appId = try c.decodeIfPresent(String.self, forKey: .appId)
        let ids = try c.decodeIfPresent([String].self, forKey: .appIds)
        scope = try c.decodeIfPresent(String.self, forKey: .scope) ?? (appId == nil ? "all" : "include")
        appIds = ids ?? appId.map { [$0] } ?? []
        archived = try c.decodeIfPresent(Bool.self, forKey: .archived) ?? false
        notify = try c.decodeIfPresent(Bool.self, forKey: .notify) ?? false
        sortOrder = try c.decodeIfPresent(Int.self, forKey: .sortOrder) ?? 0
        createdAt = try c.decodeIfPresent(Double.self, forKey: .createdAt)
        periodStart = try c.decodeIfPresent(String.self, forKey: .periodStart)
        periodEnd = try c.decodeIfPresent(String.self, forKey: .periodEnd)
        periodLabel = try c.decodeIfPresent(String.self, forKey: .periodLabel) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "active"
        daysTotal = try c.decodeIfPresent(Int.self, forKey: .daysTotal) ?? 0
        daysElapsed = try c.decodeIfPresent(Int.self, forKey: .daysElapsed) ?? 0
        daysLeft = try c.decodeIfPresent(Int.self, forKey: .daysLeft) ?? 0
        current = try c.decodeIfPresent(Double.self, forKey: .current) ?? 0
        startValue = try c.decodeIfPresent(Double.self, forKey: .startValue)
        progress = try c.decodeIfPresent(Double.self, forKey: .progress) ?? (target > 0 ? current / target : 0)
        projected = try c.decodeIfPresent(Double.self, forKey: .projected) ?? current
        expected = try c.decodeIfPresent(Double.self, forKey: .expected)
        delta = try c.decodeIfPresent(Double.self, forKey: .delta)
        pace = try c.decodeIfPresent(String.self, forKey: .pace)
        requiredPerDay = try c.decodeIfPresent(Double.self, forKey: .requiredPerDay)
        reachedAt = try c.decodeIfPresent(String.self, forKey: .reachedAt)
        previous = try c.decodeIfPresent(Previous.self, forKey: .previous)
    }
}

/// `GET /goals`.
struct GoalList: Codable, Sendable {
    var currency: String?
    var items: [GoalProgress]
}

/// `GET /goals/:id`, `POST /goals`, `PATCH /goals/:id`.
struct GoalResponse: Codable, Sendable {
    var id: String?
    var currency: String?
    var goal: GoalProgress
}

/// `POST /goals` body; `PATCH /goals/:id` sends the same fields. `name`, `startDate` and `endDate` are sent as
/// explicit nulls to clear them.
struct GoalInput: Encodable, Sendable {
    var name: String?
    var metric: String
    var target: Double
    var period: String
    var startDate: String?
    var endDate: String?
    var scope: String
    var appIds: [String]
    var notify: Bool

    enum CodingKeys: String, CodingKey { case name, metric, target, period, startDate, endDate, scope, appIds, notify }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(metric, forKey: .metric)
        try c.encode(target, forKey: .target)
        try c.encode(period, forKey: .period)
        try c.encode(startDate, forKey: .startDate)
        try c.encode(endDate, forKey: .endDate)
        try c.encode(scope, forKey: .scope)
        try c.encode(appIds, forKey: .appIds)
        try c.encode(notify, forKey: .notify)
    }
}

/// A goal edit: only the fields set are sent (PATCH), so saving an unchanged definition does not re-arm the push.
struct GoalPatch: Encodable, Sendable {
    /// `.some(nil)` clears the name.
    var name: String?? = nil
    var metric: String?
    var target: Double?
    var period: String?
    /// Sent together with the period's dates (null for a rolling period).
    var dates: (start: String?, end: String?)?
    var scope: String?
    var appIds: [String]?
    var notify: Bool?

    var isEmpty: Bool {
        name == nil && metric == nil && target == nil && period == nil && dates == nil && scope == nil && appIds == nil && notify == nil
    }

    enum CodingKeys: String, CodingKey { case name, metric, target, period, startDate, endDate, scope, appIds, notify }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let name { try c.encode(name, forKey: .name) }
        try c.encodeIfPresent(metric, forKey: .metric)
        try c.encodeIfPresent(target, forKey: .target)
        try c.encodeIfPresent(period, forKey: .period)
        if let dates {
            try c.encode(dates.start, forKey: .startDate)
            try c.encode(dates.end, forKey: .endDate)
        }
        try c.encodeIfPresent(scope, forKey: .scope)
        try c.encodeIfPresent(appIds, forKey: .appIds)
        try c.encodeIfPresent(notify, forKey: .notify)
    }
}

struct Overview: Codable, Sendable {
    struct Today: Codable, Hashable, Sendable {
        var revenue: Double
        var proceeds: Double
        var sales: Int
        var newSubscriptions: Int
        var trialsStarted: Int
        var refunds: Int
        var date: String
    }
    struct Yesterday: Codable, Hashable, Sendable {
        var revenue: Double
        var proceeds: Double
        var sales: Int
    }
    struct Movement: Codable, Hashable, Sendable {
        var new: Double
        var expansion: Double
        var contraction: Double
        var churn: Double
        var reactivation: Double
        var net: Double
    }
    struct AtRiskSummary: Codable, Hashable, Sendable {
        var mrr: Double
        var subscriptions: Int
    }
    struct DayValue: Codable, Hashable, Sendable {
        var date: String
        var revenue: Double
    }
    struct Records: Codable, Hashable, Sendable {
        var bestDay: DayValue?
        var todayIsRecord: Bool
        var bestMonth: DayValue?
    }
    struct TopApp: Codable, Hashable, Sendable, Identifiable {
        var appId: String
        var name: String
        var iconUrl: String?
        var revenue28d: Double
        var mrr: Double
        var change: Double?
        /// "ios" | "android"; nil from older servers.
        var platform: String?
        var id: String { appId }
        var isAndroid: Bool { platform == "android" }
    }

    var currency: String
    var asOf: Double
    var today: Today
    var yesterday: Yesterday
    var kpis: [Kpi]
    var mrrMovement: Movement
    var atRisk: AtRiskSummary
    var forecast30: Double
    var goals: [GoalProgress]
    var records: Records
    var topApps: [TopApp]
    var alerts: [RFAlert]

    func kpi(_ id: String) -> Kpi? { kpis.first { $0.id == id } }
}

struct MrrMovement: Codable, Sendable {
    struct Row: Codable, Hashable, Sendable {
        var date: String
        var new: Double
        var expansion: Double
        var contraction: Double
        var churn: Double
        var reactivation: Double
        var net: Double
        var mrr: Double
    }
    var currency: String
    var interval: String
    var points: [Row]
}

struct Breakdown: Codable, Sendable {
    struct Row: Codable, Hashable, Sendable, Identifiable {
        var key: String
        var label: String
        var value: Double
        var share: Double
        var iconUrl: String?
        var appId: String?
        var id: String { key }
    }
    var metric: String
    var by: String
    var currency: String
    var from: String
    var to: String
    var rows: [Row]
}

struct Transaction: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var appId: String
    var appName: String
    var appIconUrl: String?
    var customerId: String?
    var transactionId: String
    var originalTransactionId: String
    var productId: String
    var productName: String?
    /// "trial" | "conversion" | "new" | "renewal" | "one_time"
    var kind: String
    var purchasedAt: Double
    var expiresAt: Double?
    var price: Double
    var storeCurrency: String?
    var storePrice: Double
    var proceeds: Double
    var country: String?
    var environment: String
    var refundedAt: Double?
    /// Percentage refunded (100 = full, e.g. 40 for a prorated refund).
    var refundPercentage: Double?
    var offer: String?
    var source: String
    /// Acquisition of the install that made the purchase (RevflareKit); nil from older servers.
    var attribution: AdsAttribution?
    /// Feed, subscription rows: the subscription's current auto-renew state (false: cancelled); nil for one-time purchases and older servers.
    var autoRenew: Bool?
    /// "app_store" | "play_store"; nil from older servers (App Store).
    var store: String?
    /// Feed / customer: ms from the RevflareKit install to this purchase (the customer's first purchase / trial); nil when unknown.
    var sinceInstallMs: Double?
    /// Feed, subscription rows: ms from this purchase to auto-renew being turned off within its period; nil otherwise.
    var cancelledAfterMs: Double?
    /// Cancellation rows: ms since the subscription's latest purchase / trial start.
    var sincePurchaseMs: Double?
    /// Cancellation rows: kind of that purchase ("trial": a trial was cancelled).
    var purchaseKind: String?
    /// Bought within 5 minutes of the install, or cancelled within 5 minutes of the purchase.
    var quick: Bool?

    var isPlayStore: Bool { store == Store.playStore }
    /// Auto-renew turned off (cancellations stream).
    var isCancellation: Bool { kind == "cancellation" }

    /// The duration the "⚡" chip shows: the cancellation's time since the purchase, else the time since the install, else since the purchase to the cancellation.
    var quickDurationMs: Double? {
        guard quick == true else { return nil }
        if isCancellation { return sincePurchaseMs }
        if let s = sinceInstallMs, Quick.isQuick(s) { return s }
        return cancelledAfterMs
    }

    /// A trial whose subscription has auto-renew off and that has not ended yet.
    var isCancelledTrial: Bool {
        kind == "trial" && autoRenew == false && (expiresAt ?? 0) > Date().timeIntervalSince1970 * 1000
    }
}

struct Page<T: Codable & Sendable>: Codable, Sendable {
    var items: [T]
    var nextCursor: String?
    /// Transactions feed: totals of each day the page touches (local days, `tzOffset`), newest first.
    var days: [FeedDay]?
    /// Currency of the amounts (`GET /transactions`).
    var currency: String?
}

/// Totals of one feed day over the whole day with the feed's filters (refunded sales excluded from the amounts).
struct FeedDay: Codable, Hashable, Sendable {
    /// "YYYY-MM-DD", local day of the `tzOffset` sent.
    var date: String
    var revenue: Double
    var proceeds: Double
    var sales: Int
    var count: Int
}

struct Subscription: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var appId: String
    var appName: String
    var customerId: String?
    var originalTransactionId: String
    var productId: String
    var productName: String?
    /// "trial" | "active" | "grace" | "billing_retry" | "expired" | "revoked" | "refunded"
    var status: String
    var autoRenew: Bool
    var startedAt: Double
    var expiresAt: Double?
    var period: String?
    var mrr: Double
    var country: String?
    /// Customer endpoint: when auto-renew was turned off (ms); nil while on, unknown or from older servers.
    var autoRenewOffAt: Double?
    /// Google Play: why it was cancelled, "user[:<survey reason>]" | "system" | "developer" | "replacement"; nil otherwise.
    var cancelReason: String?
    /// Customer endpoint: ms from the latest purchase / trial start before `autoRenewOffAt` to it.
    var cancelledAfterMs: Double?

    /// Who cancelled it (Google Play), e.g. "By the user"; nil when unknown.
    var cancelReasonTitle: String? {
        guard let reason = cancelReason, !reason.isEmpty else { return nil }
        switch reason.split(separator: ":", maxSplits: 1).first.map(String.init) ?? reason {
        case "user": return String(localized: "By the user")
        case "system": return String(localized: "By Google Play (billing)")
        case "developer": return String(localized: "By the developer")
        case "replacement": return String(localized: "Replaced by a new plan")
        default: return reason
        }
    }

    /// Running (trial / active / grace / billing retry) with auto-renew off: it ends at `expiresAt`.
    var isCancelled: Bool {
        !autoRenew && ["trial", "active", "grace", "billing_retry"].contains(status)
    }
}

/// One Apple notification of a customer's subscriptions / purchases (customer history).
struct CustomerEvent: Codable, Hashable, Sendable {
    /// Apple notificationType, e.g. "SUBSCRIBED", "DID_CHANGE_RENEWAL_STATUS".
    var type: String
    var subtype: String?
    /// Apple signedDate (ms).
    var at: Double
    var productId: String?
    var environment: String?
    var transactionId: String?
}

/// "Quick" buyers and cancellers: within 5 minutes (inclusive), like the server's `QUICK_ACTION_MS`.
enum Quick {
    static let thresholdMs: Double = 5 * 60_000
    static func isQuick(_ ms: Double?) -> Bool {
        guard let ms else { return false }
        return ms >= 0 && ms <= thresholdMs
    }
}

/// How fast a customer bought, cancelled and asked for a refund (`GET /customers/:id` → `timing`).
struct CustomerTiming: Codable, Hashable, Sendable {
    var firstPurchaseAt: Double?
    var firstPurchaseKind: String?
    /// Install (RevflareKit) → first purchase / trial start.
    var installToPurchaseMs: Double?
    /// Fastest purchase / trial start → auto-renew off.
    var purchaseToCancelMs: Double?
    var cancelledAt: Double?
    /// Fastest purchase → refund.
    var purchaseToRefundMs: Double?
    var refundedAt: Double?
    var quickPurchase: Bool
    var quickCancel: Bool
}

struct Customer: Codable, Sendable, Identifiable {
    var id: String
    var appId: String
    var appName: String
    var country: String?
    /// Earliest of the RevflareKit install and the first transaction.
    var firstSeenAt: Double
    /// "install" | "purchase"; nil from older servers.
    var firstSeenSource: String?
    var firstPaidAt: Double?
    /// Latest of the app's activity (RevflareKit), transactions and store notifications.
    var lastSeenAt: Double
    /// "app" | "purchase" | "notification"; nil from older servers.
    var lastSeenSource: String?
    /// RevflareKit install time; nil when no install is linked (or older servers).
    var installedAt: Double?
    /// "device" | "first_report"
    var installedAtSource: String?
    var timing: CustomerTiming?
    var totalSpent: Double
    var totalProceeds: Double
    var appAccountToken: String?
    var rcAppUserId: String?
    var refundDataConsent: Bool?
    /// Acquisition of the install of the customer's first linked transaction; nil from older servers.
    var attribution: AdsAttribution?
    var subscriptions: [Subscription]
    var transactions: [Transaction]
    /// Apple notification history, newest first; nil from older servers.
    var events: [CustomerEvent]?
}

// MARK: - Apple Ads attribution (RevflareKit)

/// Acquisition of a purchase or customer: the RevflareKit install linked to it and what Apple said about it.
/// Ids and names only for `apple_ads` (names nil when unknown: show "#<id>").
struct AdsAttribution: Codable, Hashable, Sendable {
    /// "apple_ads" | "google_ads" | "referral" | "organic" | "unknown" (google_ads / referral: Android Play Install Referrer)
    var source: String
    /// Apple's AdServices test payload (development / TestFlight builds).
    var test: Bool
    var campaignId: String?
    var campaignName: String?
    var adGroupId: String?
    var adGroupName: String?
    var keywordId: String?
    var keywordName: String?

    var isAppleAds: Bool { source == "apple_ads" }
    /// Paid ad install: Apple Ads or Google Ads.
    var isAds: Bool { source == "apple_ads" || source == "google_ads" }

    /// Label of an acquisition source value (INSTALL_SOURCES in shared/types.ts).
    static func sourceTitle(_ source: String) -> String {
        switch source {
        case "apple_ads": String(localized: "Apple Ads")
        case "google_ads": String(localized: "Google Ads")
        case "referral": String(localized: "Referral")
        case "organic": String(localized: "Organic")
        default: String(localized: "Unknown")
        }
    }

    private enum CodingKeys: String, CodingKey { case source, test, campaignId, campaignName, adGroupId, adGroupName, keywordId, keywordName }

    init(source: String = "unknown", test: Bool = false) {
        self.source = source
        self.test = test
    }

    /// Never throws: a missing or odd payload is "unknown"; ids sent as numbers are kept as strings.
    init(from decoder: Decoder) throws {
        self.init()
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        source = c.lenient(.source, "unknown")
        test = c.lenient(.test, false)
        campaignId = c.idString(.campaignId)
        campaignName = c.lenient(.campaignName, nil)
        adGroupId = c.idString(.adGroupId)
        adGroupName = c.lenient(.adGroupName, nil)
        keywordId = c.idString(.keywordId)
        keywordName = c.lenient(.keywordName, nil)
    }

    /// A campaign / ad group / keyword: its name, else "#<id>", else nil.
    static func label(name: String?, id: String?) -> String? {
        if let name, !name.isEmpty { return name }
        if let id, !id.isEmpty { return "#\(id)" }
        return nil
    }
}

extension KeyedDecodingContainer {
    /// An Apple Ads id sent as a string or a number.
    func idString(_ key: Key) -> String? {
        if let s = (try? decodeIfPresent(String.self, forKey: key)) ?? nil { return s }
        if let n = (try? decodeIfPresent(Int64.self, forKey: key)) ?? nil { return String(n) }
        return nil
    }
}

/// `GET /revenue/attributed`: revenue of installs Apple attributed to Apple Ads, per day × campaign / ad group / keyword.
struct AttributedRevenue: Codable, Sendable {
    struct Coverage: Codable, Hashable, Sendable {
        /// Installs that reported to RevflareKit in the range.
        var installs: Int
        /// Of them, attributed to Apple Ads (test attribution never counts).
        var attributed: Int
        /// Installs with Apple's test attribution (hidden unless includeTest).
        var testInstalls: Int

        private enum CodingKeys: String, CodingKey { case installs, attributed, testInstalls }

        init(installs: Int = 0, attributed: Int = 0, testInstalls: Int = 0) {
            self.installs = installs
            self.attributed = attributed
            self.testInstalls = testInstalls
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            installs = c.lenient(.installs, 0)
            attributed = c.lenient(.attributed, 0)
            testInstalls = c.lenient(.testInstalls, 0)
        }
    }

    struct Row: Codable, Hashable, Sendable {
        var date: String
        var appId: String
        var campaignId: String
        var adGroupId: String?
        var keywordId: String?
        var campaignName: String?
        var adGroupName: String?
        var keywordName: String?
        var test: Bool
        var revenue: Double
        var proceeds: Double
        var transactions: Double
        var trials: Double
        var installs: Double
        var payers: Double

        private enum CodingKeys: String, CodingKey {
            case date, appId, campaignId, adGroupId, keywordId, campaignName, adGroupName, keywordName, test
            case revenue, proceeds, transactions, trials, installs, payers
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            date = c.lenient(.date, "")
            appId = c.lenient(.appId, "")
            campaignId = c.idString(.campaignId) ?? ""
            adGroupId = c.idString(.adGroupId)
            keywordId = c.idString(.keywordId)
            campaignName = c.lenient(.campaignName, nil)
            adGroupName = c.lenient(.adGroupName, nil)
            keywordName = c.lenient(.keywordName, nil)
            test = c.lenient(.test, false)
            revenue = c.lenient(.revenue, 0)
            proceeds = c.lenient(.proceeds, 0)
            transactions = c.lenient(.transactions, 0)
            trials = c.lenient(.trials, 0)
            installs = c.lenient(.installs, 0)
            payers = c.lenient(.payers, 0)
        }
    }

    var currency: String
    var from: String
    var to: String
    var includeTest: Bool
    var coverage: Coverage
    var rows: [Row]

    private enum CodingKeys: String, CodingKey { case currency, from, to, includeTest, coverage, rows }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        currency = c.lenient(.currency, "USD")
        from = c.lenient(.from, "")
        to = c.lenient(.to, "")
        includeTest = c.lenient(.includeTest, false)
        coverage = c.lenient(.coverage, Coverage())
        rows = c.lenient(.rows, [])
    }
}

struct AtRisk: Codable, Sendable {
    struct Group: Codable, Hashable, Sendable, Identifiable {
        var reason: String
        var label: String
        var mrr: Double
        var subscriptions: Int
        var id: String { reason }
    }
    var currency: String
    var mrr: Double
    var groups: [Group]
    var items: [Subscription]
}

struct Forecast: Codable, Sendable {
    struct Row: Codable, Hashable, Sendable {
        var date: String
        var due: Double
        var expected: Double
    }
    var currency: String
    var days: Int
    var expected: Double
    var renewalRates: [String: Double]
    var points: [Row]
}

struct RFAlert: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var appId: String?
    /// "notifications_silent" | "sync_failing" | "revenue_drop" | "refund_spike" | "events_silent" | "funnel_anomaly" | "release_regression" | "experiment_result" | "key_events_capped" | "google_play_test" | "refund_request_unanswered"
    var kind: String
    /// funnel_anomaly / release_regression: the app's funnel the alert is about.
    var funnelId: String?
    /// experiment_result: the app's experiment the alert is about (results at /apps/:appId/experiments/:experimentId).
    var experimentId: String?
    /// "info" | "warning" | "critical"
    var severity: String
    var title: String
    var body: String
    var createdAt: Double
    var resolvedAt: Double?
}

struct OKResponse: Codable, Sendable {
    var ok: Bool?
}

struct ItemsResponse<T: Codable & Sendable>: Codable, Sendable {
    var items: [T]
}

// MARK: - Metric catalogue (METRICS in shared/types.ts)

enum MetricFormat: String, Sendable { case money, count, percent }

struct MetricInfo: Identifiable, Hashable, Sendable {
    static func == (a: MetricInfo, b: MetricInfo) -> Bool { a.id == b.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }

    let id: String
    let title: LocalizedStringResource
    let format: MetricFormat
    /// Stocks (MRR, actives) show the last value; flows are summed.
    let isStock: Bool

    static let all: [MetricInfo] = [
        .init(id: "revenue", title: "Revenue", format: .money, isStock: false),
        .init(id: "proceeds", title: "Proceeds", format: .money, isStock: false),
        .init(id: "mrr", title: "MRR", format: .money, isStock: true),
        .init(id: "mrr_proceeds", title: "MRR (net)", format: .money, isStock: true),
        .init(id: "arr", title: "ARR", format: .money, isStock: true),
        .init(id: "active_subscriptions", title: "Active subscriptions", format: .count, isStock: true),
        .init(id: "active_trials", title: "Active trials", format: .count, isStock: true),
        .init(id: "new_subscriptions", title: "New subscriptions", format: .count, isStock: false),
        .init(id: "renewals", title: "Renewals", format: .count, isStock: false),
        .init(id: "one_time_purchases", title: "One-time purchases", format: .count, isStock: false),
        .init(id: "trials_started", title: "Trials started", format: .count, isStock: false),
        .init(id: "trial_conversions", title: "Trial conversions", format: .count, isStock: false),
        .init(id: "trial_conversion_rate", title: "Trial conversion rate", format: .percent, isStock: true),
        .init(id: "refunds", title: "Refunds", format: .count, isStock: false),
        .init(id: "refunds_amount", title: "Refunded amount", format: .money, isStock: false),
        .init(id: "refund_rate", title: "Refund rate", format: .percent, isStock: true),
        .init(id: "churn_rate", title: "Churn rate", format: .percent, isStock: true),
        .init(id: "churned_subscriptions", title: "Churned subscriptions", format: .count, isStock: false),
        .init(id: "new_customers", title: "New customers", format: .count, isStock: false),
        .init(id: "arppu", title: "Revenue per subscriber", format: .money, isStock: true),
    ]

    static func info(_ id: String) -> MetricInfo {
        all.first { $0.id == id } ?? MetricInfo(id: id, title: LocalizedStringResource(stringLiteral: id), format: .count, isStock: false)
    }

    /// Metrics where a lower value is better (the change pill turns green when they fall).
    var lowerIsBetter: Bool { ["churn_rate", "churned_subscriptions", "refunds", "refunds_amount", "refund_rate"].contains(id) }
}

// MARK: - Events and funnels (RevflareKit events in Workers Analytics Engine)

extension KeyedDecodingContainer {
    /// A missing, null or mistyped value falls back to `fallback` (analytics payloads may grow or change).
    func lenient<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
    }
}

/// `GET /apps/:id/analytics/status`.
struct AnalyticsStatus: Codable, Hashable, Sendable {
    /// The server stores events (`EVENTS` binding).
    var ingest: Bool
    /// The server can query events (`CF_ACCOUNT_ID` + `CF_ANALYTICS_TOKEN`).
    var query: Bool
    var dataset: String
    /// What is missing on the server, in words (English, from the server).
    var missing: [String]
    /// Last production events (ms); `lastTestEventAt`: last sandbox / Xcode events.
    var lastEventAt: Double?
    var lastTestEventAt: Double?
    var sdkKey: String?

    var configured: Bool { ingest && query }

    private enum CodingKeys: String, CodingKey { case ingest, query, dataset, missing, lastEventAt, lastTestEventAt, sdkKey }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ingest = c.lenient(.ingest, false)
        query = c.lenient(.query, false)
        dataset = c.lenient(.dataset, "")
        missing = c.lenient(.missing, [])
        lastEventAt = c.lenient(.lastEventAt, nil)
        lastTestEventAt = c.lenient(.lastTestEventAt, nil)
        sdkKey = c.lenient(.sdkKey, nil)
    }
}

/// `GET /apps/:id/events/summary`. Counts are weighted by the sample interval (may be fractional when sampled).
struct EventSummary: Codable, Sendable {
    struct Event: Codable, Hashable, Sendable, Identifiable {
        var name: String
        var count: Double
        var installs: Double
        var lastSeenAt: Double?
        /// "exact" (key event stored in the database) | "sampled" (Analytics Engine); nil from older servers.
        var source: String?
        var id: String { name }

        private enum CodingKeys: String, CodingKey { case name, count, installs, lastSeenAt, source }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = c.lenient(.name, "")
            count = c.lenient(.count, 0)
            installs = c.lenient(.installs, 0)
            lastSeenAt = c.lenient(.lastSeenAt, nil)
            source = c.lenient(.source, nil)
        }
    }

    struct Day: Codable, Hashable, Sendable {
        var date: String
        var count: Double
        var byEvent: [String: Double]

        private enum CodingKeys: String, CodingKey { case date, count, byEvent }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            date = c.lenient(.date, "")
            count = c.lenient(.count, 0)
            byEvent = c.lenient(.byEvent, [:])
        }
    }

    var appId: String
    var from: String
    var to: String
    var days: Int
    var totalEvents: Double
    var uniqueInstalls: Double
    var events: [Event]
    var daily: [Day]
    var approximate: Bool
    /// Test data counted (sandbox / Xcode builds and test devices); nil from older servers.
    var includeTest: Bool?
    /// Why some counts are not exact; nil from older servers.
    var notes: [String]?
    var generatedAt: Double?

    private enum CodingKeys: String, CodingKey { case appId, from, to, days, totalEvents, uniqueInstalls, events, daily, approximate, includeTest, notes, generatedAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        appId = c.lenient(.appId, "")
        from = c.lenient(.from, "")
        to = c.lenient(.to, "")
        days = c.lenient(.days, 0)
        totalEvents = c.lenient(.totalEvents, 0)
        uniqueInstalls = c.lenient(.uniqueInstalls, 0)
        events = c.lenient(.events, [])
        daily = c.lenient(.daily, [])
        approximate = c.lenient(.approximate, false)
        includeTest = c.lenient(.includeTest, nil)
        notes = c.lenient(.notes, nil)
        generatedAt = c.lenient(.generatedAt, nil)
    }
}

/// One funnel step: `{ type: "event", name, filters?, label? }` or `{ type: "revenue", kind, label? }`.
struct FunnelStep: Codable, Hashable, Sendable {
    struct Filter: Codable, Hashable, Sendable {
        var key: String
        var value: String
    }

    /// "event" | "revenue"
    var type: String
    var name: String?
    /// Revenue steps: "trial_started" | "paid" | "any_purchase".
    var kind: String?
    var filters: [Filter]
    var label: String?

    private enum CodingKeys: String, CodingKey { case type, name, kind, filters, label }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = c.lenient(.type, "event")
        name = c.lenient(.name, nil)
        kind = c.lenient(.kind, nil)
        filters = c.lenient(.filters, [])
        label = c.lenient(.label, nil)
    }
}

struct Funnel: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var appId: String
    var name: String
    var steps: [FunnelStep]
    var windowSeconds: Double
    var ordered: Bool
    var alerts: FunnelAlertSettings
    var createdAt: Double?
    var updatedAt: Double?

    private enum CodingKeys: String, CodingKey { case id, appId, name, steps, windowSeconds, ordered, alerts, createdAt, updatedAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        appId = c.lenient(.appId, "")
        name = c.lenient(.name, id)
        steps = c.lenient(.steps, [])
        windowSeconds = c.lenient(.windowSeconds, 7 * 86_400)
        ordered = c.lenient(.ordered, true)
        alerts = c.lenient(.alerts, FunnelAlertSettings())
        createdAt = c.lenient(.createdAt, nil)
        updatedAt = c.lenient(.updatedAt, nil)
    }
}

/// A funnel's anomaly alerts (older servers have none: on, "normal").
struct FunnelAlertSettings: Codable, Hashable, Sendable {
    var enabled: Bool = true
    /// "high" | "normal" | "low"
    var sensitivity: String = "normal"

    private enum CodingKeys: String, CodingKey { case enabled, sensitivity }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = c.lenient(.enabled, true)
        sensitivity = c.lenient(.sensitivity, "normal")
    }
}

struct FunnelReportStep: Codable, Hashable, Sendable, Identifiable {
    var index: Int
    var label: String
    var users: Double
    /// 0...1 of the previous step (1 for the first step).
    var conversionFromPrevious: Double
    /// 0...1 of the first step.
    var conversionFromFirst: Double
    var dropOff: Double
    var medianSecondsFromPrevious: Double?
    var id: Int { index }

    private enum CodingKeys: String, CodingKey { case index, label, users, conversionFromPrevious, conversionFromFirst, dropOff, medianSecondsFromPrevious }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        index = c.lenient(.index, 0)
        label = c.lenient(.label, "")
        users = c.lenient(.users, 0)
        conversionFromPrevious = c.lenient(.conversionFromPrevious, 0)
        conversionFromFirst = c.lenient(.conversionFromFirst, 0)
        dropOff = c.lenient(.dropOff, 0)
        medianSecondsFromPrevious = c.lenient(.medianSecondsFromPrevious, nil)
    }
}

/// `GET /apps/:id/funnels/:fid/report`.
struct FunnelReport: Codable, Sendable {
    struct Group: Codable, Hashable, Sendable, Identifiable {
        var value: String
        var steps: [FunnelReportStep]
        var id: String { value }

        private enum CodingKeys: String, CodingKey { case value, steps }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            value = c.lenient(.value, "")
            steps = c.lenient(.steps, [])
        }
    }

    var funnel: Funnel?
    var from: String
    var to: String
    var breakdown: String?
    var steps: [FunnelReportStep]
    var groups: [Group]
    var approximate: Bool
    /// "exact" (every event step from stored key events) | "sampled" (Analytics Engine); nil from older servers.
    var source: String?
    var notes: [String]
    /// Test data counted (sandbox / Xcode builds and test devices); nil from older servers.
    var includeTest: Bool?
    var generatedAt: Double?

    private enum CodingKeys: String, CodingKey { case funnel, from, to, breakdown, steps, groups, approximate, source, notes, includeTest, generatedAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        funnel = c.lenient(.funnel, nil)
        from = c.lenient(.from, "")
        to = c.lenient(.to, "")
        breakdown = c.lenient(.breakdown, nil)
        steps = (c.lenient(.steps, []) as [FunnelReportStep]).sorted { $0.index < $1.index }
        groups = c.lenient(.groups, [])
        approximate = c.lenient(.approximate, false)
        source = c.lenient(.source, nil)
        notes = c.lenient(.notes, [])
        includeTest = c.lenient(.includeTest, nil)
        generatedAt = c.lenient(.generatedAt, nil)
    }
}

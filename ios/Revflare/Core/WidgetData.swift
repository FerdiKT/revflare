import Foundation

/// What the widgets, the control and Siri show: built from `GET /overview`, cached in the App Group so a widget
/// still renders the last numbers offline.
struct WidgetSnapshot: Codable, Sendable {
    var workspaceName: String?
    var appId: String?
    var appName: String?
    var currency: String
    var todayRevenue: Double
    var todayProceeds: Double
    var sales: Int
    var yesterdayRevenue: Double
    var yesterdayProceeds: Double
    var mrr: Double
    var mrrChange: Double?
    var mrrSpark: [Double]
    var revenue28d: Double
    var proceeds28d: Double
    var revenue28dChange: Double?
    var revenueSpark: [Double]
    var proceedsSpark: [Double]
    var activeSubscriptions: Double
    var activeTrials: Double
    var topApps: [Overview.TopApp]
    var todayIsRecord: Bool
    /// The first goal for this widget (an app widget: a goal on that app only); `goals`: the first few (nil in
    /// snapshots cached by older builds).
    var goal: GoalProgress?
    var goals: [GoalProgress]?
    var asOf: Date

    init(_ o: Overview, appId: String?, appName: String?) {
        workspaceName = SharedSettings.workspaceName
        self.appId = appId
        self.appName = appName
        currency = o.currency
        todayRevenue = o.today.revenue
        todayProceeds = o.today.proceeds
        sales = o.today.sales
        yesterdayRevenue = o.yesterday.revenue
        yesterdayProceeds = o.yesterday.proceeds
        let mrrKpi = o.kpi("mrr")
        mrr = mrrKpi?.value ?? 0
        mrrChange = mrrKpi?.change
        mrrSpark = mrrKpi?.spark ?? []
        let rev = o.kpi("revenue_28d")
        let proc = o.kpi("proceeds_28d")
        revenue28d = rev?.value ?? 0
        proceeds28d = proc?.value ?? 0
        revenue28dChange = rev?.change
        revenueSpark = rev?.spark ?? []
        proceedsSpark = proc?.spark ?? []
        activeSubscriptions = o.kpi("active_subscriptions")?.value ?? 0
        activeTrials = o.kpi("active_trials")?.value ?? 0
        topApps = o.topApps
        todayIsRecord = o.records.todayIsRecord
        let shown = o.goals.filter { g in
            guard !g.archived else { return false }
            guard let appId else { return true }
            return g.scope == "include" && g.appIds == [appId]
        }
        goal = shown.first
        goals = Array(shown.prefix(3))
        asOf = Date(timeIntervalSince1970: o.asOf / 1000)
    }

    var showProceeds: Bool { SharedSettings.showProceeds }
    var today: Double { showProceeds ? todayProceeds : todayRevenue }
    var yesterday: Double { showProceeds ? yesterdayProceeds : yesterdayRevenue }
    var last28: Double { showProceeds ? proceeds28d : revenue28d }
    var spark: [Double] { showProceeds ? proceedsSpark : revenueSpark }

    static let preview: WidgetSnapshot = {
        var s = WidgetSnapshot.empty
        s.workspaceName = "Revflare"
        s.todayRevenue = 412.37
        s.todayProceeds = 350.51
        s.sales = 37
        s.yesterdayRevenue = 389.9
        s.yesterdayProceeds = 331.4
        s.mrr = 8_420
        s.mrrChange = 0.064
        s.mrrSpark = (0..<28).map { 7_800 + Double($0) * 22 + sin(Double($0)) * 40 }
        s.revenue28d = 11_284
        s.proceeds28d = 9_591
        s.revenue28dChange = 0.12
        s.revenueSpark = (0..<28).map { 340 + sin(Double($0) / 2.5) * 70 + Double($0) * 3 }
        s.proceedsSpark = s.revenueSpark.map { $0 * 0.85 }
        s.activeSubscriptions = 1_284
        s.activeTrials = 96
        s.topApps = [
            .init(appId: "a", name: "Photo Lab", iconUrl: nil, revenue28d: 4_210, mrr: 2_900, change: 0.18),
            .init(appId: "b", name: "Naturefulness", iconUrl: nil, revenue28d: 3_105, mrr: 2_410, change: 0.04),
            .init(appId: "c", name: "Safekeep", iconUrl: nil, revenue28d: 1_870, mrr: 1_320, change: -0.06),
            .init(appId: "d", name: "Recast", iconUrl: nil, revenue28d: 1_120, mrr: 880, change: 0.31),
            .init(appId: "e", name: "Postflare", iconUrl: nil, revenue28d: 640, mrr: 410, change: nil),
        ]
        s.goal = GoalProgress(id: "g", name: "October push", metric: "revenue", period: "month", target: 15_000, current: 6_480, progress: 0.432,
                              projected: 13_100, periodLabel: "2026-10", pace: "behind", daysLeft: 6)
        s.goals = [
            s.goal!,
            GoalProgress(id: "h", metric: "mrr", period: "quarter", target: 10_000, current: 8_420, progress: 0.842, projected: 8_420,
                         periodLabel: "2026-Q4", pace: "on_track", daysLeft: 66),
            GoalProgress(id: "i", metric: "trials_started", period: "week", target: 400, current: 412, progress: 1.03, projected: 520,
                         periodLabel: "2026-W44", pace: "reached", daysLeft: 6),
        ]
        return s
    }()

    static let empty = WidgetSnapshot()

    private init() {
        currency = SharedSettings.currency
        todayRevenue = 0; todayProceeds = 0; sales = 0; yesterdayRevenue = 0; yesterdayProceeds = 0
        mrr = 0; mrrSpark = []; revenue28d = 0; proceeds28d = 0; revenueSpark = []; proceedsSpark = []
        activeSubscriptions = 0; activeTrials = 0; topApps = []; todayIsRecord = false; asOf = Date()
    }
}

enum WidgetData {
    static func cacheKey(appId: String?) -> String { ResponseCache.key("widget", appId ?? "all") }

    static func cached(appId: String?) -> WidgetSnapshot? {
        ResponseCache.load(WidgetSnapshot.self, key: cacheKey(appId: appId))
    }

    static func store(_ overview: Overview, appId: String?, appName: String?) {
        ResponseCache.store(WidgetSnapshot(overview, appId: appId, appName: appName), key: cacheKey(appId: appId))
    }

    /// Set when the server answered `503 { code: "quota" }`: its daily database limit resets at this time.
    nonisolated(unsafe) private static var quotaResetAt: Date?

    /// When the timeline should refresh: normally after `interval`; while the server is over its daily limit, right
    /// after the reset (00:00 UTC) instead of failing every 15 minutes. Until then the cached snapshot stays.
    static func nextRefresh(after interval: TimeInterval) -> Date {
        let normal = Date().addingTimeInterval(interval)
        guard let reset = quotaResetAt, reset > .now else { return normal }
        return max(normal, reset.addingTimeInterval(60))
    }

    /// Fresh numbers from the server (cached), else the last cached ones; nil when signed out and nothing is cached.
    static func load(appId: String?, appName: String?) async -> WidgetSnapshot? {
        if let client = APIClient.current() {
            if let reset = quotaResetAt, reset > .now { return cached(appId: appId) }
            do {
                let o = try await client.overview(apps: appId.map { [$0] } ?? [])
                let snap = WidgetSnapshot(o, appId: appId, appName: appName)
                ResponseCache.store(snap, key: cacheKey(appId: appId))
                for app in o.topApps.prefix(5) { _ = await ResponseCache.icon(app.iconUrl) }
                quotaResetAt = nil
                return snap
            } catch let error as APIError where error.isQuota {
                quotaResetAt = APIError.quotaReset()
            } catch {}
        }
        return cached(appId: appId)
    }
}

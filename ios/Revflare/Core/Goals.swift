import Foundation
import SwiftUI

/// Goal metrics, periods and scopes (shared/types.ts GOAL_METRICS, GOAL_PERIODS, GOAL_SCOPES) and their texts.
/// Shared with the widgets: everything here is built on the device, in the device's language.
enum GoalMetric {
    static let all = ["revenue", "proceeds", "mrr", "new_subscriptions", "trials_started", "active_subscriptions", "sales"]
    static let money = ["revenue", "proceeds", "mrr"]
    static let counts = ["new_subscriptions", "trials_started", "active_subscriptions", "sales"]

    static func isMoney(_ metric: String) -> Bool { money.contains(metric) }
    /// A level (today's value) rather than a sum over the period.
    static func isStock(_ metric: String) -> Bool { metric == "mrr" || metric == "active_subscriptions" }

    static func title(_ metric: String) -> String {
        switch metric {
        case "revenue": String(localized: "Revenue")
        case "proceeds": String(localized: "Proceeds")
        case "mrr": String(localized: "MRR")
        case "new_subscriptions": String(localized: "New subscriptions")
        case "trials_started": String(localized: "Trials started")
        case "active_subscriptions": String(localized: "Active subscriptions")
        case "sales": String(localized: "Sales")
        default: metric
        }
    }

    static func systemImage(_ metric: String) -> String {
        switch metric {
        case "revenue": "dollarsign.circle"
        case "proceeds": "banknote"
        case "mrr": "arrow.triangle.2.circlepath"
        case "new_subscriptions": "person.badge.plus"
        case "trials_started": "hourglass"
        case "active_subscriptions": "person.2"
        case "sales": "cart"
        default: "target"
        }
    }
}

enum GoalPeriod {
    static let all = ["week", "month", "quarter", "year", "custom"]

    static func title(_ period: String) -> String {
        switch period {
        case "week": String(localized: "Week")
        case "month": String(localized: "Month")
        case "quarter": String(localized: "Quarter")
        case "year": String(localized: "Year")
        default: String(localized: "Custom")
        }
    }

    static func cadence(_ period: String) -> String {
        switch period {
        case "week": String(localized: "Every week")
        case "month": String(localized: "Every month")
        case "quarter": String(localized: "Every quarter")
        case "year": String(localized: "Every year")
        default: String(localized: "Custom period")
        }
    }
}

enum GoalPace {
    static func title(_ pace: String) -> String {
        switch pace {
        case "upcoming": String(localized: "Upcoming")
        case "on_track": String(localized: "On track")
        case "behind": String(localized: "Behind")
        case "reached": String(localized: "Reached")
        case "missed": String(localized: "Missed")
        default: pace
        }
    }

    static func color(_ pace: String) -> Color {
        switch pace {
        case "on_track", "reached": .green
        case "behind": .orange
        case "missed": .red
        default: .secondary
        }
    }

    static func systemImage(_ pace: String) -> String {
        switch pace {
        case "on_track": "arrow.up.right"
        case "behind": "tortoise"
        case "reached": "checkmark"
        case "missed": "xmark"
        default: "clock"
        }
    }
}

/// Names of the workspace's apps (the app's list, cached for the widgets).
enum GoalAppNames {
    static func cached() -> (String) -> String? {
        let apps = ResponseCache.load(AppList.self, key: ResponseCache.key("apps"))?.items ?? []
        let names = Dictionary(apps.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
        return { names[$0] }
    }
}

extension GoalProgress {
    var isMoney: Bool { format == "money" }
    var isStock: Bool { kind == "stock" }

    /// The server's pace, else (older servers) one derived from progress and projection.
    var paceValue: String {
        if let pace { return pace }
        if progress >= 1 { return "reached" }
        return projected >= target ? "on_track" : "behind"
    }

    var isReached: Bool { paceValue == "reached" || progress >= 1 }

    /// "All apps", "Photo Lab", "3 apps", "All apps except Photo Lab", "All apps except 2", "No apps" (its apps were deleted).
    func scopeSummary(appName: (String) -> String?) -> String {
        switch scope {
        case "include" where appIds.isEmpty:
            return String(localized: "No apps")
        case "include" where appIds.count == 1:
            return appName(appIds[0]) ?? String(localized: "1 app")
        case "include" where !appIds.isEmpty:
            return String(localized: "\(appIds.count) apps")
        case "exclude" where appIds.count == 1:
            let name = appName(appIds[0]) ?? String(localized: "1 app")
            return String(localized: "All apps except \(name)")
        case "exclude" where !appIds.isEmpty:
            return String(localized: "All except \(appIds.count) apps")
        default:
            return String(localized: "All apps")
        }
    }

    /// Generated, localized label of an unnamed goal: "Revenue · 3 apps".
    func generatedLabel(appName: (String) -> String?) -> String {
        "\(GoalMetric.title(metric)) · \(scopeSummary(appName: appName))"
    }

    /// The name, else the generated label.
    func title(appName: (String) -> String?) -> String {
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
        return generatedLabel(appName: appName)
    }

    private static let utc = TimeZone(identifier: "UTC")!

    /// "This month", "Week of 26 Oct", "Q4 2026", "2026", "1 Oct – 31 Dec 2026".
    var periodTitle: String {
        let start = periodStart.flatMap(Fmt.day)
        let end = periodEnd.flatMap(Fmt.day)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = Self.utc
        switch period {
        case "week":
            guard let start else { return GoalPeriod.title(period) }
            let day = start.formatted(Date.FormatStyle(timeZone: Self.utc).day().month(.abbreviated))
            return String(localized: "Week of \(day)")
        case "month":
            if status == "active" { return String(localized: "This month") }
            guard let start else { return GoalPeriod.title(period) }
            return start.formatted(Date.FormatStyle(timeZone: Self.utc).month(.wide).year())
        case "quarter":
            guard let start else { return GoalPeriod.title(period) }
            let q = cal.component(.month, from: start) / 3 + 1
            let year = String(cal.component(.year, from: start))
            return String(localized: "Q\(q) \(year)")
        case "year":
            guard let start else { return GoalPeriod.title(period) }
            return String(cal.component(.year, from: start))
        default:
            guard let start, let end else { return GoalPeriod.title(period) }
            return Self.range(start, end)
        }
    }

    /// "26 Oct – 1 Nov 2026".
    var periodDates: String? {
        guard let start = periodStart.flatMap(Fmt.day), let end = periodEnd.flatMap(Fmt.day) else { return nil }
        return Self.range(start, end)
    }

    static func range(_ start: Date, _ end: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = utc
        let sameYear = cal.component(.year, from: start) == cal.component(.year, from: end)
        let first = start.formatted(sameYear ? Date.FormatStyle(timeZone: utc).day().month(.abbreviated) : Date.FormatStyle(timeZone: utc).day().month(.abbreviated).year())
        let last = end.formatted(Date.FormatStyle(timeZone: utc).day().month(.abbreviated).year())
        return "\(first) – \(last)"
    }

    /// "12 days left", "Last day", "Ended", "Starts 1 Nov".
    var timeLeft: String {
        switch status {
        case "ended": return String(localized: "Ended")
        case "upcoming":
            guard let start = periodStart.flatMap(Fmt.day) else { return String(localized: "Upcoming") }
            let day = start.formatted(Date.FormatStyle(timeZone: Self.utc).day().month(.abbreviated))
            return String(localized: "Starts \(day)")
        default:
            return daysLeft == 0 ? String(localized: "Last day") : String(localized: "\(daysLeft) days left")
        }
    }

    /// A value of this goal's metric: money in the workspace currency, counts as numbers.
    func formatted(_ value: Double, currency: String, compact: Bool = false, hide: Bool = false) -> String {
        isMoney ? Fmt.money(value, currency, compact: compact, hide: hide) : Fmt.count(value.rounded(), compact: compact)
    }
}

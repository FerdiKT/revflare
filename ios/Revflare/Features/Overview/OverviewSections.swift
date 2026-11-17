import SwiftUI

// MARK: - Today by app

/// Today's apps inside the Today card: the top five by today's amount (gross or net), the rest behind "See all".
struct TodayAppsList: View {
    var apps: [TodayApp]
    var net: Bool
    var currency: String
    @State private var expanded = false

    private static let shown = 5

    private var sorted: [TodayApp] {
        apps
            .filter { $0.revenue != 0 || $0.proceeds != 0 || $0.sales > 0 || $0.trialsStarted > 0 || $0.refunds > 0 }
            .sorted { amount($0) != amount($1) ? amount($0) > amount($1) : ($0.sales + $0.trialsStarted) > ($1.sales + $1.trialsStarted) }
    }

    private func amount(_ a: TodayApp) -> Double { net ? a.proceeds : a.revenue }

    var body: some View {
        let list = sorted
        if list.count > 1 {
            VStack(spacing: 0) {
                ForEach(Array((expanded ? list : Array(list.prefix(Self.shown))).enumerated()), id: \.element.id) { i, app in
                    if i > 0 { Divider().padding(.leading, 40) }
                    NavigationLink(value: Route.app(id: app.appId, name: app.name)) {
                        TodayAppRow(app: app, net: net, currency: currency)
                            .padding(.vertical, 7)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                if list.count > Self.shown {
                    Button {
                        withAnimation(.snappy) { expanded.toggle() }
                    } label: {
                        HStack(spacing: 4) {
                            Text(expanded ? "Show less" : "See all (\(list.count))")
                            Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2.weight(.bold))
                        }
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Color.brand)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct TodayAppRow: View {
    var app: TodayApp
    var net: Bool
    var currency: String

    /// Against yesterday at the same time when the server sends it, else the whole of yesterday.
    private var change: Double? {
        let now = net ? app.proceeds : app.revenue
        let before = (net ? app.yesterdaySameTimeProceeds : app.yesterdaySameTimeRevenue) ?? (net ? app.yesterdayProceeds : app.yesterdayRevenue)
        guard before > 0 else { return nil }
        return (now - before) / before
    }

    private var caption: String {
        var parts: [String] = []
        if app.sales > 0 { parts.append(String(localized: "\(app.sales) sales")) }
        if app.trialsStarted > 0 { parts.append(String(localized: "\(app.trialsStarted) trials")) }
        if app.refunds > 0 { parts.append(String(localized: "\(app.refunds) refunds")) }
        return parts.isEmpty ? String(localized: "No sales yet") : parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: 10) {
            AppIconView(url: app.iconUrl, name: app.name, size: 30)
            VStack(alignment: .leading, spacing: 1) {
                Text(app.name).font(.subheadline.weight(.medium)).lineLimit(1)
                Text(caption).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            .layoutPriority(1)
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 1) {
                MoneyText(value: net ? app.proceeds : app.revenue, currency: currency)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                if let change {
                    HStack(spacing: 1) {
                        Image(systemName: change >= 0 ? "arrow.up" : "arrow.down").font(.system(size: 8, weight: .heavy))
                        Text(InsightText.percent(abs(change)))
                            .font(.caption2.weight(.semibold))
                            .monospacedDigit()
                    }
                    .foregroundStyle(changeColor(change, lowerIsBetter: false))
                    .accessibilityLabel(Text("Change \(Fmt.change(change))"))
                } else {
                    Text(" ").font(.caption2)
                }
            }
            Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(.tertiary)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Compact goals

/// Overview goals, one line each (name · bar with the pace tick · percent · pace mark); the shared period and time left
/// go in the header. Details stay on the goals screen.
struct GoalsStrip: View {
    @Environment(AppModel.self) private var model
    var goals: [GoalProgress]
    var currency: String
    @State private var adding = false

    private static let shown = 3

    private var shownGoals: [GoalProgress] { Array(goals.prefix(Self.shown)) }

    /// The period most shown goals share ("This month · 13 days left"), in the header; goals of another period show
    /// their own time left. None when no two goals share one (a single goal: its own).
    private var commonPeriod: (title: String, left: String)? {
        let keys = shownGoals.map { "\($0.periodTitle)|\($0.timeLeft)" }
        let counts = Dictionary(keys.map { ($0, 1) }, uniquingKeysWith: +)
        guard let best = counts.max(by: { $0.value < $1.value || ($0.value == $1.value && keys.firstIndex(of: $0.key)! > keys.firstIndex(of: $1.key)!) }),
              best.value >= 2 || shownGoals.count == 1
        else { return nil }
        let parts = best.key.split(separator: "|", maxSplits: 1).map(String.init)
        return (parts[0], parts.count > 1 ? parts[1] : "")
    }

    private func inCommonPeriod(_ g: GoalProgress) -> Bool {
        guard let c = commonPeriod else { return false }
        return g.periodTitle == c.title && g.timeLeft == c.left
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "target").foregroundStyle(.secondary)
                Text("Goals").foregroundStyle(.secondary)
                if let commonPeriod {
                    Text("· \(commonPeriod.title) · \(commonPeriod.left)")
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                }
                Spacer(minLength: 4)
                NavigationLink(value: Route.goals) {
                    Text(goals.count > Self.shown ? "See all (\(goals.count))" : "See all").font(.subheadline)
                }
                .fixedSize()
            }
            .font(.subheadline.weight(.semibold))
            .accessibilityAddTraits(.isHeader)

            if goals.isEmpty {
                Button {
                    adding = true
                } label: {
                    HStack(spacing: 12) {
                        ProgressRing(progress: 0.66, lineWidth: 5, color: .brand.opacity(0.5))
                            .frame(width: 38, height: 38)
                            .overlay { Image(systemName: "plus").font(.system(size: 14, weight: .bold)).foregroundStyle(Color.brand) }
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Add a goal").font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                            Text("Revenue, MRR, subscriptions or trials, for any period.").font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                VStack(spacing: 0) {
                    ForEach(shownGoals) { g in
                        NavigationLink(value: Route.goal(id: g.id)) {
                            CompactGoalRow(goal: g, showPeriod: !inCommonPeriod(g))
                                .padding(.vertical, 6)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .card()
        .onAppear { GoalStore.remember(goals, currency: currency) }
        .sheet(isPresented: $adding) {
            GoalEditorSheet(goal: nil, currency: currency) { _ in model.dataChanged() }
        }
    }
}

private struct CompactGoalRow: View {
    @Environment(AppModel.self) private var model
    var goal: GoalProgress
    var showPeriod: Bool

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 4) {
                Text(goal.title(appName: model.appName)).font(.subheadline.weight(.medium))
                if showPeriod {
                    Text(goal.timeLeft).font(.caption).foregroundStyle(.secondary)
                }
            }
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            GoalProgressBar(progress: goal.progress, expected: goal.expectedFraction, color: goal.tint, height: 5)
                .frame(width: 64)
            Text(InsightText.percent(min(goal.progress, 9.99)))
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(goal.isReached ? Color.green : Color.primary)
                .lineLimit(1)
                .frame(minWidth: 40, alignment: .trailing)
            PaceMark(pace: goal.paceValue)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(Text(GoalPace.title(goal.paceValue)))
    }
}

/// The pace as a small tinted glyph (tortoise = behind, arrow = on track, check = reached).
private struct PaceMark: View {
    var pace: String

    var body: some View {
        Image(systemName: GoalPace.systemImage(pace))
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(GoalPace.color(pace))
            .frame(width: 20, height: 20)
            .background(GoalPace.color(pace).opacity(0.14), in: Circle())
            .accessibilityLabel(Text(GoalPace.title(pace)))
    }
}

// MARK: - Insights

/// Rule-based insights from the server (`Overview.insights`): one sentence each, a tap opens the related screen.
struct InsightsCard: View {
    @Environment(AppModel.self) private var model
    var insights: [Insight]
    var currency: String

    var body: some View {
        if !insights.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                SectionHeader(title: "Insights", systemImage: "sparkles")
                    .padding(.bottom, 6)
                ForEach(Array(insights.enumerated()), id: \.element.id) { i, insight in
                    if i > 0 { Divider().padding(.leading, 38) }
                    row(insight)
                }
            }
            .card()
        }
    }

    @ViewBuilder
    private func row(_ insight: Insight) -> some View {
        let content = HStack(alignment: .center, spacing: 10) {
            Image(systemName: InsightText.icon(insight))
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(InsightText.tint(insight))
                .frame(width: 28, height: 28)
                .background(InsightText.tint(insight).opacity(0.13), in: Circle())
            InsightText.view(insight, currency: currency)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())

        switch insight.link.type {
        case "app":
            if let appId = insight.link.appId {
                NavigationLink(value: Route.app(id: appId, name: insight.appName ?? model.appName(appId) ?? "")) { content }.buttonStyle(.plain)
            } else { content }
        case "goal":
            if let goalId = insight.link.goalId {
                NavigationLink(value: Route.goal(id: goalId)) { content }.buttonStyle(.plain)
            } else { content }
        case "goals":
            NavigationLink(value: Route.goals) { content }.buttonStyle(.plain)
        case "chart":
            Button {
                model.chartRequest = insight.link.metric
                model.tab = .charts
            } label: { content }
            .buttonStyle(.plain)
        default:
            content
        }
    }
}

/// Localized insight sentences from `kind` + `values` (the server's English `text` for unknown kinds).
enum InsightText {
    static func icon(_ i: Insight) -> String {
        switch i.kind {
        case "today_top_app": "crown"
        case "month_pace": "flag.checkered"
        case "refund_spike": "arrow.uturn.backward"
        case "trial_conversion_week": "hourglass"
        case "new_customers_week": "person.badge.plus"
        default: i.tone == "negative" ? "arrow.down.right" : i.tone == "positive" ? "arrow.up.right" : "sparkles"
        }
    }

    static func tint(_ i: Insight) -> Color {
        switch i.tone {
        case "positive": .green
        case "negative": i.kind == "refund_spike" ? .red : .orange
        default: .brand
        }
    }

    /// Kinds whose sentence carries an amount (hidden in privacy mode).
    private static let moneyKinds: Set<String> = ["month_pace", "revenue_week", "app_mrr_change"]

    static func view(_ i: Insight, currency: String) -> some View {
        Text(string(i, currency: currency)).privacySensitive(moneyKinds.contains(i.kind))
    }

    /// Whole percent, localized ("31%", "%31").
    static func percent(_ fraction: Double) -> String {
        fraction.formatted(.percent.precision(.fractionLength(0)))
    }

    /// "+12%" / "−8%" ("+%12" in Turkish).
    static func signed(_ fraction: Double) -> String {
        (fraction >= 0 ? "+" : "−") + percent(abs(fraction))
    }

    static func string(_ i: Insight, currency: String) -> String {
        let money = { (k: String) in Fmt.money(i.number(k) ?? 0, currency, compact: true) }
        let pct = { (k: String) in percent(i.number(k) ?? 0) }
        let change = { (k: String) in signed(i.number(k) ?? 0) }
        let name = i.appName ?? ""
        switch i.kind {
        case "today_top_app":
            return String(localized: "\(pct("share")) of today's revenue came from \(name)")
        case "month_pace":
            if i.link.type == "goal" {
                return String(localized: "At this pace the month ends at ≈ \(money("projected")), \(pct("ratio")) of the goal")
            }
            return String(localized: "At this pace the month ends at ≈ \(money("projected")), \(change("change")) vs last month")
        case "revenue_week":
            return String(localized: "Revenue over the last 7 days: \(money("current")), \(change("change")) vs the week before")
        case "trial_conversion_week":
            return String(localized: "Trial → paid conversion this week: \(pct("current")), last week \(pct("previous"))")
        case "refund_spike":
            let n = Int(i.number("refunds") ?? 0)
            if let ratio = i.number("ratio") {
                let r = ratio.formatted(.number.precision(.fractionLength(1)))
                return String(localized: "\(name): \(n) refunds in 3 days, \(r)× the usual rate")
            }
            return String(localized: "\(name): \(n) refunds in 3 days, none in the 4 weeks before")
        case "app_mrr_change":
            return String(localized: "\(name) MRR \(change("change")) in 7 days (now \(money("mrr")))")
        case "churn_change":
            let up = (i.number("current") ?? 0) > (i.number("previous") ?? 0)
            return up
                ? String(localized: "28-day churn rose to \(pct("current")) from \(pct("previous"))")
                : String(localized: "28-day churn fell to \(pct("current")) from \(pct("previous"))")
        case "new_customers_week":
            let n = Int(i.number("current") ?? 0)
            return String(localized: "\(n) new customers in the last 7 days, \(change("change")) vs the week before")
        default:
            return i.text
        }
    }
}

import Charts
import SwiftUI
import WidgetKit

struct OverviewView: View {
    @Environment(AppModel.self) private var model
    @State private var loader = Loader<Overview>()
    @State private var showFilter = false
    @State private var celebrate = false

    var body: some View {
        @Bindable var model = model
        ScrollView {
            VStack(spacing: 16) {
                if let error = loader.error, loader.value == nil {
                    ErrorBanner(message: error) { Task { await load() } }
                }
                if let o = loader.value {
                    OverviewContent(overview: o, scopedToApp: nil, updatedAt: loader.updatedAt, offline: loader.offline)
                } else if loader.error == nil {
                    OverviewSkeleton()
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 24)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(title)
        .toolbarTitleDisplayMode(.inlineLarge)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    showFilter = true
                } label: {
                    Image(systemName: model.overviewApps.isEmpty ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
                }
                .accessibilityLabel(Text("Filter apps"))
                GrossNetToggle()
            }
        }
        .sheet(isPresented: $showFilter) {
            AppPickerSheet(title: "Filter apps", selection: $model.overviewApps)
        }
        .refreshable { await load() }
        .task(id: TaskKey(version: model.dataVersion, apps: model.overviewApps, ws: model.workspace?.id)) {
            await load()
            // Today's revenue stays live while the screen is visible.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                if Task.isCancelled { break }
                await load()
            }
        }
        .overlay {
            if celebrate {
                ConfettiView().ignoresSafeArea().transition(.opacity)
            }
        }
        .sensoryFeedback(.success, trigger: celebrate) { _, new in new }
    }

    private struct TaskKey: Equatable {
        var version: Int
        var apps: Set<String>
        var ws: String?
    }

    private var title: String {
        if model.overviewApps.count == 1, let id = model.overviewApps.first, let name = model.appName(id) { return name }
        if model.overviewApps.count > 1 { return String(localized: "\(model.overviewApps.count) apps") }
        return String(localized: "Overview")
    }

    private func load() async {
        guard let client = model.client else { return }
        let apps = model.overviewApps
        loader.use(cacheKey: ResponseCache.key("overview", appsParam(apps) ?? "all"))
        let previousSales = loader.value?.today.sales
        let previousDate = loader.value?.today.date
        await loader.load { try await client.overview(apps: apps) }
        guard let o = loader.value else { return }
        if apps.isEmpty {
            WidgetData.store(o, appId: nil, appName: nil)
            WidgetCenter.shared.reloadAllTimelines()
            await LiveActivityManager.shared.update(with: o)
        }
        if let previousSales, previousDate == o.today.date, o.today.sales > previousSales { model.newSale() }
        celebrateIfRecord(o)
    }

    private func celebrateIfRecord(_ o: Overview) {
        guard o.records.todayIsRecord, o.today.revenue > 0, model.overviewApps.isEmpty else { return }
        let key = "celebrated-\(SharedSettings.workspaceId ?? "")-\(o.today.date)"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        withAnimation { celebrate = true }
        Task {
            try? await Task.sleep(for: .seconds(4.5))
            withAnimation { celebrate = false }
        }
    }
}

/// Gross (revenue) / net (proceeds) switch in the toolbar.
struct GrossNetToggle: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Menu {
            Picker("Amounts", selection: $model.showProceeds) {
                Label("Gross revenue", systemImage: "dollarsign.circle").tag(false)
                Label("Net proceeds", systemImage: "banknote").tag(true)
            }
            Divider()
            Toggle(isOn: $model.privacyMode) {
                Label("Privacy mode", systemImage: "eye.slash")
            }
        } label: {
            Image(systemName: model.privacyMode ? "eye.slash" : (model.showProceeds ? "banknote" : "dollarsign.circle"))
        }
        .accessibilityLabel(Text("Display options"))
    }
}

/// The dashboard body, shared by the Overview tab and the per-app detail (`scopedToApp`).
struct OverviewContent: View {
    @Environment(AppModel.self) private var model
    var overview: Overview
    var scopedToApp: String?
    var updatedAt: Date?
    var offline: Bool

    private var net: Bool { model.showProceeds }

    var body: some View {
        let o = overview
        VStack(spacing: 16) {
            TodayCard(overview: o, net: net, updatedAt: updatedAt, offline: offline)

            if !o.goals.filter(goalMatches).isEmpty || (scopedToApp == nil && model.overviewApps.isEmpty && model.canManage) {
                GoalsStrip(goals: o.goals.filter(goalMatches), currency: o.currency)
            }

            KpiGrid(overview: o, net: net)

            MovementCard(movement: o.mrrMovement, currency: o.currency)

            HStack(spacing: 12) {
                NavigationLink(value: Route.atRisk) {
                    MiniStatCard(title: "Revenue at risk", systemImage: "exclamationmark.shield", tint: .orange) {
                        MoneyText(value: o.atRisk.mrr, currency: o.currency, compact: true)
                    } caption: {
                        Text("\(o.atRisk.subscriptions) subscriptions")
                    }
                }
                .disabled(scopedToApp != nil)
                NavigationLink(value: Route.forecast) {
                    MiniStatCard(title: "Next 30 days", systemImage: "calendar.badge.clock", tint: .blue) {
                        MoneyText(value: o.forecast30, currency: o.currency, compact: true)
                    } caption: {
                        Text("Expected renewals")
                    }
                }
                .disabled(scopedToApp != nil)
            }
            .buttonStyle(.plain)

            RecordsCard(records: o.records, currency: o.currency)

            if scopedToApp == nil, !o.topApps.isEmpty {
                TopAppsCard(apps: o.topApps, currency: o.currency)
            }

            if !o.alerts.filter({ $0.resolvedAt == nil }).isEmpty {
                AlertsCard(alerts: o.alerts.filter { $0.resolvedAt == nil })
            }
        }
    }

    /// Goals shown on this overview. Goals are computed for their own apps whatever the filter: the unfiltered
    /// overview shows every goal; an app filter (or an app's page) keeps the goals on selected apps only.
    private func goalMatches(_ g: GoalProgress) -> Bool {
        if g.archived { return false }
        let filter: Set<String> = scopedToApp.map { [$0] } ?? model.overviewApps
        if filter.isEmpty { return true }
        guard g.scope == "include", !g.appIds.isEmpty else { return false }
        return Set(g.appIds).isSubset(of: filter)
    }
}

struct TodayCard: View {
    var overview: Overview
    var net: Bool
    var updatedAt: Date?
    var offline: Bool

    var body: some View {
        let t = overview.today
        let y = overview.yesterday
        let amount = net ? t.proceeds : t.revenue
        let yAmount = net ? y.proceeds : y.revenue
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                HStack(spacing: 6) {
                    LiveDot()
                    Text(net ? "Today · net" : "Today")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if overview.records.todayIsRecord && t.revenue > 0 {
                    Label("Record day", systemImage: "trophy.fill")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.yellow)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .glassEffect(.regular.tint(.yellow.opacity(0.25)), in: Capsule())
                }
            }
            Text(Fmt.money(amount, overview.currency))
                .font(.system(size: 46, weight: .bold, design: .rounded))
                .monospacedDigit()
                .contentTransition(.numericText(value: amount))
                .animation(.snappy, value: amount)
                .minimumScaleFactor(0.5)
                .lineLimit(1)
                .privacySensitive()
            HStack(spacing: 14) {
                StatChip(value: t.sales, title: "sales", systemImage: "cart")
                StatChip(value: t.newSubscriptions, title: "new subs", systemImage: "person.badge.plus")
                StatChip(value: t.trialsStarted, title: "trials", systemImage: "hourglass")
                if t.refunds > 0 { StatChip(value: t.refunds, title: "refunds", systemImage: "arrow.uturn.backward", tint: .red) }
            }
            Divider()
            HStack {
                Text("Yesterday").foregroundStyle(.secondary)
                MoneyText(value: yAmount, currency: overview.currency).fontWeight(.medium)
                Spacer()
                UpdatedLabel(date: updatedAt, offline: offline)
            }
            .font(.footnote)
        }
        .card(padding: 18)
    }
}

private struct LiveDot: View {
    @State private var pulse = false
    var body: some View {
        Circle()
            .fill(Color.green)
            .frame(width: 8, height: 8)
            .overlay(Circle().stroke(Color.green.opacity(0.5), lineWidth: 2).scaleEffect(pulse ? 2.2 : 1).opacity(pulse ? 0 : 1))
            .onAppear { withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { pulse = true } }
            .accessibilityHidden(true)
    }
}

private struct StatChip: View {
    var value: Int
    var title: LocalizedStringKey
    var systemImage: String
    var tint: Color = .secondary

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(Fmt.count(value)).font(.headline).monospacedDigit().contentTransition(.numericText(value: Double(value)))
            Label(title, systemImage: systemImage).font(.caption2).foregroundStyle(tint).labelStyle(.titleOnly)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Overview goals: the first three with bars, a link to all of them; an invitation to add one when there are none.
struct GoalsStrip: View {
    @Environment(AppModel.self) private var model
    var goals: [GoalProgress]
    var currency: String
    @State private var adding = false

    private static let shown = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                SectionHeader(title: "Goals", systemImage: "target")
                NavigationLink(value: Route.goals) {
                    Text(goals.count > Self.shown ? "See all (\(goals.count))" : "See all").font(.subheadline)
                }
            }
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
                    ForEach(Array(goals.prefix(Self.shown).enumerated()), id: \.element.id) { i, g in
                        if i > 0 { Divider() }
                        NavigationLink(value: Route.goal(id: g.id)) {
                            GoalSummaryRow(goal: g, currency: currency)
                                .padding(.vertical, 10)
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

struct KpiGrid: View {
    @Environment(AppModel.self) private var model
    var overview: Overview
    var net: Bool

    private var ids: [String] {
        ["mrr", net ? "proceeds_28d" : "revenue_28d", "active_subscriptions", "active_trials", "new_customers_28d", "trial_conversion_28d", "churn_rate_28d"]
    }

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
            ForEach(ids.compactMap { overview.kpi($0) }) { kpi in
                Button {
                    model.chartRequest = kpi.metric
                    model.tab = .charts
                } label: {
                    KpiCard(kpi: kpi, currency: overview.currency)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

struct KpiCard: View {
    var kpi: Kpi
    var currency: String

    var body: some View {
        let info = MetricInfo.info(kpi.metric)
        VStack(alignment: .leading, spacing: 6) {
            Text(KpiCard.title(kpi))
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            MetricValueText(value: kpi.value, format: kpi.format, currency: currency, compact: true)
                .font(.title3.weight(.bold))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            ChangePill(change: kpi.change, lowerIsBetter: info.lowerIsBetter)
            Sparkline(values: kpi.spark, color: changeColor(kpi.change, lowerIsBetter: info.lowerIsBetter) == .secondary ? .brand : .brand)
                .frame(height: 30)
                .opacity(kpi.spark.count > 1 ? 1 : 0)
        }
        .card(padding: 14)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    static func title(_ kpi: Kpi) -> String {
        switch kpi.id {
        case "mrr": String(localized: "MRR")
        case "revenue_28d": String(localized: "Revenue (28 days)")
        case "proceeds_28d": String(localized: "Proceeds (28 days)")
        case "active_subscriptions": String(localized: "Active subscriptions")
        case "active_trials": String(localized: "Active trials")
        case "new_customers_28d": String(localized: "New customers (28 days)")
        case "trial_conversion_28d": String(localized: "Trial conversion (28 days)")
        case "churn_rate_28d": String(localized: "Churn (28 days)")
        default: kpi.label
        }
    }
}

struct MovementCard: View {
    var movement: Overview.Movement
    var currency: String

    private struct Bar: Identifiable {
        var id: String
        var title: String
        var value: Double
        var color: Color
    }

    private var bars: [Bar] {
        [
            Bar(id: "new", title: String(localized: "New"), value: movement.new, color: .green),
            Bar(id: "expansion", title: String(localized: "Expansion"), value: movement.expansion, color: .teal),
            Bar(id: "reactivation", title: String(localized: "Reactivation"), value: movement.reactivation, color: .blue),
            Bar(id: "contraction", title: String(localized: "Contraction"), value: -abs(movement.contraction), color: .orange),
            Bar(id: "churn", title: String(localized: "Churn"), value: -abs(movement.churn), color: .red),
        ]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                SectionHeader(title: "MRR movement · 28 days", systemImage: "arrow.left.arrow.right")
                Spacer()
                HStack(spacing: 2) {
                    Text(movement.net >= 0 ? "+" : "−")
                    MoneyText(value: abs(movement.net), currency: currency, compact: true)
                }
                .font(.subheadline.weight(.bold))
                .foregroundStyle(movement.net >= 0 ? Color.green : Color.red)
            }
            ForEach(bars) { bar in
                HStack(spacing: 10) {
                    Text(bar.title).font(.caption).frame(width: 92, alignment: .leading)
                    GeometryReader { geo in
                        let maxValue = max(bars.map { abs($0.value) }.max() ?? 1, 1)
                        Capsule()
                            .fill(bar.color.gradient)
                            .frame(width: max(4, geo.size.width * abs(bar.value) / maxValue))
                    }
                    .frame(height: 10)
                    MoneyText(value: bar.value, currency: currency, compact: true)
                        .font(.caption.weight(.medium))
                        .frame(width: 76, alignment: .trailing)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .card()
    }
}

struct MiniStatCard<Value: View, Caption: View>: View {
    var title: LocalizedStringKey
    var systemImage: String
    var tint: Color
    @ViewBuilder var value: Value
    @ViewBuilder var caption: Caption

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: systemImage).foregroundStyle(tint)
                Spacer()
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
            }
            Text(title).font(.caption.weight(.medium)).foregroundStyle(.secondary).lineLimit(1)
            value.font(.title3.weight(.bold)).lineLimit(1).minimumScaleFactor(0.6)
            caption.font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
        .card(padding: 14)
        .contentShape(Rectangle())
    }
}

struct RecordsCard: View {
    var records: Overview.Records
    var currency: String

    var body: some View {
        if records.bestDay != nil || records.bestMonth != nil {
            HStack(spacing: 12) {
                if let d = records.bestDay {
                    record(title: "Best day", date: Fmt.dayLabel(d.date), value: d.revenue)
                }
                if let m = records.bestMonth {
                    record(title: "Best month", date: Fmt.dayLabel(m.date, interval: "month"), value: m.revenue)
                }
            }
        }
    }

    private func record(title: LocalizedStringKey, date: String, value: Double) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(title, systemImage: "trophy").font(.caption.weight(.medium)).foregroundStyle(.secondary)
            MoneyText(value: value, currency: currency, compact: true).font(.headline)
            Text(date).font(.caption2).foregroundStyle(.secondary)
        }
        .card(padding: 14)
    }
}

struct TopAppsCard: View {
    var apps: [Overview.TopApp]
    var currency: String
    /// App Store / Google Play capsules only when Android apps are in the list.
    private var showStore: Bool { apps.contains { $0.isAndroid } }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Top apps · 28 days", systemImage: "crown")
            ForEach(apps.prefix(6)) { app in
                NavigationLink(value: Route.app(id: app.appId, name: app.name)) {
                    HStack(spacing: 12) {
                        AppIconView(url: app.iconUrl, name: app.name, size: 36)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(app.name).font(.subheadline.weight(.medium)).lineLimit(1)
                                if showStore { StoreBadge(android: app.isAndroid) }
                            }
                            HStack(spacing: 3) {
                                Text("MRR")
                                MoneyText(value: app.mrr, currency: currency, compact: true)
                            }
                            .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            MoneyText(value: app.revenue28d, currency: currency, compact: true).font(.subheadline.weight(.semibold))
                            ChangePill(change: app.change)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if app.id != apps.prefix(6).last?.id { Divider().padding(.leading, 48) }
            }
        }
        .card()
    }
}

struct AlertsCard: View {
    @Environment(AppModel.self) private var model
    var alerts: [RFAlert]
    @State private var resolved = Set<String>()

    var body: some View {
        let open = alerts.filter { !resolved.contains($0.id) }
        if !open.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "Alerts", systemImage: "bell.badge")
                ForEach(open) { alert in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: Self.icon(alert))
                            .foregroundStyle(alert.severity == "critical" ? .red : alert.severity == "warning" ? .orange : .blue)
                        if let route = Self.route(alert) {
                            NavigationLink(value: route) {
                                HStack(alignment: .top) {
                                    text(alert)
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        } else {
                            text(alert)
                            Spacer()
                        }
                        Button {
                            Task {
                                try? await model.client?.resolveAlert(alert.id)
                                withAnimation { _ = resolved.insert(alert.id) }
                            }
                        } label: {
                            Image(systemName: "checkmark.circle")
                        }
                        .accessibilityLabel(Text("Resolve"))
                    }
                }
            }
            .card()
        }
    }

    private func text(_ alert: RFAlert) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(alert.title).font(.subheadline.weight(.semibold))
            Text(alert.body).font(.caption).foregroundStyle(.secondary)
            Text(Fmt.relative(ms: alert.createdAt)).font(.caption2).foregroundStyle(.tertiary)
        }
        .multilineTextAlignment(.leading)
    }

    static func icon(_ alert: RFAlert) -> String {
        switch alert.kind {
        case "funnel_anomaly", "release_regression": "chart.line.downtrend.xyaxis"
        case "events_silent": "antenna.radiowaves.left.and.right.slash"
        case "google_play_test": "checkmark.seal.fill"
        default:
            alert.severity == "critical" ? "exclamationmark.octagon.fill" : alert.severity == "warning" ? "exclamationmark.triangle.fill" : "info.circle.fill"
        }
    }

    /// Funnel alerts open the funnel's report; events stopped opens the app's events.
    static func route(_ alert: RFAlert) -> Route? {
        guard let appId = alert.appId else { return nil }
        switch alert.kind {
        case "funnel_anomaly", "release_regression":
            return alert.funnelId.map { .funnelLookup(appId: appId, funnelId: $0) }
        case "events_silent":
            return .events(appId: appId)
        default:
            return nil
        }
    }
}

struct OverviewSkeleton: View {
    var body: some View {
        VStack(spacing: 16) {
            RoundedRectangle(cornerRadius: 22).fill(Color(.secondarySystemGroupedBackground)).frame(height: 190)
            LazyVGrid(columns: [GridItem(), GridItem()], spacing: 12) {
                ForEach(0..<4, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 22).fill(Color(.secondarySystemGroupedBackground)).frame(height: 130)
                }
            }
        }
        .redacted(reason: .placeholder)
        .overlay { ProgressView() }
    }
}

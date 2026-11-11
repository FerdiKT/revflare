import AppIntents
import Charts
import SwiftUI
import WidgetKit

// MARK: - Today

struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: WidgetKinds.today, intent: SelectAppIntent.self, provider: AppSnapshotProvider()) { entry in
            TodayWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(URL(string: entry.snapshot?.appId.map { "revflare://app/\($0)" } ?? "revflare://overview"))
        }
        .configurationDisplayName("Today")
        .description("Today's revenue, live.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
        .pushHandler(RevflareWidgetPushHandler.self)
    }
}

struct TodayWidgetView: View {
    @Environment(\.widgetFamily) private var family
    var entry: SnapshotEntry

    var body: some View {
        if let s = entry.snapshot {
            switch family {
            case .accessoryInline:
                Text("\(s.money(s.today, entry, compact: true)) today · \(s.sales) sales")
            case .accessoryCircular:
                VStack(spacing: 0) {
                    Image(systemName: "dollarsign").font(.caption2.weight(.bold))
                    Text(s.money(s.today, entry, compact: true))
                        .font(.system(.body, design: .rounded).weight(.bold))
                        .minimumScaleFactor(0.4)
                        .lineLimit(1)
                        .privacySensitive()
                    Text("today").font(.system(size: 9)).foregroundStyle(.secondary)
                }
                .padding(2)
                .widgetAccentable()
                .containerBackground(for: .widget) { AccessoryWidgetBackground() }
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 1) {
                    Label(s.appName ?? String(localized: "Today"), systemImage: "chart.line.uptrend.xyaxis")
                        .font(.caption2.weight(.semibold))
                        .widgetAccentable()
                    Text(s.money(s.today, entry))
                        .font(.system(.title3, design: .rounded).weight(.bold))
                        .minimumScaleFactor(0.5)
                        .privacySensitive()
                    Text("\(s.sales) sales · MRR \(s.money(s.mrr, entry, compact: true))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .privacySensitive()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            case .systemMedium:
                HStack(spacing: 14) {
                    todayBlock(s)
                    Divider()
                    VStack(alignment: .leading, spacing: 4) {
                        Text("MRR").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text(s.money(s.mrr, entry, compact: true)).font(.system(.title3, design: .rounded).weight(.bold)).privacySensitive()
                            if let c = s.mrrChange { Text(Fmt.change(c)).font(.caption2.weight(.semibold)).foregroundStyle(changeColor(c)) }
                        }
                        Text("Last 28 days").font(.caption2).foregroundStyle(.secondary)
                        SparkChart(values: s.spark).frame(maxHeight: .infinity)
                        Text(s.money(s.last28, entry, compact: true)).font(.caption.weight(.semibold)).privacySensitive()
                    }
                }
            default:
                todayBlock(s)
            }
        } else {
            SignedOutView(signedIn: entry.signedIn)
        }
    }

    private func todayBlock(_ s: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            WidgetTitle(title: entry.net ? "Today · net" : "Today", subtitle: s.appName)
            Spacer(minLength: 0)
            if s.todayIsRecord && s.todayRevenue > 0 {
                Label("Record", systemImage: "trophy.fill").font(.caption2.weight(.bold)).foregroundStyle(.yellow)
            }
            Text(s.money(s.today, entry))
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .minimumScaleFactor(0.45)
                .lineLimit(1)
                .contentTransition(.numericText(value: s.today))
                .privacySensitive()
            Text("\(s.sales) sales").font(.caption.weight(.medium))
            HStack(spacing: 3) {
                Text("Yesterday")
                Text(s.money(s.yesterday, entry, compact: true)).privacySensitive()
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            Text(s.asOf, style: .time).font(.system(size: 9)).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - MRR

struct MRRWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: WidgetKinds.mrr, intent: SelectAppIntent.self, provider: AppSnapshotProvider()) { entry in
            MRRWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(URL(string: entry.snapshot?.appId.map { "revflare://app/\($0)" } ?? "revflare://overview"))
        }
        .configurationDisplayName("MRR")
        .description("Monthly recurring revenue and its trend.")
        .supportedFamilies([.systemSmall, .accessoryRectangular, .accessoryCircular])
        .pushHandler(RevflareWidgetPushHandler.self)
    }
}

struct MRRWidgetView: View {
    @Environment(\.widgetFamily) private var family
    var entry: SnapshotEntry

    var body: some View {
        if let s = entry.snapshot {
            switch family {
            case .accessoryCircular:
                VStack(spacing: 0) {
                    Text("MRR").font(.system(size: 10, weight: .semibold))
                    Text(s.money(s.mrr, entry, compact: true)).font(.system(.body, design: .rounded).weight(.bold)).minimumScaleFactor(0.4).lineLimit(1).privacySensitive()
                }
                .widgetAccentable()
                .containerBackground(for: .widget) { AccessoryWidgetBackground() }
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 1) {
                    Text("MRR").font(.caption2.weight(.semibold)).widgetAccentable()
                    HStack(alignment: .firstTextBaseline) {
                        Text(s.money(s.mrr, entry, compact: true)).font(.system(.title3, design: .rounded).weight(.bold)).privacySensitive()
                        if let c = s.mrrChange { Text(Fmt.change(c)).font(.caption2) }
                    }
                    Text("\(Int(s.activeSubscriptions)) subscriptions").font(.caption2).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            default:
                VStack(alignment: .leading, spacing: 4) {
                    WidgetTitle(title: "MRR", subtitle: s.appName)
                    Text(s.money(s.mrr, entry, compact: true))
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                        .minimumScaleFactor(0.5)
                        .lineLimit(1)
                        .privacySensitive()
                    if let c = s.mrrChange {
                        Text(Fmt.change(c)).font(.caption.weight(.semibold)).foregroundStyle(changeColor(c))
                    }
                    SparkChart(values: s.mrrSpark).frame(maxHeight: .infinity)
                    Text("\(Int(s.activeSubscriptions)) subscriptions").font(.caption2).foregroundStyle(.secondary)
                }
            }
        } else {
            SignedOutView(signedIn: entry.signedIn)
        }
    }
}

// MARK: - 28-day chart + top apps

struct RevenueChartWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: WidgetKinds.chart, intent: SelectAppIntent.self, provider: AppSnapshotProvider()) { entry in
            RevenueChartWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(URL(string: "revflare://charts"))
        }
        .configurationDisplayName("Revenue · 28 days")
        .description("The last 28 days of revenue, and your top apps.")
        .supportedFamilies([.systemMedium, .systemLarge])
        .pushHandler(RevflareWidgetPushHandler.self)
    }
}

struct RevenueChartWidgetView: View {
    @Environment(\.widgetFamily) private var family
    var entry: SnapshotEntry

    var body: some View {
        if let s = entry.snapshot {
            VStack(alignment: .leading, spacing: 8) {
                WidgetTitle(title: entry.net ? "Proceeds · 28 days" : "Revenue · 28 days", subtitle: s.appName)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(s.money(s.last28, entry)).font(.system(.title2, design: .rounded).weight(.bold)).privacySensitive()
                    if let c = s.revenue28dChange {
                        Text(Fmt.change(c)).font(.caption.weight(.semibold)).foregroundStyle(changeColor(c))
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 0) {
                        Text("Today").font(.caption2).foregroundStyle(.secondary)
                        Text(s.money(s.today, entry, compact: true)).font(.caption.weight(.semibold)).privacySensitive()
                    }
                }
                BarsChart(values: s.spark)
                    .frame(maxHeight: family == .systemLarge ? 130 : .infinity)
                if family == .systemLarge {
                    Divider()
                    ForEach(s.topApps.prefix(4)) { app in
                        Link(destination: URL(string: "revflare://app/\(app.appId)")!) {
                            HStack(spacing: 8) {
                                WidgetAppIcon(url: app.iconUrl, name: app.name, size: 24)
                                Text(app.name).font(.caption.weight(.medium)).lineLimit(1)
                                Spacer()
                                if let c = app.change {
                                    Text(Fmt.change(c)).font(.caption2.weight(.semibold)).foregroundStyle(changeColor(c))
                                }
                                Text(s.money(app.revenue28d, entry, compact: true)).font(.caption.weight(.semibold)).privacySensitive()
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
        } else {
            SignedOutView(signedIn: entry.signedIn)
        }
    }
}

// MARK: - App spotlight (interactive)

struct SpotlightWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetKinds.spotlight, provider: WorkspaceProvider()) { entry in
            SpotlightWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("App spotlight")
        .description("Your top apps one by one. Tap the arrow to switch.")
        .supportedFamilies([.systemSmall, .systemMedium])
        .pushHandler(RevflareWidgetPushHandler.self)
    }
}

struct SpotlightWidgetView: View {
    @Environment(\.widgetFamily) private var family
    var entry: SnapshotEntry

    var body: some View {
        if let s = entry.snapshot, !s.topApps.isEmpty {
            let apps = Array(s.topApps.prefix(8))
            let index = ((SharedSettings.spotlightIndex % apps.count) + apps.count) % apps.count
            let app = apps[index]
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top) {
                    WidgetAppIcon(url: app.iconUrl, name: app.name, size: family == .systemSmall ? 34 : 40)
                    Spacer()
                    Button(intent: NextSpotlightAppIntent()) {
                        Image(systemName: "chevron.forward")
                            .font(.caption.weight(.bold))
                            .frame(width: 26, height: 26)
                    }
                    .buttonStyle(.plain)
                    .background(.fill.secondary, in: Circle())
                    .accessibilityLabel(Text("Next app"))
                }
                Text(app.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                    .invalidatableContent()
                if family == .systemMedium {
                    HStack(spacing: 18) {
                        metric("28 days", s.money(app.revenue28d, entry, compact: true), change: app.change)
                        metric("MRR", s.money(app.mrr, entry, compact: true), change: nil)
                        metric("Share", s.revenue28d > 0 ? Fmt.percent(app.revenue28d / s.revenue28d) : "—", change: nil)
                    }
                } else {
                    metric("28 days", s.money(app.revenue28d, entry, compact: true), change: app.change)
                }
                Spacer(minLength: 0)
                Text("\(index + 1) of \(apps.count)").font(.system(size: 9)).foregroundStyle(.tertiary)
            }
            .widgetURL(URL(string: "revflare://app/\(app.appId)"))
        } else if entry.snapshot == nil {
            SignedOutView(signedIn: entry.signedIn)
        } else {
            Text("No apps yet").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func metric(_ title: LocalizedStringKey, _ value: String, change: Double?) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(value).font(.system(.headline, design: .rounded)).privacySensitive().invalidatableContent()
                if let change { Text(Fmt.change(change)).font(.caption2.weight(.semibold)).foregroundStyle(changeColor(change)) }
            }
        }
    }
}

// MARK: - Charts

struct SparkChart: View {
    var values: [Double]

    var body: some View {
        if values.count > 1 {
            let lo = values.min() ?? 0, hi = values.max() ?? 1
            Chart {
                ForEach(Array(values.enumerated()), id: \.offset) { i, v in
                    AreaMark(x: .value("Day", i), yStart: .value("Base", lo), yEnd: .value("Value", v))
                        .foregroundStyle(LinearGradient(colors: [Color.accentColor.opacity(0.35), Color.accentColor.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                        .interpolationMethod(.monotone)
                    LineMark(x: .value("Day", i), y: .value("Value", v))
                        .foregroundStyle(Color.accentColor)
                        .interpolationMethod(.monotone)
                        .lineStyle(StrokeStyle(lineWidth: 1.6))
                }
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartYScale(domain: lo...(hi == lo ? lo + 1 : hi))
        } else {
            Color.clear
        }
    }
}

struct BarsChart: View {
    var values: [Double]

    var body: some View {
        Chart {
            ForEach(Array(values.enumerated()), id: \.offset) { i, v in
                BarMark(x: .value("Day", i), y: .value("Value", v), width: .ratio(0.7))
                    .foregroundStyle(i == values.count - 1 ? Color.accentColor : Color.accentColor.opacity(0.55))
                    .cornerRadius(2)
            }
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
    }
}

import Charts
import SwiftUI

// RevflareKit events and funnels for one app (read-only; funnels are created and edited in the web panel).
// Events live in Workers Analytics Engine on the server: counts can be sampled ("approximate").

enum AnalyticsRange {
    static let all: [(id: String, title: LocalizedStringKey)] = [("7d", "7 days"), ("28d", "28 days"), ("90d", "90 days")]
}

extension Fmt {
    /// "2 min", "1 hr, 5 min", "45 sec".
    static func duration(seconds: Double) -> String {
        let s = seconds >= 60 ? (seconds / 60).rounded() * 60 : seconds.rounded()
        return Duration.seconds(max(0, s)).formatted(.units(allowed: [.days, .hours, .minutes, .seconds], width: .abbreviated, maximumUnitCount: 2))
    }

    /// Conversion window: "7 days", "1 hour".
    static func window(seconds: Double) -> String {
        Duration.seconds(max(60, seconds)).formatted(.units(allowed: [.days, .hours, .minutes], width: .wide, maximumUnitCount: 2))
    }

    /// "(other)" / empty breakdown and event values.
    static func analyticsValue(_ value: String, breakdown: String? = nil) -> String {
        switch value {
        case "(other)": return String(localized: "Other")
        case "", "(none)", "(unknown)": return String(localized: "Unknown")
        default:
            if breakdown == "country", value.count == 2 { return "\(flag(value)) \(country(value))" }
            if breakdown == "locale" { return Locale.current.localizedString(forIdentifier: value) ?? value }
            return value
        }
    }
}

/// Capsule saying the numbers are estimated; tapping explains why.
struct ApproximateBadge: View {
    var explanation: LocalizedStringKey
    var notes: [String] = []
    @State private var showing = false

    var body: some View {
        Button {
            showing = true
        } label: {
            Label("Approximate", systemImage: "plusminus.circle")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .foregroundStyle(.orange)
                .background(Color.orange.opacity(0.13), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text("Shows why the numbers are estimated"))
        .popover(isPresented: $showing) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Approximate").font(.headline)
                Text(explanation).font(.footnote)
                ForEach(notes, id: \.self) { note in
                    Label(note, systemImage: "info.circle").font(.footnote).foregroundStyle(.secondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding()
            .frame(idealWidth: 320)
            .presentationCompactAdaptation(.popover)
        }
    }
}

/// The server cannot store or query events (no Analytics Engine binding / Cloudflare API token).
private struct AnalyticsSetupView: View {
    var status: AnalyticsStatus

    var body: some View {
        VStack(spacing: 14) {
            ContentUnavailableView {
                Label("Analytics is not set up", systemImage: "gearshape.2")
            } description: {
                Text("The Revflare server needs Workers Analytics Engine to store and query app events. Ask the server's admin to finish the setup (docs/api.md, Events and funnels).")
            }
            if !status.missing.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    SectionHeader(title: "Missing on the server", systemImage: "exclamationmark.triangle")
                    ForEach(status.missing, id: \.self) { item in
                        Label(item, systemImage: "minus.circle").font(.footnote)
                    }
                }
                .card()
            }
        }
    }
}

/// How to send events with RevflareKit 1.4.
private struct NoEventsView: View {
    var body: some View {
        VStack(spacing: 12) {
            ContentUnavailableView {
                Label("No events yet", systemImage: "waveform.path.ecg")
            } description: {
                Text("Add RevflareKit 1.4 or later to the app and record what users do. Events show up here a minute or two after they are sent.")
            }
            Text(verbatim: "Revflare.track(\"paywall_view\", properties: [\"placement\": \"onboarding\"])")
                .font(.caption.monospaced())
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .textSelection(.enabled)
        }
        .card()
    }
}

/// Analytics status shared by the screens (setup state), cached per app.
@MainActor
private func loadStatus(_ loader: Loader<AnalyticsStatus>, client: APIClient, appId: String) async {
    loader.use(cacheKey: ResponseCache.key("analytics-status", appId))
    await loader.load { try await client.analyticsStatus(app: appId) }
}

// MARK: - Events

struct EventsView: View {
    @Environment(AppModel.self) private var model
    var appId: String
    @AppStorage("events.range") private var range = "28d"
    @State private var status = Loader<AnalyticsStatus>()
    @State private var loader = Loader<EventSummary>()

    private var notConfigured: Bool { status.value.map { !$0.configured } ?? false }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let s = status.value, notConfigured {
                    AnalyticsSetupView(status: s)
                } else {
                    Picker("Range", selection: $range) {
                        ForEach(AnalyticsRange.all, id: \.id) { r in Text(r.title).tag(r.id) }
                    }
                    .pickerStyle(.segmented)
                    if let error = loader.error {
                        ErrorBanner(message: error) { Task { await load() } }
                    }
                    if let summary = loader.value {
                        if summary.totalEvents == 0 && summary.events.isEmpty {
                            NoEventsView()
                        } else {
                            EventsTotalsCard(summary: summary, loading: loader.loading)
                            if !summary.daily.isEmpty { EventsChartCard(summary: summary) }
                            if !summary.events.isEmpty { TopEventsCard(events: summary.events) }
                        }
                    } else if loader.error == nil {
                        RoundedRectangle(cornerRadius: 22).fill(Color(.secondarySystemGroupedBackground)).frame(height: 300)
                            .overlay { if !loader.quotaPaused { ProgressView() } }
                    }
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 24)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Events")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: "\(range)-\(model.dataVersion)") { await load() }
    }

    private func load() async {
        guard let client = model.client else { return }
        loader.use(cacheKey: ResponseCache.key("events-summary", appId, range))
        await loadStatus(status, client: client, appId: appId)
        if notConfigured { return }
        await loader.load { try await client.eventSummary(app: appId, range: range) }
    }
}

private struct EventsTotalsCard: View {
    var summary: EventSummary
    var loading: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                if let from = Fmt.day(summary.from), let to = Fmt.day(summary.to) {
                    Text(from.formatted(Self.style) + " – " + to.formatted(Self.style))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if summary.approximate {
                    ApproximateBadge(explanation: "This app sends many events, so the server keeps a sample of them. Counts are estimated from the sample and unique installs can be slightly low.")
                }
                if loading { ProgressView().controlSize(.small) }
            }
            HStack(spacing: 0) {
                stat("Events", summary.totalEvents)
                stat("Unique installs", summary.uniqueInstalls)
            }
        }
        .card()
    }

    private static let style = Date.FormatStyle(timeZone: TimeZone(identifier: "UTC")!).day().month(.abbreviated)

    private func stat(_ title: LocalizedStringKey, _ value: Double) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(Fmt.count(value.rounded(), compact: true))
                .font(.system(size: 28, weight: .bold, design: .rounded))
                .monospacedDigit()
                .contentTransition(.numericText(value: value))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Daily events stacked by the top events (the rest as "Other"), brand colour first.
private struct EventsChartCard: View {
    var summary: EventSummary
    @State private var selected: Date?

    private struct Datum: Identifiable {
        var date: Date
        var series: String
        var value: Double
        var id: String { "\(series)-\(date.timeIntervalSince1970)" }
    }

    private static let maxSeries = 5

    /// Series names, biggest first, "Other" last.
    private var series: [String] {
        var totals: [String: Double] = [:]
        for d in summary.daily { for (k, v) in d.byEvent where k != "(other)" { totals[k, default: 0] += v } }
        return totals.sorted { $0.value > $1.value }.prefix(Self.maxSeries).map(\.key)
    }

    private var otherName: String { String(localized: "Other") }

    private var data: [Datum] {
        let top = Set(series)
        return summary.daily.compactMap { d -> [Datum]? in
            guard let date = Fmt.day(d.date) else { return nil }
            var rows = series.map { Datum(date: date, series: $0, value: d.byEvent[$0] ?? 0) }
            let shown = d.byEvent.filter { top.contains($0.key) }.values.reduce(0, +)
            let rest = max(0, d.count - shown)
            if rest > 0 || !d.byEvent.isEmpty { rows.append(Datum(date: date, series: otherName, value: rest)) }
            return rows
        }.flatMap { $0 }
    }

    private var domain: [String] {
        let hasOther = data.contains { $0.series == otherName && $0.value > 0 }
        return series + (hasOther ? [otherName] : [])
    }

    private var colors: [Color] {
        domain.enumerated().map { i, name in name == otherName ? .gray.opacity(0.5) : MetricChartCard.palette[i % MetricChartCard.palette.count] }
    }

    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }

    private func day(_ date: Date?) -> EventSummary.Day? {
        guard let date else { return nil }
        return summary.daily.last { (Fmt.day($0.date) ?? .distantFuture) <= date }
    }

    var body: some View {
        let selectedDay = day(selected)
        let selectedDate = selectedDay.flatMap { Fmt.day($0.date) }
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                if let selectedDay, let date = selectedDate {
                    Text(date.formatted(Date.FormatStyle(timeZone: utc.timeZone).day().month(.wide).year()))
                        .font(.subheadline).foregroundStyle(.secondary)
                    Text(Fmt.count(selectedDay.count.rounded()))
                        .font(.title2.weight(.bold)).monospacedDigit()
                } else {
                    Text("Events per day").font(.subheadline).foregroundStyle(.secondary)
                    Text(Fmt.count((summary.totalEvents / Double(max(summary.daily.count, 1))).rounded(), compact: true) + " " + String(localized: "on average"))
                        .font(.title2.weight(.bold)).monospacedDigit()
                }
            }
            .animation(.snappy, value: selectedDate)
            Chart(data) { d in
                BarMark(x: .value("Date", d.date, unit: .day), y: .value("Events", d.value))
                    .foregroundStyle(by: .value("Event", d.series))
                    .opacity(selectedDate == nil || utc.isDate(d.date, inSameDayAs: selectedDate!) ? 1 : 0.45)
            }
            .chartForegroundStyleScale(domain: domain, range: colors)
            .chartLegend(position: .bottom, alignment: .leading, spacing: 10)
            .chartXSelection(value: $selected)
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 5)) { _ in
                    AxisGridLine()
                    AxisValueLabel(format: .dateTime.day().month(.abbreviated), centered: false)
                }
            }
            .frame(height: 220)
            .sensoryFeedback(.selection, trigger: selectedDate)
        }
        .card()
    }
}

private struct TopEventsCard: View {
    var events: [EventSummary.Event]
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Top events", systemImage: "list.number")
            ForEach(events.prefix(expanded ? events.count : 12)) { e in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Fmt.analyticsValue(e.name)).font(.subheadline.monospaced()).lineLimit(1)
                        HStack(spacing: 4) {
                            Text("\(Fmt.count(e.installs.rounded(), compact: true)) installs")
                            if let at = e.lastSeenAt {
                                Text(verbatim: "·")
                                Text(Fmt.relative(ms: at))
                            }
                        }
                        .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(Fmt.count(e.count.rounded(), compact: true)).font(.subheadline.weight(.semibold)).monospacedDigit()
                }
                .accessibilityElement(children: .combine)
                if e.id != events.prefix(expanded ? events.count : 12).last?.id { Divider() }
            }
            if events.count > 12 {
                Button(expanded ? "Show less" : "Show all") { withAnimation { expanded.toggle() } }
                    .font(.subheadline.weight(.semibold))
            }
        }
        .card()
    }
}

// MARK: - Funnels

struct FunnelsView: View {
    @Environment(AppModel.self) private var model
    var appId: String
    @State private var status = Loader<AnalyticsStatus>()
    @State private var loader = Loader<[Funnel]>()

    private var notConfigured: Bool { status.value.map { !$0.configured } ?? false }

    var body: some View {
        List {
            if let s = status.value, notConfigured {
                AnalyticsSetupView(status: s).listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            } else {
                if let error = loader.error {
                    ErrorBanner(message: error) { Task { await load() } }.listRowBackground(Color.clear)
                }
                if let funnels = loader.value {
                    Section {
                        ForEach(funnels) { funnel in
                            NavigationLink(value: Route.funnelReport(appId: appId, funnel: funnel)) {
                                FunnelRow(funnel: funnel)
                            }
                        }
                    } footer: {
                        Text("Create and edit funnels in the web panel.")
                    }
                }
            }
        }
        .overlay {
            if !notConfigured {
                if loader.value == nil && loader.loading { ProgressView() }
                else if let funnels = loader.value, funnels.isEmpty {
                    ContentUnavailableView("No funnels yet", systemImage: "line.3.horizontal.decrease", description: Text("Create a funnel in the web panel (the app's Funnels page) to see how many installs go from one step to the next."))
                }
            }
        }
        .navigationTitle("Funnels")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: model.dataVersion) { await load() }
    }

    private func load() async {
        guard let client = model.client else { return }
        loader.use(cacheKey: ResponseCache.key("funnels", appId))
        await loadStatus(status, client: client, appId: appId)
        if notConfigured { return }
        await loader.load { try await client.funnels(app: appId) }
    }
}

private struct FunnelRow: View {
    var funnel: Funnel

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(funnel.name).font(.subheadline.weight(.semibold)).lineLimit(2)
            HStack(spacing: 4) {
                Text("\(funnel.steps.count) steps")
                Text(verbatim: "·")
                Text("Within \(Fmt.window(seconds: funnel.windowSeconds))")
                if !funnel.ordered {
                    Text(verbatim: "·")
                    Text("Any order")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Funnel report

/// A funnel known only by id (an alert or a push): loads the app's funnels, then shows the report.
struct FunnelLookupView: View {
    @Environment(AppModel.self) private var model
    var appId: String
    var funnelId: String
    @State private var funnel: Funnel?
    @State private var error: String?

    var body: some View {
        Group {
            if let funnel {
                FunnelReportView(appId: appId, funnel: funnel)
            } else if let error {
                ContentUnavailableView("Funnel not found", systemImage: "line.3.horizontal.decrease", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .task {
            guard let client = model.client, funnel == nil else { return }
            do {
                if let found = try await client.funnels(app: appId).first(where: { $0.id == funnelId }) {
                    funnel = found
                } else {
                    error = String(localized: "It may have been deleted.")
                }
            } catch {
                self.error = model.handle(error) ?? ((error as? APIError)?.isQuota == true ? error.localizedDescription : "")
            }
        }
    }
}

struct FunnelReportView: View {
    @Environment(AppModel.self) private var model
    var appId: String
    var funnel: Funnel
    @AppStorage("funnel.range") private var range = "28d"
    @State private var breakdown = "none"
    @State private var loader = Loader<FunnelReport>()

    static let breakdowns: [(id: String, title: LocalizedStringKey)] = [
        ("none", "No breakdown"), ("app_version", "App version"), ("os_version", "OS version"), ("country", "Country"),
        ("locale", "Language"), ("placement", "Placement"), ("offering", "Offering"), ("product", "Product"),
        ("screen", "Screen"), ("variant", "Variant"),
    ]

    private var breakdownTitle: LocalizedStringKey {
        Self.breakdowns.first { $0.id == breakdown }?.title ?? "No breakdown"
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                controls
                if let error = loader.error {
                    ErrorBanner(message: error) { Task { await load() } }
                }
                if let report = loader.value {
                    FunnelSummaryCard(report: report, name: report.funnel?.name ?? funnel.name, loading: loader.loading)
                    if !report.steps.isEmpty { FunnelStepsCard(steps: report.steps) }
                    if breakdown != "none" {
                        FunnelGroupsCard(groups: report.groups, breakdown: breakdown, title: breakdownTitle)
                    }
                } else if loader.error == nil {
                    RoundedRectangle(cornerRadius: 22).fill(Color(.secondarySystemGroupedBackground)).frame(height: 320)
                        .overlay { if !loader.quotaPaused { ProgressView() } }
                }
                Text("Create and edit funnels in the web panel.")
                    .font(.footnote).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal)
            .padding(.bottom, 24)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(funnel.name)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: "\(range)-\(breakdown)-\(model.dataVersion)") { await load() }
    }

    private var controls: some View {
        VStack(spacing: 10) {
            Picker("Range", selection: $range) {
                ForEach(AnalyticsRange.all, id: \.id) { r in Text(r.title).tag(r.id) }
            }
            .pickerStyle(.segmented)
            HStack {
                Menu {
                    Picker("Breakdown", selection: $breakdown) {
                        ForEach(Self.breakdowns, id: \.id) { b in Text(b.title).tag(b.id) }
                    }
                } label: {
                    Label(breakdownTitle, systemImage: "square.stack.3d.up").font(.subheadline)
                }
                .buttonStyle(.glass)
                Spacer()
            }
        }
    }

    private func load() async {
        guard let client = model.client else { return }
        let b = breakdown == "none" ? nil : breakdown
        loader.use(cacheKey: ResponseCache.key("funnel-report", appId, funnel.id, range, breakdown))
        await loader.load { try await client.funnelReport(app: appId, funnel: funnel.id, range: range, breakdown: b) }
    }
}

private struct FunnelSummaryCard: View {
    var report: FunnelReport
    var name: String
    var loading: Bool

    private static let style = Date.FormatStyle(timeZone: TimeZone(identifier: "UTC")!).day().month(.abbreviated)

    var body: some View {
        let first = report.steps.first
        let last = report.steps.last
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                if let from = Fmt.day(report.from), let to = Fmt.day(report.to) {
                    Text("Started \(from.formatted(Self.style)) – \(to.formatted(Self.style))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if report.approximate {
                    ApproximateBadge(explanation: "Some numbers are estimated: the server samples events at high volume, caps very large funnels and infers a few steps.", notes: report.notes)
                }
                if loading { ProgressView().controlSize(.small) }
            }
            Text("Conversion").font(.subheadline).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(Fmt.percent(last?.conversionFromFirst ?? 0))
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText(value: last?.conversionFromFirst ?? 0))
                if let first, let last {
                    Text("\(Fmt.count(first.users.rounded(), compact: true)) → \(Fmt.count(last.users.rounded(), compact: true)) people")
                        .font(.subheadline).foregroundStyle(.secondary).monospacedDigit()
                }
            }
            if !report.approximate, !report.notes.isEmpty {
                ForEach(report.notes, id: \.self) { note in
                    Label(note, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .card()
    }
}

/// One horizontal bar per step (width = share of the first step's users).
private struct FunnelStepsCard: View {
    var steps: [FunnelReportStep]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader(title: "Steps", systemImage: "chart.bar.horizontal.page")
            ForEach(Array(steps.enumerated()), id: \.element.id) { i, step in
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("\(i + 1)").font(.caption.weight(.bold)).foregroundStyle(.secondary).frame(width: 16, alignment: .leading)
                        Text(step.label).font(.subheadline.weight(.semibold)).lineLimit(2)
                        Spacer()
                        Text(Fmt.count(step.users.rounded())).font(.subheadline.weight(.semibold)).monospacedDigit()
                    }
                    FunnelBar(fraction: step.conversionFromFirst, label: Fmt.percent(step.conversionFromFirst))
                    if i > 0 {
                        HStack(spacing: 10) {
                            Label { Text(Fmt.percent(step.conversionFromPrevious)) } icon: { Image(systemName: "arrow.down.right") }
                                .accessibilityLabel(Text("From previous \(Fmt.percent(step.conversionFromPrevious))"))
                            if step.dropOff > 0 {
                                Label { Text("Lost \(Fmt.count(step.dropOff.rounded(), compact: true))") } icon: { Image(systemName: "person.fill.xmark") }
                            }
                            if let median = step.medianSecondsFromPrevious {
                                Label { Text(Fmt.duration(seconds: median)) } icon: { Image(systemName: "timer") }
                                    .accessibilityLabel(Text("Median time \(Fmt.duration(seconds: median))"))
                            }
                        }
                        .labelStyle(CompactLabelStyle())
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .card()
    }
}

private struct CompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}

private struct FunnelBar: View {
    var fraction: Double
    var label: String
    var height: CGFloat = 22

    var body: some View {
        GeometryReader { geo in
            let f = min(max(fraction, 0), 1)
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.brand.opacity(0.12))
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(LinearGradient(colors: [Color.brand, Color.brand.opacity(0.75)], startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(f > 0 ? 4 : 0, geo.size.width * f))
                Text(label)
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(f > 0.22 ? Color.white : Color.primary)
                    .padding(.horizontal, 8)
            }
        }
        .frame(height: height)
        .animation(.smooth, value: fraction)
    }
}

/// Per breakdown value: entries, overall conversion and each step's share of the first.
private struct FunnelGroupsCard: View {
    var groups: [FunnelReport.Group]
    var breakdown: String
    var title: LocalizedStringKey

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: title, systemImage: "square.stack.3d.up")
            if groups.isEmpty {
                Text("No data for this breakdown yet.").font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(groups) { group in
                let first = group.steps.first?.users ?? 0
                let overall = group.steps.last?.conversionFromFirst ?? 0
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(Fmt.analyticsValue(group.value, breakdown: breakdown)).font(.subheadline).lineLimit(1)
                        Spacer()
                        Text("\(Fmt.count(first.rounded(), compact: true)) people").font(.caption).foregroundStyle(.secondary).monospacedDigit()
                        Text(Fmt.percent(overall)).font(.subheadline.weight(.semibold)).monospacedDigit().frame(minWidth: 48, alignment: .trailing)
                    }
                    FunnelBar(fraction: overall, label: "", height: 6)
                    Text(group.steps.dropFirst().map { Fmt.percent($0.conversionFromFirst) }.joined(separator: " → "))
                        .font(.caption2).foregroundStyle(.secondary).monospacedDigit().lineLimit(1)
                }
                .accessibilityElement(children: .combine)
                if group.id != groups.last?.id { Divider() }
            }
        }
        .card()
    }
}

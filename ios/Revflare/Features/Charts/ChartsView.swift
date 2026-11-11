import Charts
import SwiftUI

struct ChartsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("chart.metric") private var metric = "revenue"
    @AppStorage("chart.range") private var range = "28d"
    @AppStorage("chart.interval") private var interval = "auto"
    @AppStorage("chart.groupBy") private var groupBy = "none"
    @State private var apps: Set<String> = []
    @State private var showFilter = false
    @State private var loader = Loader<MetricChart>()

    static let ranges: [(id: String, title: LocalizedStringKey)] = [("7d", "7D"), ("28d", "28D"), ("90d", "90D"), ("12m", "12M"), ("ytd", "YTD"), ("all", "All")]

    static let groups: [(title: LocalizedStringKey, metrics: [String])] = [
        ("Revenue", ["revenue", "proceeds", "arppu", "refunds_amount"]),
        ("Subscriptions", ["mrr", "mrr_proceeds", "arr", "active_subscriptions", "new_subscriptions", "renewals", "churned_subscriptions", "churn_rate"]),
        ("Trials", ["active_trials", "trials_started", "trial_conversions", "trial_conversion_rate"]),
        ("Other", ["one_time_purchases", "new_customers", "refunds", "refund_rate"]),
    ]

    var body: some View {
        @Bindable var model = model
        ScrollView {
            VStack(spacing: 16) {
                controls
                if let error = loader.error, loader.value == nil {
                    ErrorBanner(message: error) { Task { await load() } }
                }
                if let chart = loader.value {
                    MetricChartCard(chart: chart, info: MetricInfo.info(metric), loading: loader.loading)
                    if let series = chart.series, !series.isEmpty {
                        SeriesList(chart: chart, series: series)
                    } else {
                        PointsList(chart: chart)
                    }
                } else {
                    RoundedRectangle(cornerRadius: 22).fill(Color(.secondarySystemGroupedBackground)).frame(height: 340)
                        .overlay { if loader.error == nil && !loader.quotaPaused { ProgressView() } }
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 24)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(Text(MetricInfo.info(metric).title))
        .toolbarTitleDisplayMode(.inlineLarge)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    showFilter = true
                } label: {
                    Image(systemName: apps.isEmpty ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
                }
                .accessibilityLabel(Text("Filter apps"))
                metricMenu
            }
        }
        .sheet(isPresented: $showFilter) {
            AppPickerSheet(title: "Filter apps", selection: $apps)
        }
        .refreshable { await load() }
        .task(id: Key(metric: metric, range: range, interval: interval, groupBy: groupBy, apps: apps, version: model.dataVersion)) {
            await load()
        }
        .onAppear(perform: takeRequest)
        .onChange(of: model.chartRequest) { takeRequest() }
    }

    private struct Key: Equatable {
        var metric, range, interval, groupBy: String
        var apps: Set<String>
        var version: Int
    }

    private func takeRequest() {
        if let request = model.chartRequest {
            metric = request
            model.chartRequest = nil
        }
    }

    private var metricMenu: some View {
        Menu {
            ForEach(Array(Self.groups.enumerated()), id: \.offset) { _, group in
                Section(group.title) {
                    ForEach(group.metrics, id: \.self) { id in
                        Button {
                            metric = id
                        } label: {
                            if id == metric { Label { Text(MetricInfo.info(id).title) } icon: { Image(systemName: "checkmark") } } else { Text(MetricInfo.info(id).title) }
                        }
                    }
                }
            }
        } label: {
            Image(systemName: "chart.bar.doc.horizontal")
        }
        .accessibilityLabel(Text("Metric"))
    }

    private var controls: some View {
        VStack(spacing: 10) {
            Picker("Range", selection: $range) {
                ForEach(Self.ranges, id: \.id) { r in Text(r.title).tag(r.id) }
            }
            .pickerStyle(.segmented)
            HStack(spacing: 8) {
                Menu {
                    Picker("Interval", selection: $interval) {
                        Text("Automatic").tag("auto")
                        Text("Daily").tag("day")
                        Text("Weekly").tag("week")
                        Text("Monthly").tag("month")
                    }
                } label: {
                    Label(intervalTitle, systemImage: "calendar").font(.subheadline)
                }
                .buttonStyle(.glass)
                Menu {
                    Picker("Group by", selection: $groupBy) {
                        Text("No grouping").tag("none")
                        Text("App").tag("app")
                        Text("Country").tag("country")
                        Text("Product").tag("product")
                    }
                } label: {
                    Label(groupTitle, systemImage: "square.stack.3d.up").font(.subheadline)
                }
                .buttonStyle(.glass)
                Spacer()
            }
        }
    }

    private var intervalTitle: LocalizedStringKey {
        switch interval {
        case "day": "Daily"
        case "week": "Weekly"
        case "month": "Monthly"
        default: "Automatic"
        }
    }

    private var groupTitle: LocalizedStringKey {
        switch groupBy {
        case "app": "By app"
        case "country": "By country"
        case "product": "By product"
        default: "No grouping"
        }
    }

    private func load() async {
        guard let client = model.client else { return }
        let iv = interval == "auto" ? nil : interval
        let g = groupBy == "none" ? nil : groupBy
        loader.use(cacheKey: ResponseCache.key("chart", metric, range, interval, groupBy, appsParam(apps) ?? "all"))
        await loader.load { try await client.chart(metric, range: range, interval: iv, groupBy: g, apps: apps) }
    }
}

/// The chart with its header (total, change vs previous period) and finger scrubbing.
struct MetricChartCard: View {
    var chart: MetricChart
    var info: MetricInfo
    var loading = false
    var height: CGFloat = 240

    @State private var selected: Date?
    @Environment(\.redactionReasons) private var redaction

    private struct Datum: Identifiable {
        var date: Date
        var value: Double
        var series: String
        var id: String { "\(series)-\(date.timeIntervalSince1970)" }
    }

    private var unit: Calendar.Component {
        switch chart.interval {
        case "week": .weekOfYear
        case "month": .month
        default: .day
        }
    }

    private var data: [Datum] {
        if let series = chart.series, !series.isEmpty {
            return series.flatMap { s in s.points.compactMap { p in Fmt.day(p.date).map { Datum(date: $0, value: p.value, series: s.label) } } }
        }
        return chart.points.compactMap { p in Fmt.day(p.date).map { Datum(date: $0, value: p.value, series: "") } }
    }

    private var grouped: Bool { !(chart.series ?? []).isEmpty }
    private var useBars: Bool { !info.isStock && chart.points.count <= 45 }

    private var change: Double? {
        guard let prev = chart.previousTotal, prev != 0 else { return nil }
        return (chart.total - prev) / abs(prev)
    }

    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }

    private func bucket(_ date: Date) -> Date? {
        chart.points.compactMap { Fmt.day($0.date) }.last { $0 <= date } ?? chart.points.first.flatMap { Fmt.day($0.date) }
    }

    var body: some View {
        let selectedBucket = selected.flatMap(bucket)
        VStack(alignment: .leading, spacing: 14) {
            header(selectedBucket)
            Chart {
                ForEach(data) { d in
                    if useBars {
                        BarMark(x: .value("Date", d.date, unit: unit), y: .value("Value", d.value))
                            .foregroundStyle(by: .value("Series", grouped ? d.series : "—"))
                            .opacity(selectedBucket == nil || utc.isDate(d.date, equalTo: selectedBucket!, toGranularity: unit) ? 1 : 0.45)
                    } else {
                        LineMark(x: .value("Date", d.date, unit: unit), y: .value("Value", d.value))
                            .foregroundStyle(by: .value("Series", grouped ? d.series : "—"))
                            .interpolationMethod(.monotone)
                            .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round))
                        if !grouped {
                            AreaMark(x: .value("Date", d.date, unit: unit), y: .value("Value", d.value))
                                .foregroundStyle(LinearGradient(colors: [Color.brand.opacity(0.3), Color.brand.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                                .interpolationMethod(.monotone)
                        }
                    }
                }
                if let selectedBucket {
                    RuleMark(x: .value("Date", selectedBucket, unit: unit))
                        .foregroundStyle(Color.secondary.opacity(0.6))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                }
            }
            .chartForegroundStyleScale(range: grouped ? Self.palette : [Color.brand])
            .chartLegend(grouped ? .visible : .hidden)
            .chartLegend(position: .bottom, alignment: .leading, spacing: 10)
            .chartXSelection(value: $selected)
            .chartYAxis { PrivacyAwareYAxis(currency: chart.currency, format: chart.format, hide: redaction.contains(.privacy)) }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 5)) { _ in
                    AxisGridLine()
                    AxisValueLabel(format: chart.interval == "month" ? .dateTime.month(.abbreviated) : .dateTime.day().month(.abbreviated), centered: false)
                }
            }
            .frame(height: height)
            .sensoryFeedback(.selection, trigger: selectedBucket)
            .animation(.smooth, value: chart.points.count)
        }
        .card()
        .overlay(alignment: .topTrailing) {
            if loading { ProgressView().padding(14) }
        }
    }

    @ViewBuilder
    private func header(_ bucket: Date?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let bucket {
                let value = valueAt(bucket)
                Text(bucket.formatted(chart.interval == "month" ? Date.FormatStyle(timeZone: utc.timeZone).month(.wide).year() : Date.FormatStyle(timeZone: utc.timeZone).day().month(.wide).year()))
                    .font(.subheadline).foregroundStyle(.secondary)
                MetricValueText(value: value, format: chart.format, currency: chart.currency)
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .contentTransition(.numericText(value: value))
                if grouped, let series = chart.series {
                    ForEach(series.prefix(4)) { s in
                        if let v = s.points.first(where: { Fmt.day($0.date) == bucket })?.value, v != 0 {
                            HStack {
                                Text(s.label).lineLimit(1)
                                Spacer()
                                MetricValueText(value: v, format: chart.format, currency: chart.currency)
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                Text(info.isStock ? "Now" : "Total").font(.subheadline).foregroundStyle(.secondary)
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    MetricValueText(value: chart.total, format: chart.format, currency: chart.currency)
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                        .contentTransition(.numericText(value: chart.total))
                        .minimumScaleFactor(0.5)
                        .lineLimit(1)
                    ChangePill(change: change, lowerIsBetter: info.lowerIsBetter)
                }
                if let prev = chart.previousTotal {
                    HStack(spacing: 4) {
                        Text("Previous period")
                        MetricValueText(value: prev, format: chart.format, currency: chart.currency)
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .animation(.snappy, value: bucket)
    }

    private func valueAt(_ date: Date) -> Double {
        if grouped, let series = chart.series {
            if info.format == .percent { return chart.points.first { Fmt.day($0.date) == date }?.value ?? 0 }
            return series.reduce(0) { $0 + ($1.points.first { Fmt.day($0.date) == date }?.value ?? 0) }
        }
        return chart.points.first { Fmt.day($0.date) == date }?.value ?? 0
    }

    static let palette: [Color] = [.brand, .blue, .purple, .teal, .pink, .yellow, .indigo, .mint, .green, .gray]
}

private struct SeriesList: View {
    var chart: MetricChart
    var series: [Series]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Breakdown", systemImage: "list.bullet")
            ForEach(Array(series.enumerated()), id: \.element.id) { i, s in
                HStack {
                    Circle().fill(MetricChartCard.palette[i % MetricChartCard.palette.count]).frame(width: 9, height: 9)
                    Text(s.label).lineLimit(1)
                    Spacer()
                    MetricValueText(value: s.total ?? s.points.reduce(0) { $0 + $1.value }, format: chart.format, currency: chart.currency)
                        .fontWeight(.semibold)
                }
                .font(.subheadline)
            }
        }
        .card()
    }
}

private struct PointsList: View {
    var chart: MetricChart
    @State private var expanded = false

    var body: some View {
        let points = Array(chart.points.reversed())
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Values", systemImage: "tablecells")
            ForEach(points.prefix(expanded ? points.count : 7), id: \.date) { p in
                HStack {
                    Text(Fmt.dayLabel(p.date, interval: chart.interval)).foregroundStyle(.secondary)
                    Spacer()
                    MetricValueText(value: p.value, format: chart.format, currency: chart.currency)
                }
                .font(.subheadline)
            }
            if points.count > 7 {
                Button(expanded ? "Show less" : "Show all") { withAnimation { expanded.toggle() } }
                    .font(.subheadline.weight(.semibold))
            }
        }
        .card()
    }
}

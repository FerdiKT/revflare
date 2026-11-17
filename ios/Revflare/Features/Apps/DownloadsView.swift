import Charts
import SwiftUI

// App Store downloads (`GET /downloads`, Apple's Sales and Trends reports): first downloads, redownloads and updates
// per report day (Pacific time, about a day late), with what they turned into from Revflare's own sales.

struct DownloadsView: View {
    @Environment(AppModel.self) private var model
    /// Opened for one app (app detail, a row of the ranking); nil = the whole workspace.
    var appId: String?
    @AppStorage("downloads.range") private var range = "28d"
    @State private var apps: Set<String> = []
    @State private var showFilter = false
    @State private var loader = Loader<Downloads>()

    static let ranges: [(id: String, title: LocalizedStringKey)] = [("7d", "7D"), ("28d", "28D"), ("90d", "90D"), ("12m", "12M")]

    init(appId: String?) {
        self.appId = appId
        _apps = State(initialValue: appId.map { [$0] } ?? [])
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Picker("Range", selection: $range) {
                    ForEach(Self.ranges, id: \.id) { r in Text(r.title).tag(r.id) }
                }
                .pickerStyle(.segmented)
                if let error = loader.error, loader.value == nil {
                    ErrorBanner(message: error) { Task { await load() } }
                }
                if let d = loader.value {
                    if d.firstDay == nil {
                        DownloadsEmptyView()
                    } else {
                        content(d)
                    }
                } else if loader.error == nil {
                    RoundedRectangle(cornerRadius: 22).fill(Color(.secondarySystemGroupedBackground)).frame(height: 340)
                        .overlay { if !loader.quotaPaused { ProgressView() } }
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 24)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showFilter = true
                } label: {
                    Image(systemName: apps.isEmpty ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
                }
                .accessibilityLabel(Text("Filter apps"))
            }
        }
        .sheet(isPresented: $showFilter) {
            AppPickerSheet(title: "Filter apps", selection: $apps)
        }
        .refreshable { await load() }
        .task(id: Key(range: range, apps: apps, version: model.dataVersion)) { await load() }
    }

    private struct Key: Equatable {
        var range: String
        var apps: Set<String>
        var version: Int
    }

    private var title: Text {
        if apps.count == 1, let id = apps.first, let app = model.app(id) { return Text(app.name) }
        return Text("Downloads")
    }

    @ViewBuilder
    private func content(_ d: Downloads) -> some View {
        DownloadWindowsRow(windows: d.windows)
        DownloadKpiGrid(data: d)
        DownloadChartCard(days: d.days)
        if !d.apps.isEmpty, !(apps.count == 1 && d.apps.count == 1) {
            DownloadAppsCard(apps: d.apps, currency: d.currency, scopedTo: apps)
        }
        if !d.countries.isEmpty { DownloadCountriesCard(countries: d.countries) }
        if !d.devices.isEmpty { DownloadDevicesCard(devices: d.devices) }
        footnote(d)
    }

    private func footnote(_ d: Downloads) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let last = d.lastDay {
                Text("Newest report day: \(Fmt.dayLabel(last))")
            }
            Text("Report days are Pacific time and arrive about a day late. Trials, payers and revenue come from Revflare's sales (UTC days).")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }

    private func load() async {
        guard let client = model.client else { return }
        let range = range, apps = apps
        loader.use(cacheKey: ResponseCache.key("downloads", range, appsParam(apps) ?? "all"))
        await loader.load { try await client.downloads(range: range, apps: apps) }
    }
}

// MARK: - Windows (7 / 28 / 90 days)

private struct DownloadWindowsRow: View {
    var windows: [DownloadWindow]

    var body: some View {
        HStack(spacing: 10) {
            ForEach(windows.sorted { $0.days < $1.days }) { w in
                VStack(alignment: .leading, spacing: 5) {
                    Text("Last \(w.days) days")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Text(Fmt.count(Double(w.downloads), compact: true))
                        .font(.title3.weight(.bold))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    if w.change != nil {
                        ChangePill(change: w.change)
                    } else {
                        Text("No earlier data").font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                    }
                }
                .card(padding: 12)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

// MARK: - KPIs

private struct DownloadKpiGrid: View {
    var data: Downloads

    private var counts: DownloadCounts { data.totals.counts }
    private var conv: DownloadConversions { data.totals.conversions }

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
            DownloadTile(title: "First downloads", change: Self.change(counts.downloads, data.previous.downloads),
                         caption: counts.paidDownloads > 0 ? String(localized: "\(Fmt.count(counts.paidDownloads)) paid") : nil) {
                Text(Fmt.count(Double(counts.downloads), compact: true))
            }
            DownloadTile(title: "Redownloads", change: Self.change(counts.redownloads, data.previous.redownloads)) {
                Text(Fmt.count(Double(counts.redownloads), compact: true))
            }
            DownloadTile(title: "Updates", change: Self.change(counts.updates, data.previous.updates)) {
                Text(Fmt.count(Double(counts.updates), compact: true))
            }
            DownloadTile(title: "Download → trial", caption: String(localized: "\(Fmt.count(conv.trialsStarted)) trials")) {
                Text(conv.downloadToTrial.map(Fmt.percent) ?? "–")
            }
            DownloadTile(title: "Download → paid", caption: String(localized: "\(Fmt.count(conv.newPayers)) new payers")) {
                Text(conv.downloadToPaid.map(Fmt.percent) ?? "–")
            }
            DownloadTile(title: "Revenue per download") {
                if let rpd = conv.revenuePerDownload {
                    MoneyText(value: rpd, currency: data.currency)
                } else {
                    Text("–")
                }
            }
            DownloadTile(title: "Apple Ads share",
                         caption: conv.appleAdsShare.map { String(localized: "Organic \(Fmt.percent(max(0, 1 - $0)))") }
                             ?? String(localized: "Needs RevflareKit")) {
                Text(conv.appleAdsShare.map(Fmt.percent) ?? "–")
            }
        }
    }

    static func change(_ value: Int, _ previous: Int) -> Double? {
        previous > 0 ? Double(value) / Double(previous) - 1 : nil
    }
}

private struct DownloadTile<Value: View>: View {
    var title: LocalizedStringKey
    var change: Double?
    var caption: String?
    @ViewBuilder var value: Value

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            value
                .font(.title3.weight(.bold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            HStack(spacing: 6) {
                ChangePill(change: change)
                if let caption {
                    Text(caption).font(.caption).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
                }
            }
            .frame(minHeight: 20, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .card(padding: 14)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Chart

private struct DownloadChartCard: View {
    var days: [DownloadDay]
    @AppStorage("downloads.showUpdates") private var showUpdates = false
    @AppStorage("downloads.showConversion") private var showConversion = false

    private struct Bar: Identifiable {
        var id: String { "\(day)-\(series)" }
        var day: Date
        var series: String
        var value: Int
    }

    private struct Point: Identifiable {
        var id: String { "\(day)-\(series)" }
        var day: Date
        var series: String
        var value: Double
    }

    private static var free: String { String(localized: "Free first downloads") }
    private static var paid: String { String(localized: "Paid first downloads") }
    private static var redownloads: String { String(localized: "Redownloads") }
    private static var updates: String { String(localized: "Updates") }
    private static var toTrial: String { String(localized: "Download → trial") }
    private static var toPaid: String { String(localized: "Download → paid") }

    private var bars: [Bar] {
        days.flatMap { d -> [Bar] in
            guard let day = Fmt.day(d.day) else { return [] }
            var out = [
                Bar(day: day, series: Self.free, value: d.counts.freeDownloads),
                Bar(day: day, series: Self.paid, value: d.counts.paidDownloads),
                Bar(day: day, series: Self.redownloads, value: d.counts.redownloads),
            ]
            if showUpdates { out.append(Bar(day: day, series: Self.updates, value: d.counts.updates)) }
            return out
        }
    }

    private var points: [Point] {
        days.flatMap { d -> [Point] in
            guard let day = Fmt.day(d.day), d.counts.downloads > 0 else { return [] }
            let n = Double(d.counts.downloads)
            return [
                Point(day: day, series: Self.toTrial, value: Double(d.conversions.trialsStarted) / n),
                Point(day: day, series: Self.toPaid, value: Double(d.conversions.newPayers) / n),
            ]
        }
    }

    private var barDomain: [String] { [Self.free, Self.paid, Self.redownloads] + (showUpdates ? [Self.updates] : []) }
    private var barColors: [Color] { [.brand, .green, .blue] + (showUpdates ? [Color.gray.opacity(0.6)] : []) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Downloads by day", systemImage: "chart.bar")
            if days.isEmpty {
                Text("No report days in this range.")
                    .font(.footnote).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 120)
            } else {
                Chart(bars) { b in
                    BarMark(x: .value("Day", b.day, unit: .day), y: .value("Downloads", b.value))
                        .foregroundStyle(by: .value("Series", b.series))
                }
                .chartForegroundStyleScale(domain: barDomain, range: barColors)
                .chartLegend(position: .bottom, alignment: .leading)
                .frame(height: 220)

                if showConversion {
                    Chart(points) { p in
                        LineMark(x: .value("Day", p.day, unit: .day), y: .value("Rate", p.value))
                            .foregroundStyle(by: .value("Series", p.series))
                            .interpolationMethod(.monotone)
                    }
                    .chartForegroundStyleScale(domain: [Self.toTrial, Self.toPaid], range: [Color.purple, Color.teal])
                    .chartYAxis {
                        AxisMarks { v in
                            AxisGridLine()
                            AxisValueLabel { if let r = v.as(Double.self) { Text(Fmt.percent(r)) } }
                        }
                    }
                    .chartLegend(position: .bottom, alignment: .leading)
                    .frame(height: 140)
                }
            }
            Divider()
            Toggle("Show updates", isOn: $showUpdates).font(.subheadline)
            Toggle("Show conversion rates", isOn: $showConversion).font(.subheadline)
        }
        .card()
    }
}

// MARK: - Apps

private struct DownloadAppsCard: View {
    @Environment(AppModel.self) private var model
    var apps: [DownloadApp]
    var currency: String
    var scopedTo: Set<String>

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Apps", systemImage: "square.grid.2x2")
            ForEach(apps) { app in
                if let id = app.appId, scopedTo != [id] {
                    NavigationLink(value: Route.downloads(appId: id)) {
                        row(app, chevron: true)
                    }
                    .buttonStyle(.plain)
                } else {
                    row(app, chevron: false)
                }
                if app.id != apps.last?.id { Divider() }
            }
            if apps.contains(where: { $0.appId == nil }) {
                Text("Dimmed apps are in your developer account but not in Revflare.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .card()
    }

    private func row(_ app: DownloadApp, chevron: Bool) -> some View {
        let local = app.appId.flatMap { model.app($0) }
        return HStack(alignment: .top, spacing: 12) {
            AppIconView(url: local?.iconUrl, name: app.name, size: 36)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(app.name).font(.subheadline.weight(.medium)).lineLimit(1)
                    Spacer(minLength: 6)
                    Text(Fmt.count(Double(app.counts.downloads), compact: true))
                        .font(.subheadline.weight(.semibold)).monospacedDigit()
                    ChangePill(change: app.change)
                }
                Text(windowsLine(app))
                    .font(.caption).foregroundStyle(.secondary).monospacedDigit().lineLimit(1)
                HStack(spacing: 10) {
                    if let rpd = app.conversions.revenuePerDownload {
                        HStack(spacing: 3) {
                            Text("RPD")
                            MoneyText(value: rpd, currency: currency)
                        }
                    }
                    if let t = app.conversions.downloadToTrial {
                        Text("→ trial \(Fmt.percent(t))")
                    }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            if chevron {
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                    .padding(.top, 4)
            }
        }
        .opacity(app.appId == nil ? 0.5 : 1)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// "7d 120 · 28d 540 · 90d 1.6K"
    private func windowsLine(_ app: DownloadApp) -> String {
        app.windows.sorted { $0.days < $1.days }
            .map { String(localized: "\($0.days)d \(Fmt.count(Double($0.downloads), compact: true))") }
            .joined(separator: " · ")
    }
}

// MARK: - Countries and devices

/// One labelled bar of a breakdown (share of the largest value).
private struct BreakdownBar: View {
    var label: String
    var value: Int
    var max: Int
    var tint: Color = .brand

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label).font(.subheadline).lineLimit(1)
                Spacer()
                Text(Fmt.count(value)).font(.subheadline.weight(.semibold)).monospacedDigit()
            }
            GeometryReader { geo in
                Capsule().fill(tint.opacity(0.12))
                    .overlay(alignment: .leading) {
                        Capsule().fill(tint)
                            .frame(width: max > 0 ? geo.size.width * Double(value) / Double(max) : 0)
                    }
            }
            .frame(height: 6)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct DownloadCountriesCard: View {
    var countries: [DownloadCountry]
    @State private var showAll = false

    var body: some View {
        let shown = showAll ? countries : Array(countries.prefix(10))
        let top = countries.map(\.counts.downloads).max() ?? 0
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Countries", systemImage: "globe")
            ForEach(shown) { c in
                BreakdownBar(label: "\(Fmt.flag(c.country)) \(Fmt.country(c.country))", value: c.counts.downloads, max: top)
            }
            if countries.count > 10 {
                Button(showAll ? "Show less" : "Show all") {
                    withAnimation(.smooth) { showAll.toggle() }
                }
                .font(.subheadline.weight(.semibold))
            }
        }
        .card()
    }
}

private struct DownloadDevicesCard: View {
    var devices: [DownloadDevice]

    var body: some View {
        let top = devices.map(\.counts.downloads).max() ?? 0
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Devices", systemImage: "iphone")
            ForEach(devices) { d in
                BreakdownBar(label: d.device.isEmpty ? String(localized: "Unknown") : d.device, value: d.counts.downloads, max: top, tint: .blue)
            }
        }
        .card()
    }
}

// MARK: - Empty state

private struct DownloadsEmptyView: View {
    @Environment(AppModel.self) private var model
    @State private var syncing = false
    @State private var started = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 14) {
            ContentUnavailableView {
                Label("No download reports yet", systemImage: "arrow.down.app")
            } description: {
                Text("Revflare reads Apple's Sales and Trends reports. Add an App Store Connect key with the Sales role and your vendor number in the Revflare web app.")
            }
            if let error { ErrorBanner(message: error) }
            if started {
                Label("Import started. Downloads show up here in a few minutes.", systemImage: "checkmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(.green)
                    .multilineTextAlignment(.center)
            } else if model.canManage {
                Button {
                    Task { await sync() }
                } label: {
                    if syncing {
                        ProgressView()
                    } else {
                        Label("Import the last 90 days", systemImage: "arrow.down.circle")
                    }
                }
                .buttonStyle(.glassProminent)
                .disabled(syncing)
            }
        }
        .card()
    }

    private func sync() async {
        guard let client = model.client else { return }
        syncing = true
        defer { syncing = false }
        do {
            _ = try await client.syncDownloads(days: 90)
            error = nil
            started = true
        } catch {
            self.error = model.handle(error) ?? error.localizedDescription
        }
    }
}

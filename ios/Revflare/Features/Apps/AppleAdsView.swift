import SwiftUI

// Apple Ads attributed revenue of one app (`GET /revenue/attributed`, RevflareKit): coverage, totals and a
// campaign → ad group → keyword drill-down aggregated on the device from the per-day rows.

/// One campaign, ad group or keyword: the summed rows under it.
struct AdsGroup: Identifiable, Hashable {
    enum Level { case campaign, adGroup, keyword }

    var id: String
    var label: String
    /// No name known: `label` is "#<id>" (or "No ad group" / "No keyword").
    var unnamed: Bool
    /// Every row under it is test data (only with "Include test data").
    var test: Bool
    var installs: Double = 0
    var trials: Double = 0
    var payers: Double = 0
    var revenue: Double = 0
    var proceeds: Double = 0
    var rows: [AttributedRevenue.Row] = []

    var revenuePerInstall: Double? { installs > 0 ? revenue / installs : nil }

    mutating func add(_ r: AttributedRevenue.Row) {
        installs += r.installs
        trials += r.trials
        payers += r.payers
        revenue += r.revenue
        proceeds += r.proceeds
        test = test && r.test
        rows.append(r)
    }

    static func total(_ rows: [AttributedRevenue.Row]) -> AdsGroup {
        var g = AdsGroup(id: "total", label: "", unnamed: false, test: !rows.isEmpty)
        rows.forEach { g.add($0) }
        g.rows = []
        return g
    }

    /// Groups rows by campaign, ad group or keyword, by revenue, then installs.
    static func groups(_ rows: [AttributedRevenue.Row], level: Level) -> [AdsGroup] {
        var out: [String: AdsGroup] = [:]
        var order: [String] = []
        for r in rows {
            let (id, name): (String?, String?) = switch level {
            case .campaign: (r.campaignId, r.campaignName)
            case .adGroup: (r.adGroupId, r.adGroupName)
            case .keyword: (r.keywordId, r.keywordName)
            }
            let key = id ?? ""
            if out[key] == nil {
                let label = AdsAttribution.label(name: name, id: id) ?? missingLabel(level)
                out[key] = AdsGroup(id: key, label: label, unnamed: name?.isEmpty ?? true, test: true)
                order.append(key)
            } else if out[key]?.unnamed == true, let name, !name.isEmpty {
                out[key]?.label = name
                out[key]?.unnamed = false
            }
            out[key]?.add(r)
        }
        return order.compactMap { out[$0] }.sorted {
            $0.revenue != $1.revenue ? $0.revenue > $1.revenue : $0.installs > $1.installs
        }
    }

    private static func missingLabel(_ level: Level) -> String {
        switch level {
        case .campaign: String(localized: "Unknown campaign")
        case .adGroup: String(localized: "No ad group")
        case .keyword: String(localized: "No keyword")
        }
    }
}

struct AppleAdsView: View {
    @Environment(AppModel.self) private var model
    var appId: String
    @AppStorage("appleAds.range") private var range = "28d"
    @AppStorage("appleAds.includeTest") private var includeTest = false
    @State private var loader = Loader<AttributedRevenue>()

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Picker("Range", selection: $range) {
                    ForEach(AnalyticsRange.all, id: \.id) { r in Text(r.title).tag(r.id) }
                }
                .pickerStyle(.segmented)
                Toggle(isOn: $includeTest) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Include test data")
                        Text("Apple's test attribution, sandbox and Xcode builds, test devices")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .card()
                if let error = loader.error {
                    ErrorBanner(message: error) { Task { await load() } }
                }
                if let d = loader.value {
                    AdsCoverageCard(data: d)
                    if d.rows.isEmpty {
                        ContentUnavailableView("No Apple Ads installs in this range", systemImage: "megaphone",
                                               description: Text("Revenue shows up here once RevflareKit installs that Apple attributed to Apple Ads make purchases."))
                    } else {
                        AdsTotalsCard(group: AdsGroup.total(d.rows), currency: d.currency)
                        AdsGroupList(title: "Campaigns", rows: d.rows, level: .campaign, currency: d.currency)
                    }
                } else if loader.error == nil {
                    RoundedRectangle(cornerRadius: 22).fill(Color(.secondarySystemGroupedBackground)).frame(height: 300)
                        .overlay { if !loader.quotaPaused { ProgressView() } }
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 24)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Apple Ads")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: "\(range)-\(includeTest)-\(model.dataVersion)") { await load() }
    }

    private func load() async {
        guard let client = model.client else { return }
        let range = range, includeTest = includeTest
        loader.use(cacheKey: ResponseCache.key("attributed", appId, range, includeTest ? "test" : "prod"))
        await loader.load { try await client.attributedRevenue(app: appId, range: range, includeTest: includeTest) }
    }
}

/// "17 of 87 reporting installs came from Apple Ads · 8 test hidden".
private struct AdsCoverageCard: View {
    var data: AttributedRevenue
    private var c: AttributedRevenue.Coverage { data.coverage }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Coverage", systemImage: "antenna.radiowaves.left.and.right")
            if c.installs > 0 {
                ProgressView(value: Double(min(c.attributed, c.installs)), total: Double(c.installs))
                    .tint(.blue)
                    .accessibilityHidden(true)
            }
            Text(line).font(.subheadline)
            if c.installs == 0 {
                Text("No installs reported to RevflareKit in this range.").font(.caption).foregroundStyle(.secondary)
            }
        }
        .card()
    }

    private var line: String {
        var parts = [String(localized: "\(c.attributed) of \(c.installs) reporting installs came from Apple Ads")]
        if c.testInstalls > 0 {
            parts.append(data.includeTest ? String(localized: "\(c.testInstalls) test included") : String(localized: "\(c.testInstalls) test hidden"))
        }
        return parts.joined(separator: " · ")
    }
}

/// Totals of a level (the whole app, a campaign or an ad group).
private struct AdsTotalsCard: View {
    var group: AdsGroup
    var currency: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Apple Ads installs", systemImage: "megaphone")
            AdsMetricsGrid(group: group, currency: currency, large: true)
        }
        .card()
    }
}

/// Installs, trials, payers / revenue, proceeds, revenue per install.
private struct AdsMetricsGrid: View {
    var group: AdsGroup
    var currency: String
    var large = false

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: large ? 12 : 6) {
            GridRow {
                cell("Installs") { Text(Fmt.count(group.installs)).monospacedDigit() }
                cell("Trials") { Text(Fmt.count(group.trials)).monospacedDigit() }
                cell("Payers") { Text(Fmt.count(group.payers)).monospacedDigit() }
            }
            GridRow {
                cell("Revenue") { MoneyText(value: group.revenue, currency: currency, compact: !large) }
                cell("Proceeds") { MoneyText(value: group.proceeds, currency: currency, compact: !large) }
                cell("Per install") {
                    if let v = group.revenuePerInstall {
                        MoneyText(value: v, currency: currency)
                    } else {
                        Text(verbatim: "–").foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func cell<V: View>(_ title: LocalizedStringKey, @ViewBuilder value: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            value()
                .font(large ? .headline : .subheadline.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// Campaigns, a campaign's ad groups or an ad group's keywords; rows open the next level.
private struct AdsGroupList: View {
    var title: LocalizedStringKey
    var rows: [AttributedRevenue.Row]
    var level: AdsGroup.Level
    var currency: String

    var body: some View {
        let groups = AdsGroup.groups(rows, level: level)
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: title, systemImage: icon)
            ForEach(groups) { g in
                if let next {
                    NavigationLink {
                        AdsLevelView(group: g, level: next, currency: currency)
                    } label: {
                        AdsGroupRow(group: g, currency: currency, chevron: true)
                    }
                    .buttonStyle(.plain)
                } else {
                    AdsGroupRow(group: g, currency: currency, chevron: false)
                }
                if g.id != groups.last?.id { Divider() }
            }
        }
        .card()
    }

    private var next: AdsGroup.Level? {
        switch level {
        case .campaign: .adGroup
        case .adGroup: .keyword
        case .keyword: nil
        }
    }

    private var icon: String {
        switch level {
        case .campaign: "megaphone"
        case .adGroup: "rectangle.3.group"
        case .keyword: "textformat.abc"
        }
    }
}

private struct AdsGroupRow: View {
    var group: AdsGroup
    var currency: String
    var chevron: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(group.label)
                    .font(group.unnamed ? .subheadline.weight(.semibold).monospacedDigit() : .subheadline.weight(.semibold))
                    .lineLimit(2)
                if group.test { TestBadge() }
                Spacer(minLength: 4)
                if chevron {
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
            }
            AdsMetricsGrid(group: group, currency: currency)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}

/// A campaign (its ad groups) or an ad group (its keywords).
private struct AdsLevelView: View {
    var group: AdsGroup
    var level: AdsGroup.Level
    var currency: String

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                AdsTotalsCard(group: group, currency: currency)
                AdsGroupList(title: level == .adGroup ? "Ad groups" : "Keywords", rows: group.rows, level: level, currency: currency)
            }
            .padding(.horizontal)
            .padding(.bottom, 24)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(group.label)
        .navigationBarTitleDisplayMode(.inline)
    }
}

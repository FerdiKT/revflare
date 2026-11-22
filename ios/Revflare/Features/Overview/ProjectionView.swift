import Charts
import SwiftUI

/// Revenue projection (`GET /projection`, docs/projection.md): expected proceeds and MRR for the next 30 / 90 / 365
/// days from today's subscriptions, new subscribers and one-time purchases, with a 90% band, the backtest error,
/// upcoming long renewals and the renewal rates used. `appId` nil: the overview's app filter.
struct ProjectionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.redactionReasons) private var redaction
    var appId: String?
    @State private var loader = Loader<Projection>()
    @State private var horizon = 90
    @State private var withNew = true
    @State private var showAllSegments = false

    /// A backtest error above this marks the projection as rough (same as the web app).
    private static let rough = 0.15

    private var apps: Set<String> { appId.map { [$0] } ?? model.overviewApps }

    var body: some View {
        List {
            if let error = loader.error, loader.value == nil {
                ErrorBanner(message: error) { Task { await load() } }.listRowBackground(Color.clear)
            }
            if let p = loader.value {
                controls
                headline(p)
                chartSection(p)
                mrrSection(p)
                backtestSection(p)
                if p.apps.count > 1 { appsSection(p) }
                upcomingSection(p)
                segmentsSection(p)
                notesSection(p)
            } else if loader.loading {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("Projection")
        .refreshable { await load() }
        .task(id: TaskKey(version: model.dataVersion, apps: apps)) { await load() }
    }

    private struct TaskKey: Equatable {
        var version: Int
        var apps: Set<String>
    }

    private func load() async {
        guard let client = model.client else { return }
        let apps = apps
        loader.use(cacheKey: ResponseCache.key("projection", appsParam(apps) ?? "all"))
        await loader.load { try await client.projection(apps: apps) }
    }

    // MARK: Sections

    private var controls: some View {
        Section {
            Picker("Horizon", selection: $horizon) {
                Text("30 days").tag(30)
                Text("90 days").tag(90)
                Text("365 days").tag(365)
            }
            .pickerStyle(.segmented)
            Picker("View", selection: $withNew) {
                Text("With new subscribers").tag(true)
                Text("Existing only").tag(false)
            }
            .pickerStyle(.segmented)
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
    }

    private func headline(_ p: Projection) -> some View {
        let t = p.totals[horizon]
        let band = withNew ? t.withNew : t.existing
        let mrr = withNew ? t.mrrWithNew : t.mrr
        let err = withNew ? p.backtestError.withNew : p.backtestError.existing
        return Section {
            VStack(alignment: .leading, spacing: 4) {
                Text("Expected proceeds, next \(horizon) days").font(.footnote).foregroundStyle(.secondary)
                MoneyText(value: band.expected, currency: p.currency).font(.largeTitle.bold())
                (Text("90% band") + Text(verbatim: " \(money(band.low, p.currency)) – \(money(band.high, p.currency))"))
                    .font(.caption).foregroundStyle(.secondary).privacySensitive()
                Text("After refunds and store commission · gross \(money(withNew ? t.withNewGross : t.existingGross, p.currency))")
                    .font(.caption2).foregroundStyle(.tertiary).privacySensitive()
            }
            .padding(.vertical, 4)
            LabeledContent {
                VStack(alignment: .trailing) {
                    MoneyText(value: mrr.expected, currency: p.currency).font(.body.weight(.semibold))
                    Text("now \(money(p.summary.mrrNow, p.currency))").font(.caption).foregroundStyle(.secondary).privacySensitive()
                }
            } label: {
                Label("MRR in \(horizon) days", systemImage: "chart.line.uptrend.xyaxis")
            }
            if withNew {
                LabeledContent {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("Renewals \(money(t.components.renewals, p.currency))")
                        Text("New subscribers \(money(t.components.newSubscribers, p.currency))")
                        Text("One-time \(money(t.components.oneTime, p.currency))")
                    }
                    .font(.caption).foregroundStyle(.secondary).monospacedDigit().privacySensitive()
                } label: {
                    Label("Breakdown", systemImage: "square.stack.3d.up")
                }
            }
            LabeledContent {
                VStack(alignment: .trailing) {
                    Text(err.map { "±" + Fmt.percent($0) } ?? "—")
                        .font(.body.weight(.semibold)).monospacedDigit()
                        .foregroundStyle((err ?? 0) > Self.rough ? .orange : .primary)
                    if (err ?? 0) > Self.rough {
                        Text("Rough: small or changing volume").font(.caption).foregroundStyle(.orange)
                    }
                }
            } label: {
                Label("Backtest error", systemImage: "checkmark.seal")
            }
        }
    }

    private struct Bar: Identifiable {
        var date: Date
        var kind: String
        var value: Double
        var id: String { "\(date.timeIntervalSince1970):\(kind)" }
    }

    private func points(_ p: Projection) -> (week: Bool, items: [Projection.Point]) {
        horizon > 30 ? (true, Array(p.weekly.prefix(Int((Double(horizon) / 7).rounded(.up))))) : (false, Array(p.daily.prefix(horizon)))
    }

    private func chartSection(_ p: Projection) -> some View {
        let (week, pts) = points(p)
        let renewals = String(localized: "Renewals")
        let newSubs = String(localized: "New subscribers")
        let oneTime = String(localized: "One-time")
        var bars: [Bar] = []
        for x in pts {
            guard let d = Fmt.day(x.date) else { continue }
            bars.append(Bar(date: d, kind: renewals, value: x.renewals.expected))
            if withNew {
                bars.append(Bar(date: d, kind: newSubs, value: x.newSubscribers))
                bars.append(Bar(date: d, kind: oneTime, value: x.oneTime))
            }
        }
        let unit: Calendar.Component = week ? .weekOfYear : .day
        return Section {
            Chart {
                ForEach(bars) { b in
                    BarMark(x: .value("Date", b.date, unit: unit), y: .value("Proceeds", b.value))
                        .foregroundStyle(by: .value("Kind", b.kind))
                }
                ForEach(pts, id: \.date) { x in
                    if let d = Fmt.day(x.date) {
                        let band = withNew ? x.total : x.renewals
                        RuleMark(x: .value("Date", d, unit: unit), yStart: .value("Low", band.low), yEnd: .value("High", band.high))
                            .foregroundStyle(.secondary.opacity(0.7))
                            .lineStyle(StrokeStyle(lineWidth: 1))
                    }
                }
            }
            .chartForegroundStyleScale([renewals: Color.brand, newSubs: Color.blue, oneTime: Color.green])
            .chartYAxis { PrivacyAwareYAxis(currency: p.currency, format: "money", hide: redaction.contains(.privacy)) }
            .frame(height: 220)
            .padding(.vertical, 8)
        } header: {
            if week { Text("Expected proceeds per week") } else { Text("Expected proceeds per day") }
        } footer: {
            Text("Line: 90% band of the total.")
        }
    }

    private func mrrSection(_ p: Projection) -> some View {
        let (_, pts) = points(p)
        let rows = pts.compactMap { x in Fmt.day(x.date).map { (date: $0, band: withNew ? x.mrrWithNew : x.mrr, other: withNew ? x.mrr.expected : x.mrrWithNew.expected) } }
        return Section {
            Chart {
                ForEach(rows, id: \.date) { r in
                    AreaMark(x: .value("Date", r.date), yStart: .value("Low", r.band.low), yEnd: .value("High", r.band.high))
                        .foregroundStyle(Color.brand.opacity(0.15))
                    LineMark(x: .value("Date", r.date), y: .value("MRR", r.band.expected), series: .value("Series", "main"))
                        .foregroundStyle(Color.brand)
                    LineMark(x: .value("Date", r.date), y: .value("MRR", r.other), series: .value("Series", "other"))
                        .foregroundStyle(.secondary)
                        .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                }
            }
            .chartYAxis { PrivacyAwareYAxis(currency: p.currency, format: "money", hide: redaction.contains(.privacy)) }
            .frame(height: 180)
            .padding(.vertical, 8)
        } header: {
            Text("MRR")
        } footer: {
            if withNew {
                Text("Solid: with new subscribers (shaded: 90% band). Dashed: today's subscriptions only.")
            } else {
                Text("Solid: today's subscriptions only (shaded: 90% band). Dashed: with new subscribers.")
            }
        }
    }

    private func backtestSection(_ p: Projection) -> some View {
        Section {
            if p.backtest.isEmpty {
                Text("Not enough history to replay the model yet.").foregroundStyle(.secondary)
            }
            ForEach(p.backtest) { b in
                let side = withNew ? b.withNew : b.existing
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Model run on \(b.asOf)").font(.subheadline)
                        Text("Predicted \(money(side.predicted.expected, p.currency)) · actual \(money(side.actual, p.currency))")
                            .font(.caption).foregroundStyle(.secondary).privacySensitive()
                    }
                    Spacer()
                    Text(side.error.map(signed) ?? "—")
                        .monospacedDigit().fontWeight(.semibold)
                        .foregroundStyle(abs(side.error ?? 0) > Self.rough ? .orange : .primary)
                    Image(systemName: side.inBand ? "checkmark.circle" : "exclamationmark.triangle")
                        .foregroundStyle(side.inBand ? .green : .orange)
                        .accessibilityLabel(side.inBand ? Text("Inside the band") : Text("Outside the band"))
                }
            }
        } header: {
            Text("Backtest")
        } footer: {
            Text("The same model run as of an earlier day, with only what was known then, against what really came in since.")
        }
    }

    private func appsSection(_ p: Projection) -> some View {
        Section("Per app") {
            ForEach(p.apps.prefix(15)) { a in
                let b = withNew ? a.totals[horizon].withNew : a.totals[horizon].existing
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(a.name).lineLimit(1)
                        Text("MRR \(money(a.mrrNow, p.currency))").font(.caption).foregroundStyle(.secondary).privacySensitive()
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        MoneyText(value: b.expected, currency: p.currency).font(.subheadline.weight(.semibold))
                        Text(verbatim: "\(money(b.low, p.currency)) – \(money(b.high, p.currency))").font(.caption2).foregroundStyle(.secondary).privacySensitive()
                    }
                }
            }
        }
    }

    private func upcomingSection(_ p: Projection) -> some View {
        Section {
            if p.upcoming.items.isEmpty {
                Text("No renewals of 6 months or more in the next 90 days.").foregroundStyle(.secondary)
            }
            ForEach(Array(p.upcoming.items.prefix(15).enumerated()), id: \.offset) { _, u in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Date(timeIntervalSince1970: u.date / 1000).formatted(.dateTime.day().month())).font(.subheadline)
                        Text(verbatim: "\(u.appName ?? u.appId) · \(Self.stage(u.stage))").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        MoneyText(value: u.price, currency: p.currency).font(.subheadline)
                        Text(verbatim: "\(Fmt.percent(u.probability)) · \(Self.status(u.status))")
                            .font(.caption2).foregroundStyle(u.status == "on" ? Color.secondary : Color.orange)
                    }
                }
            }
        } header: {
            Text("Upcoming long renewals")
        } footer: {
            if p.upcoming.count > 0 {
                Text("\(p.upcoming.count) in the next 90 days: \(money(p.upcoming.price, p.currency)) full price, \(money(p.upcoming.expectedProceeds, p.currency)) expected proceeds.")
            }
        }
    }

    private func segmentsSection(_ p: Projection) -> some View {
        let order = ["trial", "intro", "r1", "r2", "r3"]
        let rows = p.segments.sorted {
            ($0.appName ?? "", $0.period, order.firstIndex(of: $0.stage) ?? 9) < ($1.appName ?? "", $1.period, order.firstIndex(of: $1.stage) ?? 9)
        }
        let shown = showAllSegments ? rows : Array(rows.prefix(12))
        return Section {
            ForEach(shown) { s in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: "\(Fmt.period(s.period) ?? s.period) · \(Self.stage(s.stage))").font(.subheadline)
                        (Text(verbatim: appId == nil ? "\(s.appName ?? s.appId) · " : "") + Text("\(s.renewed) of \(s.observed) renewed"))
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(Fmt.percent(s.rate)).monospacedDigit().fontWeight(.semibold)
                        Text(verbatim: "\(Fmt.percent(s.low)) – \(Fmt.percent(s.high))").font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                    }
                    if s.lowData {
                        Image(systemName: "exclamationmark.circle").foregroundStyle(.orange)
                            .accessibilityLabel(Text("Low data: leans on the portfolio"))
                    }
                }
            }
            if rows.count > 12 {
                Button {
                    showAllSegments.toggle()
                } label: {
                    if showAllSegments { Text("Show fewer") } else { Text("Show all \(rows.count)") }
                }
            }
        } header: {
            Text("Renewal rates used")
        } footer: {
            Text("Per billing period and stage. Orange: fewer than 30 renewals, the rate leans on the portfolio average (wider interval).")
        }
    }

    private func notesSection(_ p: Projection) -> some View {
        Section {
            let i = p.inputs
            Text("\(i.activeSubscriptions) active subscriptions: \(i.trials) in trial, \(i.autoRenewOff) with auto-renew off, \(i.billingRetry) in billing retry.")
            Text("New subscribers: \(String(format: "%.1f", i.newStartsPerDay)) a day; one-time purchases: \(money(i.oneTimePerDay, p.currency)) a day (last 28 days).")
            Text("Computed once a day · \(Date(timeIntervalSince1970: p.generatedAt / 1000).formatted(.dateTime.day().month().hour().minute()))")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    // MARK: Helpers

    private func money(_ v: Double, _ currency: String) -> String {
        Fmt.money(v, currency, compact: abs(v) >= 10_000, hide: redaction.contains(.privacy))
    }

    private func signed(_ x: Double) -> String { (x >= 0 ? "+" : "−") + Fmt.percent(abs(x)) }

    static func stage(_ s: String) -> String {
        switch s {
        case "trial": String(localized: "Trial → paid")
        case "intro": String(localized: "Intro → full price")
        case "r1": String(localized: "1st renewal")
        case "r2": String(localized: "2nd renewal")
        case "r3": String(localized: "3rd+ renewal")
        default: s
        }
    }

    static func status(_ s: String) -> String {
        switch s {
        case "on": String(localized: "Auto-renew")
        case "off": String(localized: "Auto-renew off")
        case "retry": String(localized: "Billing retry")
        case "grace": String(localized: "Grace period")
        default: s
        }
    }
}

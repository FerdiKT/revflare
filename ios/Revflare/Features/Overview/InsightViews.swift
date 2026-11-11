import Charts
import SwiftUI

/// Revenue at risk: billing retry, grace period, auto-renew off (`GET /at-risk`).
struct AtRiskView: View {
    @Environment(AppModel.self) private var model
    @State private var loader = Loader<AtRisk>()

    var body: some View {
        List {
            if let error = loader.error, loader.value == nil {
                ErrorBanner(message: error) { Task { await load() } }.listRowBackground(Color.clear)
            }
            if let r = loader.value {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("MRR that will not renew unless something changes").font(.footnote).foregroundStyle(.secondary)
                        MoneyText(value: r.mrr, currency: r.currency).font(.largeTitle.bold())
                    }
                    .padding(.vertical, 4)
                    ForEach(r.groups) { g in
                        HStack {
                            Label(Self.reason(g.reason, fallback: g.label), systemImage: Self.icon(g.reason))
                            Spacer()
                            VStack(alignment: .trailing) {
                                MoneyText(value: g.mrr, currency: r.currency).font(.subheadline.weight(.semibold))
                                Text("\(g.subscriptions) subscriptions").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                Section("Subscriptions") {
                    if r.items.isEmpty {
                        Text("Nothing at risk right now.").foregroundStyle(.secondary)
                    }
                    ForEach(r.items) { s in
                        NavigationLink(value: s.customerId.map { Route.customer(id: $0) } ?? Route.app(id: s.appId, name: s.appName)) {
                            SubscriptionRow(subscription: s, currency: r.currency, showApp: true)
                        }
                    }
                }
            } else if loader.loading {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("Revenue at risk")
        .refreshable { await load() }
        .task(id: model.dataVersion) { await load() }
    }

    private func load() async {
        guard let client = model.client else { return }
        loader.use(cacheKey: ResponseCache.key("at-risk"))
        await loader.load { try await client.atRisk() }
    }

    static func reason(_ r: String, fallback: String) -> String {
        switch r {
        case "billing_retry": String(localized: "Billing retry")
        case "grace": String(localized: "Grace period")
        case "cancelled": String(localized: "Auto-renew off")
        default: fallback
        }
    }

    static func icon(_ r: String) -> String {
        switch r {
        case "billing_retry": "creditcard.trianglebadge.exclamationmark"
        case "grace": "clock.badge.exclamationmark"
        default: "xmark.circle"
        }
    }
}

/// Expected renewals over the next 30 days (`GET /forecast`).
struct ForecastView: View {
    @Environment(AppModel.self) private var model
    @State private var loader = Loader<Forecast>()
    @State private var selected: Date?
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        List {
            if let error = loader.error, loader.value == nil {
                ErrorBanner(message: error) { Task { await load() } }.listRowBackground(Color.clear)
            }
            if let f = loader.value {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Expected from renewals in the next \(f.days) days").font(.footnote).foregroundStyle(.secondary)
                        MoneyText(value: f.expected, currency: f.currency).font(.largeTitle.bold())
                    }
                    .padding(.vertical, 4)
                    chart(f).frame(height: 220).padding(.vertical, 8)
                }
                if !f.renewalRates.isEmpty {
                    Section("Renewal rates used") {
                        ForEach(f.renewalRates.sorted { $0.key < $1.key }, id: \.key) { period, rate in
                            HStack {
                                Text(Fmt.period(period) ?? period)
                                Spacer()
                                Text(Fmt.percent(rate)).monospacedDigit().foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            } else if loader.loading {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("Forecast")
        .refreshable { await load() }
        .task(id: model.dataVersion) { await load() }
    }

    @ViewBuilder
    private func chart(_ f: Forecast) -> some View {
        let points = f.points.compactMap { p in Fmt.day(p.date).map { (date: $0, due: p.due, expected: p.expected) } }
        Chart {
            ForEach(points, id: \.date) { p in
                BarMark(x: .value("Day", p.date, unit: .day), y: .value("Due", p.due))
                    .foregroundStyle(Color.brand.opacity(0.25))
                BarMark(x: .value("Day", p.date, unit: .day), y: .value("Expected", p.expected))
                    .foregroundStyle(Color.brand)
            }
            if let selected, let p = points.first(where: { Calendar.current.isDate($0.date, inSameDayAs: selected) }) {
                RuleMark(x: .value("Day", p.date, unit: .day))
                    .foregroundStyle(.secondary)
                    .annotation(position: .top, overflowResolution: .init(x: .fit, y: .disabled)) {
                        VStack(alignment: .leading) {
                            Text(p.date.formatted(.dateTime.day().month())).font(.caption2).foregroundStyle(.secondary)
                            MoneyText(value: p.expected, currency: f.currency).font(.caption.bold())
                        }
                        .padding(6)
                        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 8))
                    }
            }
        }
        .chartXSelection(value: $selected)
        .chartYAxis { PrivacyAwareYAxis(currency: f.currency, format: "money", hide: redaction.contains(.privacy)) }
    }

    private func load() async {
        guard let client = model.client else { return }
        loader.use(cacheKey: ResponseCache.key("forecast"))
        await loader.load { try await client.forecast() }
    }
}

private func axisLabel(_ v: Double, format: String, currency: String) -> String {
    if format == "money" && abs(v) < 100_000 { return v.formatted(.currency(code: currency).precision(.fractionLength(0))) }
    return Fmt.value(v, format: format, currency: currency, compact: true)
}

/// Y axis labels that privacy mode hides.
func PrivacyAwareYAxis(currency: String, format: String, hide: Bool) -> some AxisContent {
    AxisMarks(position: .trailing) { value in
        AxisGridLine()
        AxisValueLabel {
            if let v = value.as(Double.self) {
                Text(format == "money" && hide ? "" : axisLabel(v, format: format, currency: currency))
            }
        }
    }
}


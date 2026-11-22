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


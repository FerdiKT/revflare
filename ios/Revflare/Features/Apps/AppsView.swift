import SwiftUI

struct AppsView: View {
    @Environment(AppModel.self) private var model
    @Environment(PushManager.self) private var push
    @State private var loader = Loader<AppList>()
    @State private var search = ""
    @AppStorage("apps.sort") private var sort = "revenue"
    @AppStorage("apps.showArchived") private var showArchived = false

    var body: some View {
        List {
            if let error = loader.error, loader.value == nil {
                ErrorBanner(message: error) { Task { await load() } }.listRowBackground(Color.clear)
            }
            if let list = loader.value {
                if search.isEmpty {
                    Section {
                        summary(list)
                    }
                }
                Section {
                    let showStore = list.items.contains { $0.isAndroid }
                    ForEach(sorted(list.items)) { app in
                        NavigationLink(value: Route.app(id: app.id, name: app.name)) {
                            AppRow(app: app, currency: list.currency, sort: sort, muted: push.device?.prefs.isMuted(app.id) == true, showStore: showStore)
                        }
                        .swipeActions(edge: .leading) { muteButton(app) }
                        .contextMenu { muteButton(app) }
                    }
                }
            }
        }
        .overlay {
            if loader.value == nil && loader.loading { ProgressView() }
            else if let list = loader.value, list.items.isEmpty {
                ContentUnavailableView("No apps yet", systemImage: "square.grid.2x2", description: Text("Add your apps in the Revflare web app (Apps → Import from App Store Connect)."))
            }
        }
        .searchable(text: $search, prompt: Text("Search apps"))
        .navigationTitle("Apps")
        .toolbarTitleDisplayMode(.inlineLarge)
        .toolbar {
            Menu {
                Picker("Sort by", selection: $sort) {
                    Label("Revenue (28 days)", systemImage: "dollarsign").tag("revenue")
                    Label("MRR", systemImage: "arrow.triangle.2.circlepath").tag("mrr")
                    Label("Active subscriptions", systemImage: "person.2").tag("subs")
                    Label("Name", systemImage: "textformat").tag("name")
                }
                Toggle("Show archived", isOn: $showArchived)
            } label: {
                Image(systemName: "arrow.up.arrow.down")
            }
            .accessibilityLabel(Text("Sort"))
        }
        .refreshable { await load() }
        .task(id: model.dataVersion) { await load() }
    }

    /// Mutes / unmutes the app's notifications on this device (only once the device is registered for push).
    @ViewBuilder
    private func muteButton(_ app: RFApp) -> some View {
        if let prefs = push.device?.prefs {
            let muted = prefs.isMuted(app.id)
            Button {
                Task { await push.setMuted(!muted, app: app.id) }
            } label: {
                Label(muted ? LocalizedStringKey("Unmute notifications") : "Mute notifications", systemImage: muted ? "bell" : "bell.slash")
            }
            .tint(muted ? .accentColor : .orange)
        }
    }

    private func summary(_ list: AppList) -> some View {
        let live = list.items.filter { !$0.archived }
        return HStack(spacing: 0) {
            stat("Apps") { Text(Fmt.count(live.count)) }
            stat("MRR") { MoneyText(value: live.reduce(0) { $0 + $1.mrr }, currency: list.currency, compact: true) }
            stat("28 days") { MoneyText(value: live.reduce(0) { $0 + $1.revenue28d }, currency: list.currency, compact: true) }
        }
        .padding(.vertical, 4)
    }

    private func stat<V: View>(_ title: LocalizedStringKey, @ViewBuilder value: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            value().font(.title3.weight(.bold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func sorted(_ items: [RFApp]) -> [RFApp] {
        var apps = items.filter { showArchived || !$0.archived }
        if !search.isEmpty {
            apps = apps.filter { $0.name.localizedCaseInsensitiveContains(search) || ($0.bundleId ?? "").localizedCaseInsensitiveContains(search) }
        }
        switch sort {
        case "mrr": apps.sort { $0.mrr > $1.mrr }
        case "subs": apps.sort { $0.activeSubscriptions > $1.activeSubscriptions }
        case "name": apps.sort { $0.name.localizedCompare($1.name) == .orderedAscending }
        default: apps.sort { $0.revenue28d > $1.revenue28d }
        }
        return apps
    }

    private func load() async {
        guard let client = model.client else { return }
        loader.use(cacheKey: ResponseCache.key("apps-list"))
        await loader.load { try await client.apps() }
        if loader.value != nil { await model.refreshApps() }
    }
}

private struct AppRow: View {
    var app: RFApp
    var currency: String
    var sort: String
    var muted = false
    /// App Store / Google Play capsule (workspaces with Android apps).
    var showStore = false

    var body: some View {
        HStack(spacing: 12) {
            AppIconView(url: app.iconUrl, name: app.name, size: 44)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(app.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                    if showStore { StoreBadge(android: app.isAndroid) }
                    if !app.isAndroid, app.storeAvailable == false {
                        Text("Unreleased").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                            .padding(.horizontal, 5).padding(.vertical, 1).background(.quaternary, in: Capsule())
                    }
                    if app.archived { Image(systemName: "archivebox").font(.caption2).foregroundStyle(.secondary) }
                    if muted {
                        Image(systemName: "bell.slash.fill").font(.caption2).foregroundStyle(.secondary)
                            .accessibilityLabel(Text("Muted"))
                    }
                }
                HStack(spacing: 10) {
                    HStack(spacing: 3) {
                        Text("MRR")
                        MoneyText(value: app.mrr, currency: currency, compact: true)
                    }
                    HStack(spacing: 2) {
                        Image(systemName: "person.2.fill")
                        Text(Fmt.count(Double(app.activeSubscriptions), compact: true))
                    }
                    if app.activeTrials > 0 {
                        HStack(spacing: 2) {
                            Image(systemName: "hourglass")
                            Text(Fmt.count(Double(app.activeTrials), compact: true))
                        }
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 2) {
                MoneyText(value: app.revenue28d, currency: currency, compact: true).font(.subheadline.weight(.semibold))
                Text("28 days").font(.caption2).foregroundStyle(.secondary)
            }
            .fixedSize()
        }
        .accessibilityElement(children: .combine)
    }
}

/// One app: the same dashboard filtered with `apps=<id>`, its revenue chart, products and setup status.
struct AppDetailView: View {
    @Environment(AppModel.self) private var model
    var appId: String
    var initialName: String
    @State private var overview = Loader<Overview>()
    @State private var chart = Loader<MetricChart>()
    @State private var detail = Loader<AppDetail>()
    @State private var analytics = Loader<AnalyticsStatus>()
    @State private var recent: [Transaction] = []
    @State private var recentCurrency: String?
    @AppStorage("appDetail.metric") private var metric = "revenue"

    private var app: RFApp? { detail.value?.app ?? model.app(appId) }
    private var name: String { app?.name ?? (initialName.isEmpty ? String(localized: "App") : initialName) }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                header
                if let error = overview.error, overview.value == nil {
                    ErrorBanner(message: error) { Task { await load() } }
                }
                Picker("Metric", selection: $metric) {
                    Text("Revenue").tag("revenue")
                    Text("MRR").tag("mrr")
                    Text("Subscriptions").tag("active_subscriptions")
                    Text("Trials").tag("trials_started")
                }
                .pickerStyle(.segmented)
                if let c = chart.value {
                    MetricChartCard(chart: c, info: MetricInfo.info(c.metric), loading: chart.loading, height: 200)
                }
                if let o = overview.value {
                    OverviewContent(overview: o, scopedToApp: appId, updatedAt: overview.updatedAt, offline: overview.offline)
                } else if overview.error == nil {
                    OverviewSkeleton()
                }
                if !recent.isEmpty { recentCard }
                if let app, !app.isAndroid { acquisitionCard }
                if let status = analytics.value { analyticsCard(status) }
                if let d = detail.value, !d.products.isEmpty { productsCard(d.products) }
                if let app { setupCard(app) }
            }
            .padding(.horizontal)
            .padding(.bottom, 24)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { GrossNetToggle() }
        .refreshable { await load() }
        .task(id: model.dataVersion) { await load() }
        .task(id: metric) { await loadChart() }
    }

    private var header: some View {
        HStack(spacing: 14) {
            AppIconView(url: app?.iconUrl, name: name, size: 64)
            VStack(alignment: .leading, spacing: 3) {
                Text(name).font(.title2.bold()).lineLimit(2)
                if let b = app?.bundleId { Text(b).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1) }
                if let app {
                    if app.isAndroid {
                        Text("Google Play fee \(Int(app.commissionPct))%").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("Apple commission \(Int(app.commissionPct))%").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer()
        }
        .padding(.top, 4)
    }

    private var recentCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Recent transactions", systemImage: "list.bullet.rectangle")
            ForEach(recent) { tx in
                NavigationLink(value: tx.customerId.map { Route.customer(id: $0) } ?? Route.transaction(tx, currency: recentCurrency ?? model.currency)) {
                    TransactionRow(transaction: tx, currency: recentCurrency ?? model.currency, showApp: false).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if tx.id != recent.last?.id { Divider() }
            }
        }
        .card()
    }

    /// RevflareKit events and funnels (read-only; funnels are edited in the web panel).
    private func analyticsCard(_ status: AnalyticsStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Analytics", systemImage: "chart.bar.xaxis")
            NavigationLink(value: Route.events(appId: appId)) {
                AnalyticsLinkRow(title: "Events", systemImage: "waveform.path.ecg", subtitle: eventsSubtitle(status))
            }
            .buttonStyle(.plain)
            Divider()
            NavigationLink(value: Route.funnels(appId: appId)) {
                AnalyticsLinkRow(title: "Funnels", systemImage: "line.3.horizontal.decrease", subtitle: String(localized: "Step-by-step conversion"))
            }
            .buttonStyle(.plain)
        }
        .card()
    }

    /// Apple Ads attributed revenue (RevflareKit installs Apple attributed to Apple Ads).
    private var acquisitionCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Acquisition", systemImage: "person.crop.circle.badge.plus")
            NavigationLink(value: Route.appleAds(appId: appId)) {
                AnalyticsLinkRow(title: "Apple Ads", systemImage: "megaphone", subtitle: String(localized: "Revenue per campaign, ad group and keyword"))
            }
            .buttonStyle(.plain)
        }
        .card()
    }

    private func eventsSubtitle(_ status: AnalyticsStatus) -> String {
        if !status.configured { return String(localized: "Not set up on the server") }
        guard let at = status.lastEventAt else { return String(localized: "No events yet") }
        return String(localized: "Last event \(Fmt.relative(ms: at))")
    }

    private func productsCard(_ products: [Product]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Products", systemImage: "shippingbox")
            ForEach(products) { p in
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(p.name ?? p.productId).font(.subheadline)
                        Text(p.productId).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    if let period = Fmt.period(p.period) {
                        Text(period).font(.caption).foregroundStyle(.secondary)
                    } else if p.type?.lowercased().contains("non") == true || p.type?.lowercased().contains("consumable") == true {
                        Text("One-time").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .card()
    }

    @ViewBuilder
    private func setupCard(_ app: RFApp) -> some View {
        if app.isAndroid {
            googlePlaySetupCard(app)
        } else {
            appStoreSetupCard(app)
        }
    }

    private func appStoreSetupCard(_ app: RFApp) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Setup", systemImage: "antenna.radiowaves.left.and.right")
            HStack {
                Text("Apple notifications")
                Spacer()
                notificationStatus(app.notificationUrlStatus)
            }
            if let at = app.lastNotificationAt {
                HStack {
                    Text("Last notification")
                    Spacer()
                    Text(Fmt.relative(ms: at)).foregroundStyle(.secondary)
                }
            }
            if let at = app.lastHistorySyncAt {
                HStack {
                    Text("Last history sync")
                    Spacer()
                    Text(Fmt.relative(ms: at)).foregroundStyle(.secondary)
                }
            }
            if app.storeAvailable == false {
                Label("Not on the App Store yet", systemImage: "info.circle").foregroundStyle(.secondary)
            }
        }
        .font(.subheadline)
        .card()
    }

    /// Android: Google Play real-time developer notifications and the service account (set up in the web app).
    private func googlePlaySetupCard(_ app: RFApp) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Setup", systemImage: "antenna.radiowaves.left.and.right")
            HStack {
                Text("Store")
                Spacer()
                Text("Google Play").foregroundStyle(.secondary)
            }
            if let package = app.bundleId {
                HStack {
                    Text("Package name")
                    Spacer()
                    Text(package).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).textSelection(.enabled)
                }
            }
            HStack {
                Text("Service account")
                Spacer()
                if app.googlePlay?.configured == true {
                    Label("Set up", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                } else {
                    Label("Not set", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
            }
            HStack {
                Text("Real-time notifications")
                Spacer()
                if app.lastNotificationAt != nil {
                    Label("Receiving", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                } else {
                    Label("None yet", systemImage: "questionmark.circle").foregroundStyle(.secondary)
                }
            }
            HStack {
                Text("Push authentication")
                Spacer()
                if app.googlePlay?.pushAuth == true {
                    Label("On", systemImage: "lock.fill").foregroundStyle(.green)
                } else {
                    Label("Off", systemImage: "lock.open").foregroundStyle(.secondary)
                }
            }
            if let at = app.lastNotificationAt {
                HStack {
                    Text("Last notification")
                    Spacer()
                    Text(Fmt.relative(ms: at)).foregroundStyle(.secondary)
                }
            }
            if let check = app.googlePlay?.lastCheck {
                HStack(alignment: .firstTextBaseline) {
                    Text("Last check")
                    Spacer()
                    if check.ok {
                        Label(Fmt.relative(ms: check.at), systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    } else {
                        Label(Fmt.relative(ms: check.at), systemImage: "xmark.octagon.fill").foregroundStyle(.red)
                    }
                }
                if !check.ok, let error = check.error, !error.isEmpty {
                    Text(error).font(.caption).foregroundStyle(.red).lineLimit(3)
                }
            }
        }
        .font(.subheadline)
        .card()
    }

    @ViewBuilder
    private func notificationStatus(_ status: String) -> some View {
        switch status {
        case "revflare": Label("Revflare", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        case "other": Label("Polled (other URL)", systemImage: "arrow.triangle.2.circlepath").foregroundStyle(.blue)
        case "none": Label("Not set", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        default: Label("Unknown", systemImage: "questionmark.circle").foregroundStyle(.secondary)
        }
    }

    private func load() async {
        guard let client = model.client else { return }
        overview.use(cacheKey: ResponseCache.key("overview", appId))
        detail.use(cacheKey: ResponseCache.key("app", appId))
        async let a: Void = overview.load { try await client.overview(apps: [appId]) }
        async let b: Void = detail.load { try await client.app(appId) }
        async let c: Void = loadChart()
        async let e: Void = loadAnalytics()
        async let d = try? client.transactions(limit: 8, apps: [appId])
        _ = await (a, b, c, e)
        if let page = await d {
            recent = page.items
            recentCurrency = page.currency
        }
        if let o = overview.value { WidgetData.store(o, appId: appId, appName: name) }
    }

    /// Older servers have no analytics endpoint: the card stays hidden then.
    private func loadAnalytics() async {
        guard let client = model.client else { return }
        analytics.use(cacheKey: ResponseCache.key("analytics-status", appId))
        await analytics.load { try await client.analyticsStatus(app: appId) }
    }

    private func loadChart() async {
        guard let client = model.client else { return }
        chart.use(cacheKey: ResponseCache.key("app-chart", appId, metric))
        await chart.load { try await client.chart(metric, range: metric == "mrr" || metric == "active_subscriptions" ? "90d" : "28d", interval: nil, groupBy: nil, apps: [appId]) }
    }
}

private struct AnalyticsLinkRow: View {
    var title: LocalizedStringKey
    var systemImage: String
    var subtitle: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.brand)
                .frame(width: 28, height: 28)
                .background(Color.brand.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.subheadline)
                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

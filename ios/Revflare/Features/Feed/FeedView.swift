import SwiftUI

/// Live transaction feed (`GET /transactions`, cursor pages) grouped by local day, polled while visible. Renewals Apple
/// announced ahead of their period (`upcoming=true`) are listed apart and never counted.
struct FeedView: View {
    @Environment(AppModel.self) private var model
    @State private var items: [Transaction] = []
    /// Day totals from the server (`days`, local days), by "YYYY-MM-DD": a day can span pages.
    @State private var days: [String: FeedDay] = [:]
    @State private var upcoming: [Transaction] = []
    @State private var upcomingCursor: String?
    @AppStorage("feedUpcomingExpanded") private var upcomingExpanded = false
    /// Currency of the amounts, from the response (`GET /transactions` → `currency`).
    @State private var currency: String?
    @State private var cursor: String?
    @State private var loading = false
    @State private var loadingMore = false
    /// Filtered pages in a row that matched nothing: past a few, loading older ones waits for a tap.
    @State private var emptyPages = 0
    @State private var error: String?
    @State private var filter = "all"
    /// Acquisition filter: "all" | "apple_ads" | "google_ads" | "referral" | "organic" | "unknown" (`source`).
    @State private var sourceFilter = "all"
    @State private var newIds = Set<String>()
    @State private var showAppFilter = false

    private static let filters: [(id: String, title: LocalizedStringKey)] = [
        ("all", "All"), ("sales", "Sales"), ("quick", "Within 5 min"), ("cancellations", "Cancellations"), ("new", "New"), ("renewal", "Renewals"), ("trial", "Trials"),
        ("conversion", "Conversions"), ("refunds", "Refunds"),
    ]

    static let sources: [(id: String, title: LocalizedStringKey)] = [
        ("all", "All sources"), ("apple_ads", "Apple Ads"), ("google_ads", "Google Ads"), ("referral", "Referral"), ("organic", "Organic"), ("unknown", "Unknown source"),
    ]

    var body: some View {
        @Bindable var model = model
        List {
            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Self.filters, id: \.id) { f in
                            Button {
                                filter = f.id
                            } label: {
                                HStack(spacing: 3) {
                                    if f.id == "quick" { Image(systemName: "bolt.fill").font(.caption) }
                                    Text(f.title)
                                }
                                .font(.subheadline.weight(filter == f.id ? .semibold : .regular))
                            }
                            .buttonStyle(filter == f.id ? AnyPrimitiveButtonStyle(.glassProminent) : AnyPrimitiveButtonStyle(.glass))
                        }
                        sourceMenu
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 2)
                }
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
            if let error, items.isEmpty {
                ErrorBanner(message: error) { Task { await reload() } }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            if !upcoming.isEmpty {
                upcomingSection
            }
            ForEach(groupedDays, id: \.key) { group in
                Section {
                    ForEach(group.items) { tx in
                        NavigationLink(value: route(tx)) {
                            TransactionRow(transaction: tx, currency: amountCurrency, isNew: newIds.contains(tx.id), net: model.showProceeds, showStore: model.hasAndroidApps)
                        }
                    }
                } header: {
                    FeedDayHeader(key: group.key, total: days[group.key], currency: amountCurrency, net: model.showProceeds, filter: filter)
                }
            }
            if cursor != nil {
                if emptyPages >= 5 && !loadingMore {
                    Button("Search older transactions") {
                        emptyPages = 0
                        Task { await loadMore() }
                    }
                    .font(.subheadline)
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                } else {
                    HStack { Spacer(); ProgressView(); Spacer() }
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        // Re-runs for each new cursor: filtered pages can be short (even empty) while the row stays visible.
                        .task(id: cursor) { await loadMore() }
                }
            }
            if items.isEmpty && !loading && cursor == nil && error == nil && model.quotaResetAt == nil && filter == "quick" {
                ContentUnavailableView("Nobody so far", systemImage: "bolt", description: Text("People who buy within 5 minutes of installing (RevflareKit) or cancel within 5 minutes of buying show up here."))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            } else if items.isEmpty && !loading && cursor == nil && error == nil && model.quotaResetAt == nil && filter == "cancellations" {
                ContentUnavailableView("No cancellations", systemImage: "bell.slash", description: Text("Subscriptions whose auto-renew is turned off show up here."))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            } else if items.isEmpty && !loading && cursor == nil && error == nil && model.quotaResetAt == nil && sourceFilter != "all" {
                ContentUnavailableView("No transactions from this source", systemImage: "megaphone", description: Text("Sources come from RevflareKit installs linked to purchases."))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            } else if items.isEmpty && !loading && error == nil && model.quotaResetAt == nil {
                ContentUnavailableView("No transactions yet", systemImage: "tray", description: Text("New sales appear here as Apple reports them."))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .navigationTitle(title)
        .toolbarTitleDisplayMode(.inlineLarge)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    showAppFilter = true
                } label: {
                    Image(systemName: model.feedApps.isEmpty ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
                }
                .accessibilityLabel(Text("Filter apps"))
                GrossNetToggle()
            }
        }
        .sheet(isPresented: $showAppFilter) {
            AppPickerSheet(title: "Filter apps", selection: $model.feedApps)
        }
        .overlay { if loading && items.isEmpty && upcoming.isEmpty { ProgressView() } }
        .refreshable { await reload() }
        .task(id: TaskKey(filter: filter, source: sourceFilter, apps: model.feedApps, version: model.dataVersion, ws: model.workspace?.id)) {
            await reload()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                if Task.isCancelled { break }
                await poll()
            }
        }
    }

    /// Source filter (All / Apple Ads / Organic / Unknown), after the kind chips.
    private var sourceMenu: some View {
        Menu {
            Picker("Source", selection: $sourceFilter) {
                ForEach(Self.sources, id: \.id) { s in Text(s.title).tag(s.id) }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "megaphone").font(.caption)
                Text(Self.sources.first { $0.id == sourceFilter }?.title ?? "All sources")
                    .font(.subheadline.weight(sourceFilter == "all" ? .regular : .semibold))
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
            }
        }
        .buttonStyle(sourceFilter == "all" ? AnyPrimitiveButtonStyle(.glass) : AnyPrimitiveButtonStyle(.glassProminent))
        .accessibilityLabel(Text("Source"))
    }

    // MARK: Upcoming

    @ViewBuilder private var upcomingSection: some View {
        Section {
            Button {
                withAnimation(.snappy) { upcomingExpanded.toggle() }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "clock.badge")
                        .font(.title3)
                        .foregroundStyle(.orange)
                        .frame(width: 40)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text("Upcoming").font(.subheadline.weight(.semibold)).foregroundStyle(Color(.label))
                            Text(upcomingCursor == nil ? "\(upcoming.count)" : "\(upcoming.count)+")
                                .font(.caption.weight(.semibold).monospacedDigit())
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                .background(Color.orange.opacity(0.15), in: Capsule())
                                .foregroundStyle(.orange)
                        }
                        Text("Not counted yet").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .accessibilityHidden(true)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(upcomingExpanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(Text("Renewals Apple announced before their period starts"))
            .listRowBackground(Color.orange.opacity(0.06))
            if upcomingExpanded {
                ForEach(upcoming) { tx in
                    NavigationLink(value: route(tx)) {
                        UpcomingRow(transaction: tx, currency: amountCurrency, net: model.showProceeds)
                    }
                    .listRowBackground(Color.orange.opacity(0.06))
                }
                if upcomingCursor != nil {
                    Button("Show more") { Task { await loadMoreUpcoming() } }
                        .font(.subheadline)
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.orange.opacity(0.06))
                }
            }
        }
    }

    // MARK: Data

    private struct TaskKey: Equatable {
        var filter: String
        var source: String
        var apps: Set<String>
        var version: Int
        var ws: String?
    }

    private struct DayGroup { var key: String; var items: [Transaction] }

    private static let dayKeyFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// Local day ("YYYY-MM-DD") of a transaction, as the server groups `days` with `tzOffset`.
    static func dayKey(_ ms: Double) -> String {
        dayKeyFormatter.timeZone = .current
        return dayKeyFormatter.string(from: Fmt.date(ms: ms))
    }

    private var groupedDays: [DayGroup] {
        var out: [DayGroup] = []
        for tx in items {
            let key = Self.dayKey(tx.purchasedAt)
            if out.last?.key == key { out[out.count - 1].items.append(tx) } else { out.append(DayGroup(key: key, items: [tx])) }
        }
        return out
    }

    private var title: String {
        if model.feedApps.count == 1, let id = model.feedApps.first, let name = model.appName(id) { return name }
        if model.feedApps.count > 1 { return String(localized: "\(model.feedApps.count) apps") }
        return String(localized: "Feed")
    }

    private func route(_ tx: Transaction) -> Route {
        tx.customerId.map { Route.customer(id: $0) } ?? Route.transaction(tx, currency: amountCurrency)
    }

    private var query: (kinds: [String], refunded: Bool, quick: Bool, cancellations: Bool) {
        switch filter {
        case "sales": (["new", "renewal", "one_time", "conversion"], false, false, false)
        case "refunds": ([], true, false, false)
        case "quick": ([], false, true, false)
        case "cancellations": ([], false, false, true)
        case "all": ([], false, false, false)
        default: ([filter], false, false, false)
        }
    }

    /// Quick rows and cancellations have nothing announced ahead.
    private var showsUpcoming: Bool { filter != "quick" && filter != "cancellations" }

    private var source: String? { sourceFilter == "all" ? nil : sourceFilter }
    private var appsKey: String { appsParam(model.feedApps) ?? "all" }
    private var cacheKey: String { ResponseCache.key("feed", filter, sourceFilter, appsKey) }
    private var upcomingCacheKey: String { ResponseCache.key("feed-upcoming", filter, sourceFilter, appsKey) }

    private var amountCurrency: String { currency ?? model.currency }

    private func mergeDays(_ list: [FeedDay]?) {
        for d in list ?? [] { days[d.date] = d }
    }

    private func reload() async {
        guard let client = model.client else { return }
        let apps = model.feedApps
        let q = query
        if items.isEmpty, let cached = ResponseCache.load(Page<Transaction>.self, key: cacheKey) {
            items = cached.items
            cursor = cached.nextCursor
            currency = cached.currency
            mergeDays(cached.days)
        }
        if upcoming.isEmpty, let cached = ResponseCache.load(Page<Transaction>.self, key: upcomingCacheKey) {
            upcoming = cached.items.filter { $0.purchasedAt > Date.now.timeIntervalSince1970 * 1000 }
            upcomingCursor = cached.nextCursor
        }
        loading = true
        defer { loading = false }
        do {
            let source = source
            let withUpcoming = showsUpcoming
            async let pastPage = client.transactions(limit: 50, kinds: q.kinds, refunded: q.refunded, source: source, apps: apps, quick: q.quick, cancellations: q.cancellations)
            async let upcomingPage = withUpcoming ? client.transactions(limit: 50, kinds: q.kinds, refunded: q.refunded, source: source, apps: apps, upcoming: true) : Page<Transaction>(items: [], nextCursor: nil)
            var page = try await pastPage
            // A source / quick filter can give short pages: fill the first screen (a few requests at most).
            var extra = 0
            while source != nil || q.quick, page.items.count < 20, let next = page.nextCursor, extra < 4 {
                extra += 1
                let more = try await client.transactions(limit: 50, cursor: next, kinds: q.kinds, refunded: q.refunded, source: source, apps: apps, quick: q.quick, cancellations: q.cancellations)
                page.items += more.items
                page.nextCursor = more.nextCursor
                page.days = (page.days ?? []) + (more.days ?? [])
            }
            let next = try? await upcomingPage
            withAnimation {
                items = page.items
                days = [:]
                mergeDays(page.days)
                if let next {
                    upcoming = next.items
                    upcomingCursor = next.nextCursor
                }
            }
            cursor = page.nextCursor
            emptyPages = 0
            currency = page.currency
            error = nil
            model.serverAnswered()
            ResponseCache.store(page, key: cacheKey)
            if let next { ResponseCache.store(next, key: upcomingCacheKey) }
        } catch {
            self.error = model.handle(error)
        }
    }

    /// Fetches the newest page and prepends what is new (with a haptic for real new sales; renewals that were listed
    /// as upcoming and whose time has come move over quietly).
    private func poll() async {
        guard let client = model.client else { return }
        let q = query
        guard let page = try? await client.transactions(limit: 20, kinds: q.kinds, refunded: q.refunded, source: source, apps: model.feedApps, quick: q.quick, cancellations: q.cancellations) else { return }
        if let c = page.currency, c != currency {
            // The workspace currency changed: the whole list has to be reloaded in the new one.
            await reload()
            return
        }
        mergeDays(page.days)
        let known = Set(items.map(\.id))
        let fresh = page.items.filter { !known.contains($0.id) }
        let wasUpcoming = Set(upcoming.map(\.id))
        let nowMs = Date.now.timeIntervalSince1970 * 1000
        let freshIds = Set(fresh.map(\.id))
        let due = upcoming.filter { $0.purchasedAt <= nowMs || freshIds.contains($0.id) }
        if !due.isEmpty {
            let dueIds = Set(due.map(\.id))
            withAnimation { upcoming.removeAll { dueIds.contains($0.id) } }
        }
        guard !fresh.isEmpty else { return }
        withAnimation(.spring) {
            items.insert(contentsOf: fresh, at: 0)
            newIds.formUnion(fresh.map(\.id))
        }
        if fresh.contains(where: { $0.kind != "trial" && !$0.isCancellation && $0.refundedAt == nil && !wasUpcoming.contains($0.id) }) { model.newSale() }
    }

    private func loadMore() async {
        guard let client = model.client, let cursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let q = query
            let page = try await client.transactions(limit: 50, cursor: cursor, kinds: q.kinds, refunded: q.refunded, source: source, apps: model.feedApps, quick: q.quick, cancellations: q.cancellations)
            let known = Set(items.map(\.id))
            items.append(contentsOf: page.items.filter { !known.contains($0.id) })
            mergeDays(page.days)
            emptyPages = page.items.isEmpty ? emptyPages + 1 : 0
            self.cursor = page.nextCursor
        } catch {
            self.error = model.handle(error)
            self.cursor = nil
        }
    }

    private func loadMoreUpcoming() async {
        guard let client = model.client, let upcomingCursor else { return }
        do {
            let q = query
            let page = try await client.transactions(limit: 50, cursor: upcomingCursor, kinds: q.kinds, refunded: q.refunded, source: source, apps: model.feedApps, upcoming: true)
            let known = Set(upcoming.map(\.id))
            withAnimation { upcoming.append(contentsOf: page.items.filter { !known.contains($0.id) }) }
            self.upcomingCursor = page.nextCursor
        } catch {
            self.error = model.handle(error)
        }
    }
}

/// Sticky day header: "Today" / "Yesterday" / the date, with the whole day's total from the server.
struct FeedDayHeader: View {
    var key: String
    var total: FeedDay?
    var currency: String
    var net: Bool
    var filter: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color(.label))
                .lineLimit(1)
            Spacer(minLength: 8)
            if let total {
                HStack(spacing: 4) {
                    if showAmount {
                        MoneyText(value: net ? total.proceeds : total.revenue, currency: currency)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color(.label))
                        Text(verbatim: "·").foregroundStyle(.tertiary).accessibilityHidden(true)
                    }
                    Text(countText(total)).foregroundStyle(.secondary)
                }
                .font(.footnote)
                .lineLimit(1)
            }
        }
        .textCase(nil)
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Pinned over the rows while scrolling: needs its own background.
        .background(.bar)
        .listRowInsets(EdgeInsets())
        .accessibilityElement(children: .combine)
    }

    /// Trials, refunds and cancellations have no revenue of their own in these totals.
    private var showAmount: Bool { filter != "trial" && filter != "refunds" && filter != "cancellations" }

    private func countText(_ d: FeedDay) -> String {
        switch filter {
        case "cancellations": d.count == 1 ? String(localized: "1 cancellation") : String(localized: "\(d.count) cancellations")
        case "trial": d.count == 1 ? String(localized: "1 trial") : String(localized: "\(d.count) trials")
        case "refunds": d.count == 1 ? String(localized: "1 refund") : String(localized: "\(d.count) refunds")
        default: d.sales == 1 ? String(localized: "1 sale") : String(localized: "\(d.sales) sales")
        }
    }

    private var label: String {
        guard let date = FeedDayHeader.date(key) else { return key }
        let cal = Calendar.current
        if cal.isDateInToday(date) { return String(localized: "Today") }
        if cal.isDateInYesterday(date) { return String(localized: "Yesterday") }
        if cal.isDate(date, equalTo: .now, toGranularity: .year) {
            return date.formatted(.dateTime.weekday(.wide).day().month(.wide))
        }
        return date.formatted(.dateTime.day().month(.wide).year())
    }

    /// "YYYY-MM-DD" → local midnight.
    static func date(_ key: String) -> Date? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}

/// A renewal Apple announced before its period starts: when it is due, not counted yet.
struct UpcomingRow: View {
    var transaction: Transaction
    private var tx: Transaction { transaction }
    var currency: String
    var net = false

    var body: some View {
        HStack(spacing: 12) {
            AppIconView(url: tx.appIconUrl, name: tx.appName, size: 40)
                .overlay(alignment: .bottomTrailing) {
                    Text(Fmt.flag(tx.country)).font(.system(size: 14)).offset(x: 5, y: 5)
                }
                .opacity(0.75)
            VStack(alignment: .leading, spacing: 3) {
                Text(tx.appName).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(tx.productName ?? tx.productId).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                HStack(spacing: 6) {
                    KindBadge(kind: tx.kind)
                    HStack(spacing: 2) {
                        Image(systemName: "clock").accessibilityHidden(true)
                        Text("Scheduled")
                    }
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.orange)
                    .lineLimit(1)
                    if tx.environment != "Production" { Text("Sandbox").font(.caption2).foregroundStyle(.orange) }
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 3) {
                if tx.kind == "trial" {
                    Text("Free").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                } else {
                    MoneyText(value: net ? tx.proceeds : tx.price, currency: currency)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                Text(scheduled).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            .fixedSize()
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var scheduled: String {
        let date = Fmt.date(ms: tx.purchasedAt)
        let cal = Calendar.current
        let time = date.formatted(date: .omitted, time: .shortened)
        if cal.isDateInToday(date) { return String(localized: "Today, \(time)") }
        if cal.isDateInTomorrow(date) { return String(localized: "Tomorrow, \(time)") }
        return date.formatted(.dateTime.day().month(.abbreviated).hour().minute())
    }
}

struct AnyPrimitiveButtonStyle: PrimitiveButtonStyle {
    private let make: (Configuration) -> AnyView
    init<S: PrimitiveButtonStyle>(_ style: S) { make = { AnyView(style.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
}

struct TransactionRow: View {
    var transaction: Transaction
    private var tx: Transaction { transaction }
    /// Currency of `price` / `proceeds` (the response's `currency`).
    var currency: String
    var isNew = false
    var showApp = true
    /// Show proceeds instead of the gross price (the gross/net toggle).
    var net = false
    /// Show the App Store / Google Play capsule (workspaces with Android apps).
    var showStore = false

    var body: some View {
        HStack(spacing: 12) {
            if showApp {
                AppIconView(url: tx.appIconUrl, name: tx.appName, size: 40)
                    .overlay(alignment: .bottomTrailing) {
                        Text(Fmt.flag(tx.country)).font(.system(size: 14)).offset(x: 5, y: 5)
                    }
            } else {
                Text(Fmt.flag(tx.country)).font(.title2).frame(width: 40)
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(showApp ? tx.appName : (tx.productName ?? tx.productId)).font(.subheadline.weight(.semibold)).lineLimit(1)
                    if isNew { Circle().fill(Color.green).frame(width: 6, height: 6) }
                }
                Text(showApp ? (tx.productName ?? tx.productId) : Fmt.country(tx.country))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                HStack(spacing: 6) {
                    KindBadge(kind: tx.kind, refunded: tx.refundedAt != nil)
                    if tx.isCancellation, tx.purchaseKind == "trial" { KindBadge(kind: "trial") }
                    if tx.isCancelledTrial { CancelledBadge(trial: false) }
                    if tx.quick == true { QuickChip(ms: tx.quickDurationMs, cancel: tx.isCancellation || !Quick.isQuick(tx.sinceInstallMs)) }
                    if tx.kind != "renewal", let a = tx.attribution, a.isAds { AppleAdsBadge(test: a.test, source: a.source) }
                    if tx.environment != "Production" { Text("Sandbox").font(.caption2).foregroundStyle(.orange) }
                    if showStore { StoreBadge(android: tx.isPlayStore) }
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 3) {
                if tx.isCancellation {
                    Text("Auto-renew off").font(.caption.weight(.semibold)).foregroundStyle(.red).lineLimit(1)
                } else if tx.kind == "trial" {
                    Text("Free").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                } else {
                    MoneyText(value: net ? tx.proceeds : tx.price, currency: currency)
                        .font(.subheadline.weight(.semibold))
                        .strikethrough(tx.refundedAt != nil)
                        .foregroundStyle(tx.refundedAt != nil ? .secondary : .primary)
                }
                Text(Fmt.date(ms: tx.purchasedAt), style: .time).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                if let since = tx.isCancellation ? tx.sincePurchaseMs : nil {
                    Text("+\(Fmt.duration(ms: since))").font(.caption2.monospacedDigit()).foregroundStyle(Quick.isQuick(since) ? .red : .secondary).lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// A push's transaction id → its customer (or the bare transaction).
struct TransactionLookupView: View {
    @Environment(AppModel.self) private var model
    var transactionId: String
    @State private var tx: Transaction?
    @State private var currency: String?
    @State private var error: String?

    var body: some View {
        Group {
            if let tx {
                if let customerId = tx.customerId {
                    CustomerView(customerId: customerId, highlight: tx.id)
                } else {
                    TransactionDetailView(transaction: tx, currency: currency ?? model.currency)
                }
            } else if let error {
                ContentUnavailableView("Transaction not found", systemImage: "magnifyingglass", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .task {
            guard let client = model.client else { return }
            do {
                let page = try await client.transactions(limit: 1, q: transactionId, environment: "all")
                currency = page.currency
                if let first = page.items.first { tx = first } else { error = String(localized: "It may still be processing. Pull to refresh the feed in a moment.") }
            } catch {
                self.error = model.handle(error) ?? ((error as? APIError)?.isQuota == true ? error.localizedDescription : "")
            }
        }
    }
}

struct TransactionDetailView: View {
    var transaction: Transaction
    var currency: String
    private var tx: Transaction { transaction }

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    AppIconView(url: tx.appIconUrl, name: tx.appName, size: 56)
                    VStack(alignment: .leading) {
                        Text(tx.appName).font(.headline)
                        Text(tx.productName ?? tx.productId).foregroundStyle(.secondary)
                        KindBadge(kind: tx.kind, refunded: tx.refundedAt != nil)
                    }
                }
            }
            Section {
                LabeledContent("Price") { MoneyText(value: tx.price, currency: currency) }
                if let cur = tx.storeCurrency {
                    LabeledContent("Store price") { Text(tx.storePrice.formatted(.currency(code: cur))).privacySensitive() }
                }
                LabeledContent("Proceeds") { MoneyText(value: tx.proceeds, currency: currency) }
                LabeledContent("Country") { Text("\(Fmt.flag(tx.country)) \(Fmt.country(tx.country))") }
                LabeledContent("Purchased") { Text(Fmt.date(ms: tx.purchasedAt).formatted(date: .abbreviated, time: .shortened)) }
                if let e = tx.expiresAt {
                    LabeledContent("Expires") { Text(Fmt.date(ms: e).formatted(date: .abbreviated, time: .shortened)) }
                }
                if let r = tx.refundedAt {
                    LabeledContent("Refunded") { Text(Fmt.date(ms: r).formatted(date: .abbreviated, time: .shortened)).foregroundStyle(.red) }
                }
                if let offer = tx.offer { LabeledContent("Offer", value: offer) }
                if tx.store != nil { LabeledContent("Store", value: Store.title(android: tx.isPlayStore)) }
                LabeledContent("Environment", value: tx.environment)
                LabeledContent("Source", value: tx.source)
            }
            if let a = tx.attribution {
                Section("Acquisition") { AcquisitionRows(attribution: a) }
            }
            Section("Identifiers") {
                LabeledContent("Transaction ID") { Text(tx.transactionId).textSelection(.enabled).font(.caption.monospaced()) }
                LabeledContent("Original ID") { Text(tx.originalTransactionId).textSelection(.enabled).font(.caption.monospaced()) }
                LabeledContent("Product ID") { Text(tx.productId).textSelection(.enabled).font(.caption.monospaced()) }
            }
        }
        .navigationTitle("Transaction")
        .navigationBarTitleDisplayMode(.inline)
    }
}

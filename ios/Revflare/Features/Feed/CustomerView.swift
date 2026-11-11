import SwiftUI

/// A customer's subscriptions and full transaction timeline (`GET /customers/:id`).
struct CustomerView: View {
    @Environment(AppModel.self) private var model
    var customerId: String
    var highlight: String?
    @State private var loader = Loader<Customer>()

    var body: some View {
        List {
            if let error = loader.error, loader.value == nil {
                ErrorBanner(message: error) { Task { await load() } }.listRowBackground(Color.clear)
            }
            if let c = loader.value {
                header(c)
                activity(c)
                if let t = c.timing, t.installToPurchaseMs != nil || t.purchaseToCancelMs != nil || t.purchaseToRefundMs != nil {
                    Section {
                        TimingRows(timing: t)
                    } header: {
                        Text("Speed")
                    } footer: {
                        Text("Within 5 minutes is marked with ⚡.")
                    }
                }
                if let a = c.attribution {
                    Section("Acquisition") { AcquisitionRows(attribution: a) }
                }
                if !c.subscriptions.isEmpty {
                    Section("Subscriptions") {
                        ForEach(c.subscriptions) { s in
                            SubscriptionRow(subscription: s, currency: model.currency, showApp: false, showTimes: true)
                        }
                    }
                }
                Section("Timeline") {
                    let timeline = c.transactions.sorted { $0.purchasedAt > $1.purchasedAt }
                    ForEach(Array(timeline.enumerated()), id: \.element.id) { i, tx in
                        let older = i + 1 < timeline.count ? timeline[i + 1].purchasedAt : nil
                        timelineLink(tx, currency: model.currency, isLast: i == timeline.count - 1, gap: older.map { tx.purchasedAt - $0 })
                    }
                }
                if let events = c.events, !events.isEmpty {
                    Section("History") {
                        let trials = Set(c.transactions.filter { $0.kind == "trial" }.map(\.transactionId))
                        ForEach(Array(events.enumerated()), id: \.offset) { i, e in
                            let older = i + 1 < events.count ? events[i + 1].at : nil
                            EventRow(event: e, productName: productName(c, e.productId), trial: e.transactionId.map { trials.contains($0) } ?? false, gap: older.map { e.at - $0 })
                        }
                    }
                }
                Section("Identifiers") {
                    LabeledContent("Customer ID") { Text(c.id).font(.caption.monospaced()).textSelection(.enabled) }
                    if let t = c.appAccountToken {
                        LabeledContent("App account token") { Text(t).font(.caption.monospaced()).textSelection(.enabled) }
                    }
                    if let rc = c.rcAppUserId {
                        LabeledContent("RevenueCat ID") { Text(rc).font(.caption.monospaced()).textSelection(.enabled) }
                    }
                }
            } else if loader.loading {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .navigationTitle("Customer")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    private func productName(_ c: Customer, _ productId: String?) -> String? {
        guard let productId else { return nil }
        return c.subscriptions.first { $0.productId == productId }?.productName
            ?? c.transactions.first { $0.productId == productId }?.productName
            ?? productId
    }

    private func timelineLink(_ tx: Transaction, currency: String, isLast: Bool, gap: Double?) -> some View {
        let highlighted = tx.id == highlight
        let route = Route.transaction(tx, currency: currency)
        return NavigationLink(value: route) {
            TimelineRow(transaction: tx, currency: currency, highlighted: highlighted, isLast: isLast, gap: gap)
        }
        .listRowBackground(highlighted ? Color.brand.opacity(0.08) : nil)
    }

    /// App, country, the quick badges and the money.
    @ViewBuilder
    private func header(_ c: Customer) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    AppIconView(url: model.app(c.appId)?.iconUrl, name: c.appName, size: 52)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(c.appName).font(.headline).lineLimit(1)
                        Text("\(Fmt.flag(c.country)) \(Fmt.country(c.country))").font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
                if let t = c.timing, t.quickPurchase || t.quickCancel {
                    VStack(alignment: .leading, spacing: 6) {
                        if t.quickPurchase, let ms = t.installToPurchaseMs {
                            QuickBanner(text: t.firstPurchaseKind == "trial" ? String(localized: "Started a trial \(Fmt.duration(ms: ms)) after installing") : String(localized: "Bought \(Fmt.duration(ms: ms)) after installing"), color: .orange)
                        }
                        if t.quickCancel, let ms = t.purchaseToCancelMs {
                            QuickBanner(text: String(localized: "Cancelled \(Fmt.duration(ms: ms)) after buying"), color: .red)
                        }
                    }
                }
                HStack(spacing: 0) {
                    stat("Total spent") { MoneyText(value: c.totalSpent, currency: model.currency) }
                    stat("Proceeds") { MoneyText(value: c.totalProceeds, currency: model.currency) }
                    stat("Purchases") { Text(Fmt.count(c.transactions.filter { $0.kind != "trial" }.count)) }
                }
            }
            .padding(.vertical, 4)
        }
    }

    /// First seen / last seen / installed: date, time and how long ago, with where it comes from.
    @ViewBuilder
    private func activity(_ c: Customer) -> some View {
        Section("Activity") {
            ActivityRow(icon: "person.crop.circle.badge.plus", title: "First seen", ms: c.firstSeenAt, source: firstSource(c.firstSeenSource))
            ActivityRow(icon: "clock.arrow.circlepath", title: "Last seen", ms: c.lastSeenAt, source: lastSource(c.lastSeenSource))
            if let installed = c.installedAt, !(c.firstSeenSource == "install" && c.firstSeenAt == installed) {
                ActivityRow(icon: "arrow.down.app", title: "Installed", ms: installed, source: c.installedAtSource == "first_report" ? String(localized: "First report from the app") : String(localized: "First launch on the device"))
            }
        }
    }

    private func firstSource(_ s: String?) -> String? {
        switch s {
        case "install": String(localized: "App install")
        case "purchase": String(localized: "First purchase")
        default: nil
        }
    }

    private func lastSource(_ s: String?) -> String? {
        switch s {
        case "app": String(localized: "In the app")
        case "purchase": String(localized: "Purchase")
        case "notification": String(localized: "Store notification")
        default: nil
        }
    }

    private func stat<V: View>(_ title: LocalizedStringKey, @ViewBuilder value: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            value().font(.headline)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func load() async {
        guard let client = model.client else { return }
        loader.use(cacheKey: ResponseCache.key("customer", customerId))
        await loader.load { try await client.customer(customerId) }
    }
}

/// "⚡ Bought 2 min 14 s after installing" in the customer header.
private struct QuickBanner: View {
    var text: String
    var color: Color

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "bolt.fill").font(.caption.weight(.bold)).accessibilityHidden(true)
            Text(text).font(.subheadline.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 10).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// One activity line: icon, title and source on the left; date + time and "3 hours ago" on the right.
private struct ActivityRow: View {
    var icon: String
    var title: LocalizedStringKey
    var ms: Double
    var source: String?

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.brand)
                .frame(width: 32, height: 32)
                .background(Color.brand.opacity(0.13), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.subheadline.weight(.semibold))
                if let source { Text(source).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 1) {
                Text(Fmt.dateTime(ms: ms)).font(.subheadline.weight(.semibold).monospacedDigit()).lineLimit(1).minimumScaleFactor(0.8)
                Text(Fmt.date(ms: ms), format: .relative(presentation: .named)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// Install → first purchase, purchase → cancellation, purchase → refund; ⚡ within 5 minutes.
private struct TimingRows: View {
    var timing: CustomerTiming

    var body: some View {
        if let ms = timing.installToPurchaseMs {
            row(timing.firstPurchaseKind == "trial" ? "Install → trial" : "Install → first purchase", ms: ms, color: .orange)
        }
        if let ms = timing.purchaseToCancelMs {
            row("Purchase → cancellation", ms: ms, color: .red, at: timing.cancelledAt)
        }
        if let ms = timing.purchaseToRefundMs {
            row("Purchase → refund", ms: ms, color: .red, at: timing.refundedAt)
        }
    }

    private func row(_ title: LocalizedStringKey, ms: Double, color: Color, at: Double? = nil) -> some View {
        let quick = Quick.isQuick(ms)
        return HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.subheadline)
                if let at { Text(Fmt.dateTime(ms: at)).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            HStack(spacing: 3) {
                if quick { Image(systemName: "bolt.fill").font(.caption.weight(.bold)) }
                Text(Fmt.duration(ms: ms)).monospacedDigit()
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(quick ? color : .primary)
        }
        .accessibilityElement(children: .combine)
    }
}

struct SubscriptionRow: View {
    var subscription: Subscription
    private var s: Subscription { subscription }
    var currency: String
    var showApp: Bool
    /// Customer screen: dates with the time, the start and how fast it was cancelled.
    var showTimes = false

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(showApp ? s.appName : (s.productName ?? s.productId)).font(.subheadline.weight(.semibold)).lineLimit(1)
                HStack(spacing: 6) {
                    if s.isCancelled {
                        CancelledBadge(trial: s.status == "trial")
                        if s.status == "grace" || s.status == "billing_retry" { StatusBadge(status: s.status) }
                    } else {
                        StatusBadge(status: s.status)
                    }
                    if let p = Fmt.period(s.period) { Text(p).font(.caption).foregroundStyle(.secondary) }
                    if showTimes, s.isCancelled, Quick.isQuick(s.cancelledAfterMs) { QuickChip(ms: s.cancelledAfterMs, cancel: true) }
                }
                if showTimes {
                    Text("Started \(Fmt.dateTime(ms: s.startedAt))").font(.caption2).foregroundStyle(.secondary)
                }
                if let e = s.expiresAt {
                    let date = Fmt.date(ms: e)
                    let day = showTimes ? Fmt.dateTime(ms: e) : date.formatted(date: .abbreviated, time: .omitted)
                    Group {
                        if date < Date() { Text("Expired \(day)") } else if s.autoRenew { Text("Renews \(day)") } else { Text("Ends \(day)").foregroundStyle(.red) }
                    }
                    .font(.caption2).foregroundStyle(.secondary)
                }
                if s.isCancelled, let off = s.autoRenewOffAt {
                    let day = showTimes ? Fmt.shortDateTime(ms: off) : Fmt.date(ms: off).formatted(date: .abbreviated, time: .omitted)
                    HStack(spacing: 4) {
                        Text("Cancelled \(day)")
                        if showTimes, let after = s.cancelledAfterMs {
                            Text(verbatim: "·").accessibilityHidden(true)
                            Text("\(Fmt.duration(ms: after)) after the purchase").foregroundStyle(Quick.isQuick(after) ? .red : .secondary)
                        }
                    }
                    .font(.caption2).foregroundStyle(.secondary)
                }
                if s.isCancelled || s.status == "expired", let reason = s.cancelReasonTitle {
                    Text(reason).font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if s.mrr > 0 {
                VStack(alignment: .trailing, spacing: 1) {
                    MoneyText(value: s.mrr, currency: currency).font(.subheadline.weight(.semibold))
                    Text("MRR").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// Auto-renew is off on a running subscription: "Cancelled" / "Trial cancelled".
struct CancelledBadge: View {
    var trial: Bool

    var body: some View {
        Text(trial ? String(localized: "Trial cancelled") : String(localized: "Cancelled"))
            .font(.caption2.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .foregroundStyle(.red)
            .background(Color.red.opacity(0.13), in: Capsule())
            .accessibilityHint(Text("Auto-renew off"))
    }
}

/// One Apple notification in the customer's history.
private struct EventRow: View {
    var event: CustomerEvent
    var productName: String?
    var trial: Bool
    /// Time since the previous (older) notification.
    var gap: Double? = nil

    var body: some View {
        let (title, color) = Self.label(event, trial: trial)
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(color).frame(width: 8, height: 8).padding(.top, 6)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title).font(.subheadline.weight(.medium))
                    Spacer(minLength: 6)
                    if let gap { GapText(ms: gap) }
                }
                HStack(spacing: 4) {
                    Text(Fmt.dateTime(ms: event.at))
                    if let productName { Text("·"); Text(productName).lineLimit(1) }
                    if let env = event.environment, env != "Production" { Text("·"); Text("Sandbox").foregroundStyle(.orange) }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// Localized label of an Apple notification type / subtype (unknown types shown raw).
    static func label(_ e: CustomerEvent, trial: Bool) -> (String, Color) {
        let sub = e.subtype ?? ""
        switch e.type {
        case "SUBSCRIBED":
            if sub == "RESUBSCRIBE" { return (String(localized: "Resubscribed"), .green) }
            return trial ? (String(localized: "Trial started"), .purple) : (String(localized: "Subscribed"), .green)
        case "DID_RENEW":
            return (sub == "BILLING_RECOVERY" ? String(localized: "Renewed (billing recovered)") : String(localized: "Renewed"), .blue)
        case "DID_CHANGE_RENEWAL_STATUS" where sub == "AUTO_RENEW_DISABLED":
            return (String(localized: "Auto-renew turned off"), .red)
        case "SUBSCRIPTION_CANCELED":
            return (String(localized: "Auto-renew turned off"), .red)
        case "DID_CHANGE_RENEWAL_STATUS" where sub == "AUTO_RENEW_ENABLED":
            return (String(localized: "Auto-renew turned on"), .green)
        case "DID_CHANGE_RENEWAL_PREF":
            if sub == "UPGRADE" { return (String(localized: "Plan change (upgrade)"), .indigo) }
            if sub == "DOWNGRADE" { return (String(localized: "Plan change (downgrade)"), .orange) }
            return (String(localized: "Plan change cancelled"), .gray)
        case "DID_FAIL_TO_RENEW":
            return (sub == "GRACE_PERIOD" ? String(localized: "Billing problem (grace period)") : String(localized: "Billing problem"), .orange)
        case "GRACE_PERIOD_EXPIRED":
            return (String(localized: "Grace period ended"), .orange)
        case "EXPIRED":
            switch sub {
            case "VOLUNTARY": return (String(localized: "Expired (cancelled)"), .gray)
            case "BILLING_RETRY": return (String(localized: "Expired (billing)"), .gray)
            case "PRICE_INCREASE": return (String(localized: "Expired (price increase)"), .gray)
            case "PRODUCT_NOT_FOR_SALE": return (String(localized: "Expired (product not for sale)"), .gray)
            default: return (String(localized: "Expired"), .gray)
            }
        case "REFUND": return (String(localized: "Refunded"), .red)
        case "REFUND_DECLINED": return (String(localized: "Refund declined"), .gray)
        case "REFUND_REVERSED": return (String(localized: "Refund reversed"), .green)
        case "CONSUMPTION_REQUEST": return (String(localized: "Consumption request (refund asked)"), .orange)
        case "OFFER_REDEEMED": return (String(localized: "Offer redeemed"), .indigo)
        case "PRICE_INCREASE":
            if sub == "ACCEPTED" { return (String(localized: "Price increase accepted"), .orange) }
            return (String(localized: "Price increase"), .orange)
        case "RENEWAL_EXTENDED": return (String(localized: "Renewal date extended"), .blue)
        case "REVOKE": return (String(localized: "Access revoked (Family Sharing)"), .red)
        case "ONE_TIME_CHARGE": return (String(localized: "Purchase"), .green)
        default:
            return (e.subtype.map { "\(e.type) · \($0)" } ?? e.type, .gray)
        }
    }
}

struct StatusBadge: View {
    var status: String

    var body: some View {
        Text(title)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.13), in: Capsule())
    }

    private var title: String {
        switch status {
        case "trial": String(localized: "Trial")
        case "active": String(localized: "Active")
        case "grace": String(localized: "Grace period")
        case "billing_retry": String(localized: "Billing retry")
        case "expired": String(localized: "Expired")
        case "revoked": String(localized: "Revoked")
        case "refunded": String(localized: "Refunded")
        default: status
        }
    }

    private var color: Color {
        switch status {
        case "active": .green
        case "trial": .purple
        case "grace", "billing_retry": .orange
        case "refunded", "revoked": .red
        default: .gray
        }
    }
}

private struct TimelineRow: View {
    var transaction: Transaction
    private var tx: Transaction { transaction }
    var currency: String
    var highlighted: Bool
    var isLast: Bool
    /// Time since the previous (older) transaction.
    var gap: Double? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 0) {
                Circle().fill(tx.refundedAt != nil ? Color.red : KindBadge.color(tx.kind)).frame(width: 10, height: 10).padding(.top, 5)
                if !isLast { Rectangle().fill(Color.secondary.opacity(0.25)).frame(width: 2).frame(maxHeight: .infinity) }
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    KindBadge(kind: tx.kind, refunded: tx.refundedAt != nil)
                    if tx.isCancelledTrial { CancelledBadge(trial: false) }
                    Spacer()
                    if tx.kind == "trial" {
                        Text("Free").font(.subheadline).foregroundStyle(.secondary)
                    } else {
                        MoneyText(value: tx.price, currency: currency).font(.subheadline.weight(.semibold)).strikethrough(tx.refundedAt != nil)
                    }
                }
                Text(tx.productName ?? tx.productId).font(.subheadline)
                HStack(spacing: 6) {
                    Text(Fmt.dateTime(ms: tx.purchasedAt)).monospacedDigit()
                    Spacer(minLength: 4)
                    if let gap { GapText(ms: gap) }
                }
                .font(.caption).foregroundStyle(.secondary)
                if let since = tx.sinceInstallMs {
                    HStack(spacing: 3) {
                        if Quick.isQuick(since) { Image(systemName: "bolt.fill").accessibilityHidden(true) }
                        Text("\(Fmt.duration(ms: since)) after installing")
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Quick.isQuick(since) ? Color.orange : .secondary)
                }
                if let r = tx.refundedAt {
                    Text("Refunded \(Fmt.shortDateTime(ms: r))").font(.caption).foregroundStyle(.red)
                }
            }
        }
    }
}

/// "+2 min" since the previous step; orange within 5 minutes so fast buyers / cancellers stand out.
private struct GapText: View {
    var ms: Double

    var body: some View {
        if ms >= 1000 {
            Text(verbatim: "+\(Fmt.duration(ms: ms))")
                .font(.caption2.weight(Quick.isQuick(ms) ? .bold : .regular).monospacedDigit())
                .foregroundStyle(Quick.isQuick(ms) ? Color.orange : Color.secondary)
                .lineLimit(1)
                .accessibilityLabel(Text("\(Fmt.duration(ms: ms)) later"))
        }
    }
}

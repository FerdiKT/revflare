import ActivityKit
import SwiftUI
import WidgetKit

/// "Today's revenue" on the Lock Screen and in the Dynamic Island. Updated by the server on each sale.
struct RevenueLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RevenueActivityAttributes.self) { context in
            LockScreenActivityView(context: context)
                .activityBackgroundTint(Color.black.opacity(0.55))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(URL(string: "revflare://overview"))
        } dynamicIsland: { context in
            let s = context.state
            let net = SharedSettings.showProceeds
            let hide = SharedSettings.privacyMode
            let amount = net ? s.proceeds : s.revenue
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 2) {
                        Label(net ? "Today · net" : "Today", systemImage: "chart.line.uptrend.xyaxis")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.brand)
                        Text(Fmt.money(amount, s.currency, hide: hide))
                            .font(.system(.title2, design: .rounded).weight(.bold))
                            .contentTransition(.numericText(value: amount))
                            .minimumScaleFactor(0.5)
                            .lineLimit(1)
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("\(s.sales) sales").font(.caption.weight(.semibold))
                        Text("MRR \(Fmt.money(s.mrr, s.currency, compact: true, hide: hide))").font(.caption2).foregroundStyle(.secondary)
                    }
                    .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    LastSaleLine(state: s, hide: hide)
                        .padding(.horizontal, 4)
                }
            } compactLeading: {
                Image(systemName: "chart.line.uptrend.xyaxis")
                    .foregroundStyle(Color.brand)
                    .font(.caption.weight(.bold))
            } compactTrailing: {
                Text(Fmt.money(amount, s.currency, compact: true, hide: hide))
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .contentTransition(.numericText(value: amount))
                    .foregroundStyle(Color.brand)
                    .frame(maxWidth: 72)
                    .minimumScaleFactor(0.6)
            } minimal: {
                Image(systemName: "dollarsign")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Color.brand)
            }
            .widgetURL(URL(string: "revflare://overview"))
            .keylineTint(Color.brand)
        }
        .supplementalActivityFamilies([.small])
    }
}

private struct LockScreenActivityView: View {
    var context: ActivityViewContext<RevenueActivityAttributes>
    @Environment(\.activityFamily) private var activityFamily

    var body: some View {
        let s = context.state
        let net = SharedSettings.showProceeds
        let hide = SharedSettings.privacyMode
        let amount = net ? s.proceeds : s.revenue
        if activityFamily == .small {
            // Apple Watch Smart Stack / CarPlay.
            VStack(alignment: .leading, spacing: 2) {
                Text(net ? "Today · net" : "Today").font(.caption2).foregroundStyle(.secondary)
                Text(Fmt.money(amount, s.currency, compact: true, hide: hide)).font(.headline.weight(.bold)).foregroundStyle(Color.brand)
                Text("\(s.sales) sales").font(.caption2)
            }
            .padding(8)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label(context.attributes.workspaceName, systemImage: "chart.line.uptrend.xyaxis")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.brand)
                    Spacer()
                    Text(s.updatedDate, style: .time).font(.caption2).foregroundStyle(.white.opacity(0.6))
                }
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(net ? "Today · net" : "Today").font(.caption).foregroundStyle(.white.opacity(0.7))
                        Text(Fmt.money(amount, s.currency, hide: hide))
                            .font(.system(size: 34, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)
                            .contentTransition(.numericText(value: amount))
                            .minimumScaleFactor(0.5)
                            .lineLimit(1)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("\(s.sales) sales").font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                        Text("MRR \(Fmt.money(s.mrr, s.currency, compact: true, hide: hide))").font(.caption).foregroundStyle(.white.opacity(0.7))
                    }
                }
                LastSaleLine(state: s, hide: hide)
            }
            .padding(16)
        }
    }
}

private struct LastSaleLine: View {
    var state: RevenueActivityAttributes.ContentState
    private var s: RevenueActivityAttributes.ContentState { state }
    var hide: Bool

    var body: some View {
        if let app = s.lastAppName, let amount = s.lastAmount {
            HStack(spacing: 6) {
                Image(systemName: "cart.fill").font(.caption2).foregroundStyle(Color.brand)
                Text(app).font(.caption.weight(.semibold)).lineLimit(1)
                if let product = s.lastProductName {
                    Text(product).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Text("+\(Fmt.money(amount, s.currency, hide: hide))").font(.caption.weight(.bold)).foregroundStyle(.green)
            }
        }
    }
}

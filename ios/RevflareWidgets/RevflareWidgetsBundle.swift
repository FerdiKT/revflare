import AppIntents
import SwiftUI
import WidgetKit

@main
struct RevflareWidgetsBundle: WidgetBundle {
    var body: some Widget {
        TodayWidget()
        MRRWidget()
        RevenueChartWidget()
        SpotlightWidget()
        GoalWidget()
        RevenueLiveActivity()
        TodayRevenueControl()
    }
}

/// Control Center / Lock Screen control: today's revenue; tapping opens Revflare.
struct TodayRevenueControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: WidgetKinds.control, provider: TodayControlProvider()) { value in
            ControlWidgetButton(action: OpenRevflareIntent()) {
                Label {
                    Text(value)
                } icon: {
                    Image(systemName: "chart.line.uptrend.xyaxis")
                }
            }
        }
        .displayName("Today's revenue")
        .description("Shows today's revenue and opens Revflare.")
    }
}

struct TodayControlProvider: ControlValueProvider {
    var previewValue: String { Fmt.money(412, SharedSettings.currency, compact: true) }

    func currentValue() async throws -> String {
        SharedSettings.reload()
        guard let s = await WidgetData.load(appId: nil, appName: nil) else { return String(localized: "Sign in") }
        return Fmt.money(s.today, s.currency, compact: true, hide: SharedSettings.privacyMode)
    }
}

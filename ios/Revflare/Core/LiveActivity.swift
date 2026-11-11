import ActivityKit
import Foundation

/// "Today's revenue" Live Activity (Dynamic Island + Lock Screen). The server updates it with
/// `apns-push-type: liveactivity` pushes whose `content-state` is exactly `ContentState` (worker/lib/push.ts).
struct RevenueActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable, Sendable {
        var revenue: Double
        var proceeds: Double
        var sales: Int
        var mrr: Double
        var currency: String
        var lastAppName: String?
        var lastAmount: Double?
        var lastProductName: String?
        /// Unix seconds.
        var updatedAt: Int

        var updatedDate: Date { Date(timeIntervalSince1970: TimeInterval(updatedAt)) }
    }

    var workspaceName: String
}

extension RevenueActivityAttributes.ContentState {
    init(overview o: Overview) {
        self.init(revenue: o.today.revenue, proceeds: o.today.proceeds, sales: o.today.sales, mrr: o.kpi("mrr")?.value ?? 0,
                  currency: o.currency, lastAppName: nil, lastAmount: nil, lastProductName: nil,
                  updatedAt: Int(Date().timeIntervalSince1970))
    }
}

import ActivityKit
import Foundation
import Observation

/// Starts/ends the "Today's revenue" Live Activity and reports its push token to the server
/// (`PATCH /devices/:id { activityToken }`, `null` when it ends) so new sales update it.
@MainActor
@Observable
final class LiveActivityManager {
    static let shared = LiveActivityManager()

    private(set) var isRunning = false
    var lastError: String?
    private var observed = Set<String>()
    private var tokens: [String: String] = [:]

    var areActivitiesEnabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    private var current: Activity<RevenueActivityAttributes>? {
        Activity<RevenueActivityAttributes>.activities.first { $0.activityState == .active || $0.activityState == .stale }
    }

    func observeExisting() {
        for activity in Activity<RevenueActivityAttributes>.activities { observe(activity) }
        isRunning = current != nil
    }

    func start(overview: Overview?) async {
        guard current == nil else { return }
        guard areActivitiesEnabled else {
            lastError = String(localized: "Live Activities are turned off for Revflare in Settings.")
            return
        }
        let name = SharedSettings.workspaceName ?? "Revflare"
        let state = overview.map(RevenueActivityAttributes.ContentState.init(overview:))
            ?? .init(revenue: 0, proceeds: 0, sales: 0, mrr: 0, currency: SharedSettings.currency, lastAppName: nil, lastAmount: nil, lastProductName: nil, updatedAt: Int(Date().timeIntervalSince1970))
        do {
            let activity = try Activity.request(
                attributes: RevenueActivityAttributes(workspaceName: name),
                content: ActivityContent(state: state, staleDate: Date().addingTimeInterval(4 * 3600)),
                pushType: .token
            )
            observe(activity)
            isRunning = true
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func stop() async {
        await endAll()
    }

    func endAll() async {
        for activity in Activity<RevenueActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        isRunning = false
        await send(token: nil)
    }

    /// Updates the running activity from fresh app data (pushes do it while the app is closed).
    func update(with overview: Overview) async {
        guard let activity = current else { return }
        var state = RevenueActivityAttributes.ContentState(overview: overview)
        let old = activity.content.state
        state.lastAppName = old.lastAppName
        state.lastAmount = old.lastAmount
        state.lastProductName = old.lastProductName
        guard state.revenue != old.revenue || state.sales != old.sales || state.mrr != old.mrr || state.currency != old.currency else { return }
        await activity.update(ActivityContent(state: state, staleDate: Date().addingTimeInterval(4 * 3600)))
    }

    /// After the device registration changes: report the current token again.
    func resendTokens() async {
        if let activity = current, let token = tokens[activity.id] { await send(token: token) }
    }

    private func observe(_ activity: Activity<RevenueActivityAttributes>) {
        guard !observed.contains(activity.id) else { return }
        observed.insert(activity.id)
        Task { [weak self] in
            for await data in activity.pushTokenUpdates {
                let hex = data.map { String(format: "%02x", $0) }.joined()
                self?.tokens[activity.id] = hex
                await self?.send(token: hex)
            }
        }
        Task { [weak self] in
            for await state in activity.activityStateUpdates {
                if state == .ended || state == .dismissed {
                    self?.tokens[activity.id] = nil
                    self?.isRunning = self?.current != nil
                    if self?.current == nil { await self?.send(token: nil) }
                }
            }
        }
    }

    private func send(token: String?) async {
        guard let client = AppModel.shared.client, let id = SharedSettings.deviceId else { return }
        do {
            let d = try await client.updateDevice(id, activityToken: token)
            PushManager.shared.setDevice(d)
        } catch {
            lastError = AppModel.shared.handle(error)
        }
    }
}

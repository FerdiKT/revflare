import Foundation
import WidgetKit

/// Reports the WidgetKit push token to the server (`PATCH /devices/:id { widgetToken }`, `null` when it was
/// revoked) so it can refresh the widgets with `apns-push-type: widgets` pushes. Runs in the app (launch,
/// foreground, after the device registration) and in the widget extension (when the token changes).
enum WidgetPushToken {
    static func hex(_ token: Data) -> String { token.map { String(format: "%02x", $0) }.joined() }

    /// Sends `token` unless the server already has it for this device. Returns the updated device, if sent.
    @discardableResult
    static func report(_ token: String?) async throws -> Device? {
        SharedSettings.reload()
        guard let client = APIClient.current(), let deviceId = SharedSettings.deviceId else { return nil }
        let marker = "\(deviceId):\(token ?? "-")"
        let last = SharedSettings.widgetTokenSent
        guard marker != last else { return nil }
        // Nothing was ever reported for this device: no need to clear it.
        if token == nil, last == nil || last?.hasPrefix("\(deviceId):") == false {
            SharedSettings.widgetTokenSent = marker
            return nil
        }
        let device = try await client.updateDevice(deviceId, widgetToken: token)
        SharedSettings.widgetTokenSent = marker
        return device
    }

    /// The system's current token (nil when there is none / it was revoked), reported if it changed.
    @discardableResult
    static func sync() async throws -> Device? {
        let token = await WidgetCenter.shared.currentPushInfo.map { hex($0.token) }
        SharedSettings.widgetPushToken = token
        return try await report(token)
    }
}

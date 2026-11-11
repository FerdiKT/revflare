import Foundation
import Observation
import UIKit
import UserNotifications
import WidgetKit

/// Push permission, APNs registration (`POST /devices`) and notification preferences (`PATCH /devices/:id`).
@MainActor
@Observable
final class PushManager: NSObject {
    static let shared = PushManager()

    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    private(set) var device: Device? = ResponseCache.load(Device.self, key: "device")
    private(set) var registering = false
    var lastError: String?

    #if DEBUG
    static let environment = "sandbox"
    #else
    static let environment = "production"
    #endif

    func refreshAuthorization() async {
        authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    func requestAuthorizationAndRegister() async {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "RFSkipPushPrompt") { return }
        #endif
        let center = UNUserNotificationCenter.current()
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge, .providesAppNotificationSettings])
            await refreshAuthorization()
            if granted { UIApplication.shared.registerForRemoteNotifications() }
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Called on launch: keeps the registration fresh when permission was already given.
    func registerIfAuthorized() async {
        await refreshAuthorization()
        if authorization == .authorized || authorization == .provisional || authorization == .ephemeral {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func didRegister(deviceToken: Data) async {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        guard let client = AppModel.shared.client else { return }
        registering = true
        defer { registering = false }
        var prefs = device?.prefs ?? DevicePrefs()
        prefs.timezone = TimeZone.current.identifier
        prefs.locale = Locale.preferredLanguages.first ?? Locale.current.identifier
        do {
            let d = try await client.registerDevice(.init(apnsToken: hex, environment: Self.environment, name: AppModel.deviceName, prefs: prefs))
            setDevice(d)
            await LiveActivityManager.shared.resendTokens()
            await syncWidgetToken()
        } catch {
            lastError = AppModel.shared.handle(error)
        }
    }

    func update(_ prefs: DevicePrefs) async {
        guard let client = AppModel.shared.client, let id = device?.id else { return }
        // Optimistic: the toggle stays where the user put it.
        device?.prefs = prefs
        do {
            setDevice(try await client.updateDevice(id, prefs: prefs))
            lastError = nil
        } catch {
            lastError = AppModel.shared.handle(error)
        }
    }

    /// Mutes or unmutes one app's sale / event notifications (Apps tab swipe action / context menu).
    func setMuted(_ muted: Bool, app id: String) async {
        guard var prefs = device?.prefs else { return }
        prefs.editOverride(id) { $0.muted = muted ? true : nil }
        await update(prefs)
    }

    func sendTest() async throws {
        guard let client = AppModel.shared.client, let id = device?.id else { throw APIError.notSignedIn }
        try await client.testPush(id)
    }

    /// Reports the WidgetKit push token when it changed (or `null` when it was revoked).
    func syncWidgetToken() async {
        do {
            if let d = try await WidgetPushToken.sync() { setDevice(d) }
        } catch {
            _ = AppModel.shared.handle(error)
        }
    }

    func setDevice(_ d: Device?) {
        device = d
        SharedSettings.deviceId = d?.id
        if let d { ResponseCache.store(d, key: "device") }
    }

    func forget() {
        device = nil
    }
}

extension PushManager: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let info = notification.request.content.userInfo
        let kind = info["kind"] as? String
        // A web sign-in request while the app is open: straight to the approval sheet.
        if (info["type"] as? String) == "web_login", let id = info["id"] as? String {
            await MainActor.run { AppModel.shared.openNotification(["type": "web_login", "id": id]) }
            return [.list]
        }
        await MainActor.run {
            if ["sale", "renewal", "conversion"].contains(kind ?? "") { AppModel.shared.newSale() }
            AppModel.shared.dataChanged()
        }
        return [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let payload = [
            "kind": info["kind"] as? String, "appId": info["appId"] as? String, "transactionId": info["transactionId"] as? String,
            "funnelId": info["funnelId"] as? String, "goalId": info["goalId"] as? String,
            "type": info["type"] as? String, "id": info["id"] as? String,
        ].compactMapValues { $0 }
        await MainActor.run { AppModel.shared.openNotification(payload) }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, openSettingsFor notification: UNNotification?) {
        Task { @MainActor in
            AppModel.shared.tab = .settings
            AppModel.shared.settingsPath = [.notifications]
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = PushManager.shared
        // Web sign-in requests: no actions on the notification (approving needs Face ID in the app).
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: "WEB_LOGIN", actions: [], intentIdentifiers: [], options: []),
        ])
        Task { @MainActor in
            if AppModel.shared.phase == .signedIn { await PushManager.shared.registerIfAuthorized() }
            LiveActivityManager.shared.observeExisting()
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in await PushManager.shared.didRegister(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in PushManager.shared.lastError = error.localizedDescription }
    }

    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        AppModel.shared.dataChanged()
        WidgetCenter.shared.reloadAllTimelines()
        completionHandler(.newData)
    }
}

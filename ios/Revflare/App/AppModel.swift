import ActivityKit
import Foundation
import LocalAuthentication
import Observation
import SwiftUI
import UIKit
import WidgetKit

enum AppTab: String, Hashable { case overview, charts, feed, apps, settings }

enum Route: Hashable {
    case app(id: String, name: String)
    case customer(id: String)
    case transaction(Transaction, currency: String)
    /// A push's `transactionId`: looked up, then shown.
    case transactionLookup(id: String)
    case notifications
    case goals
    /// One goal's detail (a goal push's `goalId`, `revflare://goals/<id>`).
    case goal(id: String)
    case atRisk
    case forecast
    case events(appId: String)
    case funnels(appId: String)
    case funnelReport(appId: String, funnel: Funnel)
    /// An alert's or push's `funnelId`: looked up, then the report is shown.
    case funnelLookup(appId: String, funnelId: String)
    /// Apple Ads attributed revenue of one app (campaign → ad group → keyword).
    case appleAds(appId: String)
}

@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    enum Phase: Equatable { case signedOut, signedIn }

    private(set) var phase: Phase
    private(set) var client: APIClient?
    private(set) var me: Me?
    var lastError: String?
    /// The server answered `503 { code: "quota" }` (Cloudflare Free plan daily database limit): until this time
    /// (the next 00:00 UTC) screens keep their cached data and one banner explains it instead of error messages.
    private(set) var quotaResetAt: Date?

    // Display settings (shared with the widgets).
    var privacyMode: Bool = SharedSettings.privacyMode {
        didSet {
            SharedSettings.privacyMode = privacyMode
            WidgetCenter.shared.reloadAllTimelines()
        }
    }
    var showProceeds: Bool = SharedSettings.showProceeds {
        didSet {
            SharedSettings.showProceeds = showProceeds
            WidgetCenter.shared.reloadAllTimelines()
        }
    }
    var faceIDLock: Bool = UserDefaults.standard.bool(forKey: "faceIDLock") {
        didSet { UserDefaults.standard.set(faceIDLock, forKey: "faceIDLock") }
    }
    var hapticsEnabled: Bool = UserDefaults.standard.object(forKey: "haptics") as? Bool ?? true {
        didSet { UserDefaults.standard.set(hapticsEnabled, forKey: "haptics") }
    }
    /// Apps the Overview is filtered to (empty = all).
    var overviewApps: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "overviewApps") ?? []) {
        didSet { UserDefaults.standard.set(Array(overviewApps), forKey: "overviewApps") }
    }
    /// Apps the Feed is filtered to (empty = all).
    var feedApps: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "feedApps") ?? []) {
        didSet { UserDefaults.standard.set(Array(feedApps), forKey: "feedApps") }
    }

    private(set) var isLocked: Bool
    var tab: AppTab = .overview
    var overviewPath: [Route] = []
    var feedPath: [Route] = []
    var appsPath: [Route] = []
    var settingsPath: [Route] = []
    var chartsPath: [Route] = []
    /// A metric the Charts tab should show (tapping a KPI card).
    var chartRequest: String?

    /// Bumped when the workspace changes or a push says there is new data: screens reload.
    private(set) var dataVersion = 0
    /// Bumped on each new sale seen while the app is open (haptics).
    private(set) var saleTick = 0

    /// Apps of the workspace (names/icons for filters and pickers).
    private(set) var apps: [RFApp] = []

    private init() {
        // Keychain items outlive the app: a reinstall starts signed out.
        if !UserDefaults.standard.bool(forKey: "launchedBefore") {
            UserDefaults.standard.set(true, forKey: "launchedBefore")
            Keychain.delete()
            SharedSettings.reset()
        }
        let creds = Keychain.load()
        phase = creds == nil ? .signedOut : .signedIn
        client = creds.map { APIClient(server: $0.server, token: $0.token, workspaceId: SharedSettings.workspaceId) }
        isLocked = UserDefaults.standard.bool(forKey: "faceIDLock") && creds != nil
        apps = ResponseCache.load(AppList.self, key: ResponseCache.key("apps"))?.items ?? []
        if let cachedMe = ResponseCache.load(Me.self, key: "me") { me = cachedMe }
    }

    var currency: String { me?.workspace?.currency ?? SharedSettings.currency }
    var workspace: WorkspaceSummary? { me?.workspace }
    var canManage: Bool { me?.can("manage") ?? false }
    var serverURL: URL? { client?.server }

    func appName(_ id: String) -> String? { apps.first { $0.id == id }?.name }
    func app(_ id: String) -> RFApp? { apps.first { $0.id == id } }
    /// The workspace has Google Play apps: apps and sales show their store.
    var hasAndroidApps: Bool { apps.contains { $0.isAndroid } }

    // MARK: Session

    func signIn(server: URL, email: String, password: String) async throws {
        let api = APIClient(server: server)
        let r = try await api.signIn(email: email, password: password, deviceName: Self.deviceName)
        completeSignIn(server: server, response: r)
    }

    func pair(server: URL, code: String) async throws {
        let api = APIClient(server: server)
        let r = try await api.pair(code: code, deviceName: Self.deviceName)
        completeSignIn(server: server, response: r)
    }

    private func completeSignIn(server: URL, response r: DeviceTokenResponse) {
        // Keep the address that just worked (the server-reported public URL may not be reachable from here).
        let base = server
        Keychain.save(StoredCredentials(server: base, token: r.token, userEmail: r.user.email))
        SharedSettings.workspaceId = r.workspace?.id
        SharedSettings.workspaceName = r.workspace?.name
        if let c = r.workspace?.currency { SharedSettings.currency = c }
        client = APIClient(server: base, token: r.token, workspaceId: r.workspace?.id)
        phase = .signedIn
        isLocked = false
        tab = .overview
        dataVersion += 1
        Task {
            await refreshMe()
            await refreshApps()
            await PushManager.shared.requestAuthorizationAndRegister()
        }
        WidgetCenter.shared.reloadAllTimelines()
    }

    func signOut() async {
        await LiveActivityManager.shared.endAll()
        if let client, let id = SharedSettings.deviceId { try? await client.deleteDevice(id) }
        try? await client?.signOut()
        signOutLocally()
    }

    func signOutLocally() {
        Keychain.delete()
        SharedSettings.reset()
        ResponseCache.clear()
        UserDefaults.standard.removeObject(forKey: "overviewApps")
        overviewApps = []
        UserDefaults.standard.removeObject(forKey: "feedApps")
        feedApps = []
        client = nil
        me = nil
        quotaResetAt = nil
        apps = []
        phase = .signedOut
        overviewPath = []; feedPath = []; appsPath = []; settingsPath = []; chartsPath = []
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Any 401 from the server ends the session. Returns the message to show, or nil when there is nothing to show
    /// (cancelled, signed out, or the database limit, which the quota banner explains once for every screen).
    func handle(_ error: Error) -> String? {
        if error is CancellationError { return nil }
        if let e = error as? APIError {
            if e == .unauthorized {
                signOutLocally()
                return nil
            }
            if e.isQuota {
                quotaHit()
                return nil
            }
        }
        return error.localizedDescription
    }

    func quotaHit() {
        let reset = APIError.quotaReset()
        if quotaResetAt != reset { quotaResetAt = reset }
    }

    /// A request went through: the limit is over (or was never hit).
    func serverAnswered() {
        if quotaResetAt != nil { quotaResetAt = nil }
    }

    /// Called at the reset time: clears the banner and reloads every screen.
    func quotaResetReached() {
        guard let reset = quotaResetAt, reset <= .now else { return }
        quotaResetAt = nil
        dataChanged()
    }

    func refreshMe() async {
        guard let client else { return }
        do {
            let me = try await client.me()
            serverAnswered()
            self.me = me
            ResponseCache.store(me, key: "me")
            if let ws = me.workspace {
                if SharedSettings.workspaceId != ws.id { SharedSettings.workspaceId = ws.id }
                SharedSettings.workspaceName = ws.name
                SharedSettings.currency = ws.currency
            }
        } catch {
            _ = handle(error)
        }
    }

    func refreshApps() async {
        guard let client else { return }
        if let list = try? await client.apps() {
            apps = list.items
            ResponseCache.store(list, key: ResponseCache.key("apps"))
            Task.detached { for app in list.items.prefix(60) { _ = await ResponseCache.icon(app.iconUrl) } }
        }
    }

    func switchWorkspace(_ ws: WorkspaceSummary) async {
        guard var client, ws.id != workspace?.id else { return }
        client.workspaceId = ws.id
        self.client = client
        SharedSettings.workspaceId = ws.id
        SharedSettings.workspaceName = ws.name
        SharedSettings.currency = ws.currency
        overviewApps = []
        feedApps = []
        apps = ResponseCache.load(AppList.self, key: ResponseCache.key("apps"))?.items ?? []
        overviewPath = []; feedPath = []; appsPath = []; chartsPath = []
        dataVersion += 1
        await refreshMe()
        await refreshApps()
        WidgetCenter.shared.reloadAllTimelines()
    }

    // MARK: Data signals

    func dataChanged() { dataVersion += 1 }

    func newSale() {
        saleTick += 1
    }

    // MARK: Lock

    func sceneBecameInactive() {
        if faceIDLock && phase == .signedIn { isLocked = true }
    }

    func unlock() async {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            isLocked = false
            return
        }
        do {
            let ok = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: String(localized: "Unlock your revenue dashboard"))
            if ok { isLocked = false }
        } catch {}
    }

    // MARK: Deep links

    func open(_ url: URL) {
        guard url.scheme == "revflare" else { return }
        let host = url.host() ?? ""
        let parts = url.pathComponents.filter { $0 != "/" }
        switch host {
        case "pair":
            pendingPair = PairRequest(url: url)
        case "web-login":
            pendingWebLogin = WebLoginRequest(url: url)
        case "overview", "today":
            tab = .overview
        case "charts":
            tab = .charts
            if let metric = parts.first { chartRequest = metric }
        case "feed":
            tab = .feed
        case "apps":
            tab = .apps
        case "settings":
            tab = .settings
            settingsPath = parts.first == "notifications" ? [.notifications] : []
        case "notifications":
            tab = .settings
            settingsPath = [.notifications]
        case "goals":
            tab = .overview
            overviewPath = parts.first.map { [.goals, .goal(id: $0)] } ?? [.goals]
        case "at-risk":
            tab = .overview
            overviewPath = [.atRisk]
        case "forecast":
            tab = .overview
            overviewPath = [.forecast]
        case "app":
            if let id = parts.first {
                tab = .apps
                appsPath = [.app(id: id, name: appName(id) ?? "")]
            }
        case "transaction":
            if let id = parts.first {
                tab = .feed
                feedPath = [.transactionLookup(id: id)]
            }
        case "customer":
            if let id = parts.first {
                tab = .feed
                feedPath = [.customer(id: id)]
            }
        default:
            break
        }
    }

    /// A `revflare://pair?server=...&code=...` link waiting to be used (onboarding signs in with it).
    struct PairRequest: Equatable {
        var server: URL
        var code: String

        init?(url: URL) {
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            guard let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty,
                  let server = items.first(where: { $0.name == "server" })?.value.flatMap(APIClient.normalizeServer)
            else { return nil }
            self.server = server
            self.code = code
        }
    }

    var pendingPair: PairRequest?

    /// A browser asking to be signed in by this device: from a `revflare://web-login?s=<server>&r=<id>&k=<nonce>` QR code
    /// (scanner or camera) or a `WEB_LOGIN` push (`id` only; it comes from the signed-in server).
    struct WebLoginRequest: Identifiable, Equatable {
        var id: String
        var nonce: String?
        /// The server named in the QR code; must be the one this app is signed in to.
        var server: URL?

        init(id: String, nonce: String? = nil, server: URL? = nil) {
            self.id = id
            self.nonce = nonce
            self.server = server
        }

        init?(url: URL) {
            guard url.scheme == "revflare", url.host() == "web-login" else { return nil }
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            func value(_ name: String) -> String? { items.first(where: { $0.name == name })?.value.flatMap { $0.isEmpty ? nil : $0 } }
            guard let id = value("r"), id.hasPrefix("wl_"), let nonce = value("k"),
                  let server = value("s").flatMap(APIClient.normalizeServer)
            else { return nil }
            self.init(id: id, nonce: nonce, server: server)
        }
    }

    var pendingWebLogin: WebLoginRequest?

    /// Same scheme, host and port (a QR code's server against the configured one).
    static func sameServer(_ a: URL, _ b: URL) -> Bool {
        func port(_ u: URL) -> Int? { u.port ?? (u.scheme?.lowercased() == "https" ? 443 : u.scheme?.lowercased() == "http" ? 80 : nil) }
        return a.scheme?.lowercased() == b.scheme?.lowercased() && a.host()?.lowercased() == b.host()?.lowercased() && port(a) == port(b)
    }

    /// A scanned code (Settings → Sign in on a computer): web sign-in requests and pairing codes. Returns an error to show.
    func handleScanned(_ code: String) -> String? {
        guard let url = URL(string: code) else { return String(localized: "This is not a Revflare sign-in code.") }
        if let request = WebLoginRequest(url: url) {
            pendingWebLogin = request
            return nil
        }
        if let pair = PairRequest(url: url) {
            pendingPair = pair
            return nil
        }
        return String(localized: "This is not a Revflare sign-in code.")
    }

    /// Notification tap: `kind`, `appId`, `transactionId` from the payload.
    func openNotification(_ info: [AnyHashable: Any]) {
        let kind = info["kind"] as? String
        let appId = info["appId"] as? String
        let transactionId = info["transactionId"] as? String
        if (info["type"] as? String) == "web_login" || kind == "web_login" {
            if let id = info["id"] as? String, id.hasPrefix("wl_") { pendingWebLogin = WebLoginRequest(id: id) }
            return
        }
        switch kind {
        case "sale", "renewal", "trial", "conversion", "refund":
            tab = .feed
            feedPath = transactionId.map { [.transactionLookup(id: $0)] } ?? []
        case "cancellation":
            if let appId {
                tab = .apps
                appsPath = [.app(id: appId, name: appName(appId) ?? "")]
            } else {
                tab = .feed
            }
        case "test":
            tab = .feed
        case "alert", "summary":
            tab = .overview
        case "goal":
            // A goal was reached: its detail, on top of the goals list.
            tab = .overview
            overviewPath = (info["goalId"] as? String).map { [.goals, .goal(id: $0)] } ?? [.goals]
        case "funnel":
            // Funnel anomaly / release regression: the funnel's report; events stopped: the app's events.
            tab = .overview
            if let appId, let funnelId = info["funnelId"] as? String {
                overviewPath = [.funnelLookup(appId: appId, funnelId: funnelId)]
            } else if let appId {
                overviewPath = [.events(appId: appId)]
            }
        default:
            tab = .overview
        }
        dataChanged()
    }

    static var deviceName: String {
        let model = UIDevice.current.model
        let name = UIDevice.current.name
        return name == model ? "Revflare · \(model)" : name
    }
}

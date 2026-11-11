import SwiftUI

@main
struct RevflareApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(PushManager.shared)
                .environment(LiveActivityManager.shared)
                .onOpenURL { model.open($0) }
                .tint(.brand)
                #if DEBUG
                // Simulator automation: `xcrun simctl launch booted <bundle id> -RFOpenURL revflare://feed`.
                .task {
                    if let s = UserDefaults.standard.string(forKey: "RFOpenURL"), let url = URL(string: s) { model.open(url) }
                    if UserDefaults.standard.bool(forKey: "RFStartLiveActivity") {
                        try? await Task.sleep(for: .seconds(2))
                        await LiveActivityManager.shared.start(overview: ResponseCache.load(OverviewCacheProbe.self, key: ResponseCache.key("overview", "all"))?.value)
                    }
                }
                #endif
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: model.sceneBecameInactive()
            case .active:
                SharedSettings.reload()
                if model.phase == .signedIn {
                    model.dataChanged()
                    Task {
                        await PushManager.shared.refreshAuthorization()
                        await PushManager.shared.syncWidgetToken()
                    }
                }
            default: break
            }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            switch model.phase {
            case .signedOut:
                OnboardingView()
                    .transition(.opacity)
            case .signedIn:
                MainTabView()
                    .redacted(reason: model.privacyMode ? .privacy : [])
                    .transition(.opacity)
            }
            if model.isLocked {
                LockView()
                    .transition(.opacity)
                    .zIndex(2)
            }
            // Hide amounts in the app switcher snapshot when the lock is on.
            if model.faceIDLock && scenePhase != .active && model.phase == .signedIn {
                Rectangle().fill(.background).ignoresSafeArea().overlay { BrandMark(size: 72) }.zIndex(3)
            }
        }
        .animation(.smooth, value: model.phase)
        .animation(.smooth, value: model.isLocked)
        .sheet(item: Binding(get: { model.phase == .signedIn ? model.pendingPair.map(PendingPair.init) : nil },
                             set: { if $0 == nil { model.pendingPair = nil } })) { pending in
            SwitchAccountSheet(request: pending.request)
        }
        // A browser asking to be signed in (QR code, camera link or push); not over the lock screen.
        .sheet(item: Binding(get: { model.phase == .signedIn && !model.isLocked ? model.pendingWebLogin : nil },
                             set: { if $0 == nil { model.pendingWebLogin = nil } })) { request in
            WebLoginSheet(request: request)
        }
    }
}

private struct PendingPair: Identifiable {
    var request: AppModel.PairRequest
    var id: String { request.code }
}

/// A pairing link opened while signed in: offer to sign in with it (replaces the current session).
private struct SwitchAccountSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var request: AppModel.PairRequest
    @State private var working = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "qrcode.viewfinder").font(.system(size: 48)).foregroundStyle(.tint)
            Text("Sign in with this pairing code?").font(.title3.bold()).multilineTextAlignment(.center)
            Text(request.server.host() ?? request.server.absoluteString).foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red).font(.footnote).multilineTextAlignment(.center) }
            Button {
                Task {
                    working = true
                    defer { working = false }
                    do {
                        await LiveActivityManager.shared.endAll()
                        try await model.pair(server: request.server, code: request.code)
                        model.pendingPair = nil
                        dismiss()
                    } catch {
                        self.error = error.localizedDescription
                    }
                }
            } label: {
                Text(working ? "Signing in…" : "Sign in").frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent)
            .controlSize(.large)
            .disabled(working)
            Button("Cancel", role: .cancel) { model.pendingPair = nil; dismiss() }
        }
        .padding(24)
        .presentationDetents([.medium])
    }
}

struct LockView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            Rectangle().fill(.background).ignoresSafeArea()
            VStack(spacing: 24) {
                BrandMark(size: 80)
                Text("Revflare is locked").font(.title2.bold())
                Button {
                    Task { await model.unlock() }
                } label: {
                    Label("Unlock", systemImage: "faceid").frame(minWidth: 160)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
            }
        }
        .task { await model.unlock() }
    }
}

struct MainTabView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.tab) {
            Tab("Overview", systemImage: "chart.bar.xaxis", value: AppTab.overview) {
                NavigationStack(path: $model.overviewPath) {
                    OverviewView().quotaBanner().routes()
                }
            }
            Tab("Charts", systemImage: "chart.xyaxis.line", value: AppTab.charts) {
                NavigationStack(path: $model.chartsPath) {
                    ChartsView().quotaBanner().routes()
                }
            }
            Tab("Feed", systemImage: "list.bullet.rectangle", value: AppTab.feed) {
                NavigationStack(path: $model.feedPath) {
                    FeedView().quotaBanner().routes()
                }
            }
            Tab("Apps", systemImage: "square.grid.2x2", value: AppTab.apps) {
                NavigationStack(path: $model.appsPath) {
                    AppsView().quotaBanner().routes()
                }
            }
            Tab("Settings", systemImage: "gearshape", value: AppTab.settings) {
                NavigationStack(path: $model.settingsPath) {
                    SettingsView().quotaBanner().routes()
                }
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .sensoryFeedback(.success, trigger: model.saleTick) { _, _ in model.hapticsEnabled }
        .task {
            await model.refreshMe()
            await model.refreshApps()
            await PushManager.shared.syncWidgetToken()
        }
    }
}

extension View {
    /// Destinations shared by every tab's navigation stack.
    func routes() -> some View {
        navigationDestination(for: Route.self) { route in
            Group {
                switch route {
            case let .app(id, name): AppDetailView(appId: id, initialName: name)
            case let .customer(id): CustomerView(customerId: id)
            case let .transaction(tx, currency): TransactionDetailView(transaction: tx, currency: currency)
            case let .transactionLookup(id): TransactionLookupView(transactionId: id)
            case .notifications: NotificationSettingsView()
            case .goals: GoalsView()
            case let .goal(id): GoalDetailView(goalId: id)
            case .atRisk: AtRiskView()
            case .forecast: ForecastView()
            case let .events(appId): EventsView(appId: appId)
            case let .funnels(appId): FunnelsView(appId: appId)
            case let .funnelReport(appId, funnel): FunnelReportView(appId: appId, funnel: funnel)
            case let .funnelLookup(appId, funnelId): FunnelLookupView(appId: appId, funnelId: funnelId)
            case let .appleAds(appId): AppleAdsView(appId: appId)
            }
            }
            .quotaBanner()
        }
    }
}

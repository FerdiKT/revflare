import LocalAuthentication
import SwiftUI
import UserNotifications

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(PushManager.self) private var push
    @Environment(LiveActivityManager.self) private var live
    @State private var confirmSignOut = false
    @State private var switching = false
    @State private var scanning = false
    @State private var scanned: String?
    @State private var scanError: String?

    var body: some View {
        @Bindable var model = model
        Form {
            Section {
                HStack(spacing: 14) {
                    BrandMark(size: 48)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.me?.user.name ?? "—").font(.headline)
                        Text(model.me?.user.email ?? Keychain.load()?.userEmail ?? "").font(.subheadline).foregroundStyle(.secondary)
                        Text(model.serverURL?.host() ?? "").font(.caption).foregroundStyle(.tertiary)
                    }
                }
                .padding(.vertical, 4)
            }

            Section {
                if let me = model.me, me.workspaces.count > 1 {
                    Picker(selection: Binding(get: { model.workspace?.id ?? "" }, set: { id in
                        guard let ws = me.workspaces.first(where: { $0.id == id }) else { return }
                        Task {
                            switching = true
                            await model.switchWorkspace(ws)
                            switching = false
                        }
                    })) {
                        ForEach(me.workspaces) { ws in Text(ws.name).tag(ws.id) }
                    } label: {
                        Label("Workspace", systemImage: "building.2")
                    }
                } else {
                    LabeledContent {
                        Text(model.workspace?.name ?? "—")
                    } label: {
                        Label("Workspace", systemImage: "building.2")
                    }
                }
                LabeledContent {
                    Text(currencyTitle)
                } label: {
                    Label("Currency", systemImage: "coloncurrencysign.circle")
                }
                if let role = model.workspace?.role {
                    LabeledContent {
                        Text(roleTitle(role))
                    } label: {
                        Label("Role", systemImage: "person.badge.key")
                    }
                }
            } header: {
                Text("Workspace")
            } footer: {
                if switching { ProgressView() } else { Text("The currency is set per workspace in the web app.") }
            }

            Section("Display") {
                Picker(selection: $model.showProceeds) {
                    Text("Gross revenue").tag(false)
                    Text("Net proceeds").tag(true)
                } label: {
                    Label("Amounts", systemImage: "dollarsign.circle")
                }
                Toggle(isOn: $model.privacyMode) {
                    Label("Privacy mode", systemImage: "eye.slash")
                }
                Toggle(isOn: $model.hapticsEnabled) {
                    Label("Haptics on new sales", systemImage: "iphone.radiowaves.left.and.right")
                }
                NavigationLink(value: Route.goals) {
                    Label("Goals", systemImage: "target")
                }
            }

            Section {
                NavigationLink(value: Route.notifications) {
                    HStack {
                        Label("Notifications", systemImage: "bell.badge")
                        Spacer()
                        Text(pushStatus).foregroundStyle(.secondary)
                    }
                }
                Toggle(isOn: Binding(get: { live.isRunning }, set: { on in
                    Task { if on { await live.start(overview: ResponseCache.load(OverviewCacheProbe.self, key: ResponseCache.key("overview", "all"))?.value) } else { await live.stop() } }
                })) {
                    Label("Pin today to the Dynamic Island", systemImage: "platter.filled.top.iphone")
                }
                if let error = live.lastError { Text(error).font(.footnote).foregroundStyle(.red) }
            } header: {
                Text("Live")
            } footer: {
                Text("Shows today's revenue on the Lock Screen and in the Dynamic Island, updated on every sale.")
            }

            Section {
                Toggle(isOn: Binding(get: { model.faceIDLock }, set: { on in
                    Task { await setLock(on) }
                })) {
                    Label(biometryTitle, systemImage: biometryIcon)
                }
            } header: {
                Text("Security")
            } footer: {
                Text("Asks for \(biometryName) when you open Revflare.")
            }

            Section {
                Button {
                    scanError = nil
                    scanning = true
                } label: {
                    Label("Sign in on a computer", systemImage: "qrcode.viewfinder")
                }
                if let scanError { Text(scanError).font(.footnote).foregroundStyle(.red) }
            } footer: {
                Text("On the Revflare sign-in page, choose Sign in with the iPhone app and scan the code.")
            }

            Section("About") {
                LabeledContent("App version", value: Self.appVersion)
                if let v = model.me?.version { LabeledContent("Server version", value: v) }
                if let url = model.serverURL {
                    Link(destination: url) {
                        Label("Open the web app", systemImage: "safari")
                    }
                }
            }

            Section {
                Button(role: .destructive) {
                    confirmSignOut = true
                } label: {
                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
        }
        .navigationTitle("Settings")
        .toolbarTitleDisplayMode(.inlineLarge)
        .sheet(isPresented: $scanning, onDismiss: {
            // After the scanner is gone: the approval (or pairing) sheet is presented from the root.
            if let code = scanned {
                scanned = nil
                scanError = model.handleScanned(code)
            }
        }) {
            QRScannerSheet(hint: "Point the camera at the QR code on the Revflare sign-in page.") { code in
                scanned = code
                scanning = false
            }
        }
        .confirmationDialog("Sign out of Revflare?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await model.signOut() } }
        } message: {
            Text("This device stops receiving notifications.")
        }
        .task { await push.refreshAuthorization() }
        .refreshable { await model.refreshMe() }
    }

    private var currencyTitle: String {
        let code = model.currency
        let name = Locale.current.localizedString(forCurrencyCode: code) ?? code
        return "\(name) (\(code))"
    }

    private func roleTitle(_ role: String) -> String {
        switch role {
        case "owner": String(localized: "Owner")
        case "admin": String(localized: "Admin")
        case "viewer": String(localized: "Viewer")
        default: role
        }
    }

    private var pushStatus: String {
        switch push.authorization {
        case .authorized, .provisional, .ephemeral: push.device == nil ? String(localized: "Registering…") : String(localized: "On")
        case .denied: String(localized: "Off")
        default: String(localized: "Not set up")
        }
    }

    private var biometryType: LABiometryType {
        let c = LAContext()
        _ = c.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        return c.biometryType
    }

    private var biometryName: String {
        switch biometryType {
        case .faceID: "Face ID"
        case .touchID: "Touch ID"
        case .opticID: "Optic ID"
        default: String(localized: "your passcode")
        }
    }

    private var biometryTitle: String {
        String(localized: "Lock with \(biometryName)")
    }

    private var biometryIcon: String {
        switch biometryType {
        case .touchID: "touchid"
        case .opticID: "opticid"
        default: "faceid"
        }
    }

    private func setLock(_ on: Bool) async {
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { return }
        let reason = on ? String(localized: "Turn on the lock") : String(localized: "Turn off the lock")
        if (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) == true {
            model.faceIDLock = on
        }
    }

    static var appVersion: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(v) (\(b))"
    }
}

/// Reads the cached overview written by `Loader` (value + timestamp).
struct OverviewCacheProbe: Codable {
    var value: Overview
    var at: Date
}

struct NotificationSettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(PushManager.self) private var push
    @State private var prefs = DevicePrefs()
    @State private var loaded = false
    @State private var testing = false
    @State private var testResult: String?
    @State private var saveTask: Task<Void, Never>?
    /// A change is waiting to be saved: the server's copy must not overwrite the local one.
    @State private var pending = false

    var body: some View {
        Form {
            switch push.authorization {
            case .denied:
                Section {
                    Label("Notifications are turned off for Revflare.", systemImage: "bell.slash")
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                    }
                }
            case .notDetermined:
                Section {
                    Button {
                        Task { await push.requestAuthorizationAndRegister() }
                    } label: {
                        Label("Turn on notifications", systemImage: "bell.badge")
                    }
                } footer: {
                    Text("Get a push for every sale, refund and alert, plus daily and weekly summaries.")
                }
            default:
                EmptyView()
            }

            if push.device == nil && (push.authorization == .authorized || push.authorization == .provisional) {
                Section {
                    HStack {
                        ProgressView()
                        Text("Registering this device…").foregroundStyle(.secondary)
                    }
                    if let error = push.lastError { Text(error).font(.footnote).foregroundStyle(.red) }
                }
            }

            if push.device != nil {
                Section {
                    Toggle(isOn: $prefs.sales) { Label("Sales", systemImage: "cart") }
                    Toggle(isOn: $prefs.renewals) { Label("Renewals", systemImage: "arrow.triangle.2.circlepath") }
                    Toggle(isOn: $prefs.trials) { Label("Trials", systemImage: "hourglass") }
                    Toggle(isOn: $prefs.refunds) { Label("Refunds", systemImage: "arrow.uturn.backward") }
                    Toggle(isOn: $prefs.cancellations) { Label("Cancellations", systemImage: "xmark.circle") }
                    Toggle(isOn: $prefs.alerts) { Label("Alerts", systemImage: "exclamationmark.triangle") }
                    Toggle(isOn: $prefs.funnelAlerts) { Label("Funnel alerts", systemImage: "chart.line.downtrend.xyaxis") }
                } header: {
                    Text("Events")
                } footer: {
                    Text("Funnel alerts: events stopped, funnel conversion drops and release regressions.")
                }
                Section {
                    ForEach(customizedApps) { app in
                        NavigationLink {
                            AppNotificationDetailView(app: app, prefs: $prefs)
                        } label: {
                            AppNotificationRow(app: app, prefs: prefs)
                        }
                    }
                    NavigationLink {
                        AppNotificationListView(prefs: $prefs)
                    } label: {
                        HStack {
                            Label(customizedApps.isEmpty ? LocalizedStringKey("Choose an app") : "All apps", systemImage: "square.grid.2x2")
                            Spacer()
                            if !model.apps.isEmpty { Text(Fmt.count(model.apps.filter { !$0.archived }.count)).foregroundStyle(.secondary) }
                        }
                    }
                } header: {
                    Text("Per app")
                } footer: {
                    Text("Mute an app, or turn single kinds off (or on) for it.")
                }
                Section("Summaries") {
                    Toggle(isOn: $prefs.dailySummary) { Label("Daily summary", systemImage: "sun.max") }
                    Toggle(isOn: $prefs.weeklySummary) { Label("Weekly summary", systemImage: "calendar") }
                }
                Section {
                    HStack {
                        Label("Minimum amount", systemImage: "dollarsign.circle")
                        Spacer()
                        TextField("0", value: $prefs.minUsd, format: .currency(code: "USD").precision(.fractionLength(0...2)))
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .frame(maxWidth: 110)
                    }
                } header: {
                    Text("Filters")
                } footer: {
                    Text("Sales below the minimum (in US dollars) do not notify.")
                }
                Section("Sound") {
                    Picker(selection: $prefs.sound) {
                        Text("Cash register").tag(DevicePrefs.Sound.cash)
                        Text("Default").tag(DevicePrefs.Sound.default)
                        Text("None").tag(DevicePrefs.Sound.none)
                    } label: {
                        Label("Sound", systemImage: "speaker.wave.2")
                    }
                    Toggle(isOn: quietHoursOn) { Label("Quiet hours", systemImage: "moon") }
                    if prefs.quietStart != nil {
                        DatePicker("From", selection: timeBinding(\.quietStart, default: "23:00"), displayedComponents: .hourAndMinute)
                        DatePicker("To", selection: timeBinding(\.quietEnd, default: "08:00"), displayedComponents: .hourAndMinute)
                    }
                }
                Section {
                    Button {
                        Task {
                            testing = true
                            defer { testing = false }
                            do {
                                try await push.sendTest()
                                testResult = String(localized: "Sent. It should arrive in a few seconds.")
                            } catch {
                                testResult = model.handle(error)
                            }
                        }
                    } label: {
                        HStack {
                            Label("Send a test notification", systemImage: "paperplane")
                            if testing { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(testing)
                    if let testResult { Text(testResult).font(.footnote).foregroundStyle(.secondary) }
                } footer: {
                    if let d = push.device {
                        Text("\(d.name ?? AppModel.deviceName) · \(d.environment)")
                    }
                }
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            // Also on coming back (e.g. an app muted from the Apps tab meanwhile), unless an edit is waiting.
            if let d = push.device, !pending {
                prefs = d.prefs
                loaded = true
            }
            migrateAllowlist()
        }
        .onChange(of: push.device?.id) {
            if let d = push.device, !loaded {
                prefs = d.prefs
                loaded = true
                migrateAllowlist()
            }
        }
        .onChange(of: model.apps.count) { migrateAllowlist() }
        .onChange(of: prefs) { _, new in
            guard loaded, new != push.device?.prefs else { return }
            saveTask?.cancel()
            pending = true
            saveTask = Task {
                try? await Task.sleep(for: .milliseconds(600))
                guard !Task.isCancelled else { return }
                var p = new
                p.timezone = TimeZone.current.identifier
                p.locale = Locale.preferredLanguages.first ?? Locale.current.identifier
                await push.update(p)
                if !Task.isCancelled { pending = false }
            }
        }
        .task { await push.refreshAuthorization() }
    }

    /// Apps whose notifications differ from the global toggles, listed right in the "Per app" section.
    private var customizedApps: [RFApp] {
        model.apps.filter { prefs.isCustomized($0.id) }.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    /// The old "Notify for" allowlist (`apps`) is replaced by per-app mutes: every app left out of it is muted,
    /// then `apps` is cleared. Waits for the app list, so no app is unmuted by mistake.
    private func migrateAllowlist() {
        guard loaded, let allow = prefs.apps, !model.apps.isEmpty else { return }
        let allowed = Set(allow)
        for app in model.apps where !allowed.contains(app.id) {
            prefs.editOverride(app.id) { $0.muted = true }
        }
        prefs.apps = nil
    }

    private var quietHoursOn: Binding<Bool> {
        Binding(get: { prefs.quietStart != nil && prefs.quietEnd != nil }, set: { on in
            prefs.quietStart = on ? "23:00" : nil
            prefs.quietEnd = on ? "08:00" : nil
        })
    }

    private func timeBinding(_ key: WritableKeyPath<DevicePrefs, String?>, default def: String) -> Binding<Date> {
        Binding(get: {
            let parts = (prefs[keyPath: key] ?? def).split(separator: ":").compactMap { Int($0) }
            return Calendar.current.date(bySettingHour: parts.first ?? 0, minute: parts.count > 1 ? parts[1] : 0, second: 0, of: Date()) ?? Date()
        }, set: { date in
            let c = Calendar.current.dateComponents([.hour, .minute], from: date)
            prefs[keyPath: key] = String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
        })
    }
}

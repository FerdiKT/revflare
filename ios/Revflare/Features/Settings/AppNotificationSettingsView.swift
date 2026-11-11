import SwiftUI

extension AppPushOverride.Kind {
    var title: String {
        switch self {
        case .sales: String(localized: "Sales")
        case .renewals: String(localized: "Renewals")
        case .trials: String(localized: "Trials")
        case .refunds: String(localized: "Refunds")
        case .cancellations: String(localized: "Cancellations")
        case .alerts: String(localized: "Alerts")
        case .funnelAlerts: String(localized: "Funnel alerts")
        }
    }

    var systemImage: String {
        switch self {
        case .sales: "cart"
        case .renewals: "arrow.triangle.2.circlepath"
        case .trials: "hourglass"
        case .refunds: "arrow.uturn.backward"
        case .cancellations: "xmark.circle"
        case .alerts: "exclamationmark.triangle"
        case .funnelAlerts: "chart.line.downtrend.xyaxis"
        }
    }
}

extension DevicePrefs {
    /// Short state of an app's notifications ("All on", "Muted", "Renewals off", "2 off"...), compared with the global toggles.
    func overrideSummary(_ id: String) -> String {
        if isMuted(id) { return String(localized: "Muted") }
        let kinds = AppPushOverride.Kind.allCases
        let off = kinds.filter { !isOn($0, app: id) && self[keyPath: $0.globalKeyPath] }
        let on = kinds.filter { isOn($0, app: id) && !self[keyPath: $0.globalKeyPath] }
        switch (off.count, on.count) {
        case (0, 0): return kinds.allSatisfy { isOn($0, app: id) } ? String(localized: "All on") : String(localized: "Default")
        case (1, 0): return String(localized: "\(off[0].title) off")
        case (_, 0): return String(localized: "\(off.count) off")
        case (0, 1): return String(localized: "\(on[0].title) on")
        case (0, _): return String(localized: "\(on.count) on")
        default: return String(localized: "Custom")
        }
    }

    /// Whether the app's notifications differ from the global toggles (shown in the "Per app" section).
    func isCustomized(_ id: String) -> Bool {
        isMuted(id) || AppPushOverride.Kind.allCases.contains { isOn($0, app: id) != self[keyPath: $0.globalKeyPath] }
    }
}

/// One app in the per-app lists: icon, name, short state.
struct AppNotificationRow: View {
    var app: RFApp
    var prefs: DevicePrefs

    var body: some View {
        HStack(spacing: 12) {
            AppIconView(url: app.iconUrl, name: app.name, size: 30)
                .opacity(prefs.isMuted(app.id) ? 0.5 : 1)
            Text(app.name).lineLimit(1)
            Spacer(minLength: 8)
            if prefs.isMuted(app.id) { Image(systemName: "bell.slash.fill").font(.caption).foregroundStyle(.secondary) }
            Text(prefs.overrideSummary(app.id)).foregroundStyle(.secondary).lineLimit(1)
        }
    }
}

/// Every app of the workspace with its notification state (searchable); tapping one opens its settings.
struct AppNotificationListView: View {
    @Environment(AppModel.self) private var model
    @Binding var prefs: DevicePrefs
    @State private var search = ""

    var body: some View {
        List {
            Section {
                ForEach(filtered) { app in
                    NavigationLink {
                        AppNotificationDetailView(app: app, prefs: $prefs)
                    } label: {
                        AppNotificationRow(app: app, prefs: prefs)
                    }
                    .swipeActions(edge: .trailing) {
                        let muted = prefs.isMuted(app.id)
                        Button {
                            prefs.editOverride(app.id) { $0.muted = muted ? nil : true }
                        } label: {
                            Label(muted ? LocalizedStringKey("Unmute") : "Mute", systemImage: muted ? "bell" : "bell.slash")
                        }
                        .tint(muted ? .accentColor : .orange)
                    }
                }
            } footer: {
                Text("A muted app sends no sale or event notifications. Daily and weekly summaries still come.")
            }
        }
        .searchable(text: $search, prompt: Text("Search apps"))
        .navigationTitle("Per app")
        .navigationBarTitleDisplayMode(.inline)
        .overlay {
            if model.apps.isEmpty { ProgressView() }
            else if filtered.isEmpty { ContentUnavailableView.search(text: search) }
        }
    }

    private var filtered: [RFApp] {
        let apps = model.apps.filter { !$0.archived || prefs.appOverrides[$0.id] != nil }
            .sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
        return search.isEmpty ? apps : apps.filter { $0.name.localizedCaseInsensitiveContains(search) }
    }
}

/// One app's notifications: mute, one toggle per kind (explicit values win over the global toggles), reset.
struct AppNotificationDetailView: View {
    var app: RFApp
    @Binding var prefs: DevicePrefs

    var body: some View {
        let muted = prefs.isMuted(app.id)
        Form {
            Section {
                HStack(spacing: 12) {
                    AppIconView(url: app.iconUrl, name: app.name, size: 44)
                    Text(app.name).font(.headline).lineLimit(2)
                }
                Toggle(isOn: Binding(get: { muted }, set: { on in prefs.editOverride(app.id) { $0.muted = on ? true : nil } })) {
                    Label("Mute this app", systemImage: "bell.slash")
                }
            } footer: {
                Text("A muted app sends no sale or event notifications. Daily and weekly summaries still come.")
            }
            Section {
                ForEach(AppPushOverride.Kind.allCases) { kind in
                    Toggle(isOn: binding(kind)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Label(kind.title, systemImage: kind.systemImage)
                            if prefs.appOverrides[app.id]?[kind] == nil {
                                Text("Default").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            } header: {
                Text("Events")
            } footer: {
                Text("A setting changed here wins over the global one for this app.")
            }
            .disabled(muted)
            .opacity(muted ? 0.5 : 1)
            Section {
                Button("Reset to defaults", role: .destructive) {
                    prefs.appOverrides[app.id] = nil
                }
                .disabled(prefs.appOverrides[app.id] == nil)
            }
        }
        .navigationTitle(app.name)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func binding(_ kind: AppPushOverride.Kind) -> Binding<Bool> {
        Binding(get: {
            prefs.appOverrides[app.id]?[kind] ?? prefs[keyPath: kind.globalKeyPath]
        }, set: { on in
            prefs.editOverride(app.id) { $0[kind] = on }
        })
    }
}

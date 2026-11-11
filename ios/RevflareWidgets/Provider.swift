import SwiftUI
import WidgetKit

struct SnapshotEntry: TimelineEntry {
    var date: Date
    var snapshot: WidgetSnapshot?
    var privacy: Bool = SharedSettings.privacyMode
    var net: Bool = SharedSettings.showProceeds
    var signedIn: Bool = true

    static let preview = SnapshotEntry(date: .now, snapshot: .preview, privacy: false, net: false)
}

private let refreshInterval: TimeInterval = 15 * 60

/// Timeline for widgets configured with an app (or all apps).
struct AppSnapshotProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry { .preview }

    func snapshot(for configuration: SelectAppIntent, in context: Context) async -> SnapshotEntry {
        if context.isPreview, Keychain.load() == nil { return .preview }
        return await entry(for: configuration)
    }

    func timeline(for configuration: SelectAppIntent, in context: Context) async -> Timeline<SnapshotEntry> {
        let entry = await entry(for: configuration)
        return Timeline(entries: [entry], policy: .after(WidgetData.nextRefresh(after: refreshInterval)))
    }

    private func entry(for configuration: SelectAppIntent) async -> SnapshotEntry {
        SharedSettings.reload()
        let snap = await WidgetData.load(appId: configuration.app?.id, appName: configuration.app?.name)
        return SnapshotEntry(date: .now, snapshot: snap, signedIn: Keychain.load() != nil)
    }
}

/// Timeline for widgets that always show the whole workspace.
struct WorkspaceProvider: TimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry { .preview }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (SnapshotEntry) -> Void) {
        if context.isPreview, Keychain.load() == nil { completion(.preview); return }
        Task { completion(await entry()) }
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<SnapshotEntry>) -> Void) {
        Task {
            let entry = await entry()
            completion(Timeline(entries: [entry], policy: .after(WidgetData.nextRefresh(after: refreshInterval))))
        }
    }

    private func entry() async -> SnapshotEntry {
        SharedSettings.reload()
        return SnapshotEntry(date: .now, snapshot: await WidgetData.load(appId: nil, appName: nil), signedIn: Keychain.load() != nil)
    }
}

/// WidgetKit push updates (iOS 26): the server can refresh widgets with `apns-push-type: widgets` pushes sent to
/// this token. Reported to the server right away when signed in (best effort); the app also checks it on launch,
/// on foreground and after the device registration.
struct RevflareWidgetPushHandler: WidgetPushHandler {
    init() {}

    func pushTokenDidChange(_ pushInfo: WidgetPushInfo, widgets: [WidgetInfo]) {
        let token = WidgetPushToken.hex(pushInfo.token)
        SharedSettings.widgetPushToken = token
        Task { try? await WidgetPushToken.report(token) }
    }
}

// MARK: - Shared widget views

extension WidgetSnapshot {
    func money(_ value: Double, _ entry: SnapshotEntry, compact: Bool = false) -> String {
        Fmt.money(value, currency, compact: compact, hide: entry.privacy)
    }
}

struct WidgetTitle: View {
    var title: LocalizedStringKey
    var subtitle: String?

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "chart.line.uptrend.xyaxis")
                .font(.caption2.weight(.bold))
                .foregroundStyle(Color.accentColor)
            Text(title).font(.caption.weight(.semibold))
            if let subtitle {
                Text("· \(subtitle)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
    }
}

/// No snapshot: signed out, or signed in but nothing cached yet (e.g. the server is over its daily limit).
struct SignedOutView: View {
    var signedIn = false

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: signedIn ? "clock" : "person.crop.circle.badge.questionmark").font(.title2).foregroundStyle(.secondary)
            Text(signedIn ? "Open Revflare to load your numbers" : "Open Revflare to sign in")
                .font(.caption).multilineTextAlignment(.center).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct WidgetAppIcon: View {
    var url: String?
    var name: String
    var size: CGFloat

    var body: some View {
        Group {
            if let data = ResponseCache.cachedIcon(url), let image = UIImage(data: data) {
                Image(uiImage: image).resizable()
            } else {
                ZStack {
                    Color.accentColor.opacity(0.8)
                    Text(String(name.prefix(1))).font(.system(size: size * 0.5, weight: .bold, design: .rounded)).foregroundStyle(.white)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.225, style: .continuous))
    }
}

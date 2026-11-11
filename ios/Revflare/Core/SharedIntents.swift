import AppIntents
import Foundation
import WidgetKit

/// An app of the workspace (`GET /apps`), for widget configuration, Siri and Shortcuts.
struct RevflareAppEntity: AppEntity, Identifiable, Hashable, Sendable {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = TypeDisplayRepresentation(name: "App")
    static let defaultQuery = RevflareAppQuery()

    var id: String
    var name: String

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct RevflareAppQuery: EntityStringQuery {
    func allApps() async throws -> [RevflareAppEntity] {
        let cacheKey = ResponseCache.key("apps")
        if let client = APIClient.current(), let list = try? await client.apps() {
            ResponseCache.store(list, key: cacheKey)
            return list.items.filter { !$0.archived }.map { RevflareAppEntity(id: $0.id, name: $0.name) }
        }
        let cached = ResponseCache.load(AppList.self, key: cacheKey)
        return (cached?.items ?? []).filter { !$0.archived }.map { RevflareAppEntity(id: $0.id, name: $0.name) }
    }

    func entities(for identifiers: [String]) async throws -> [RevflareAppEntity] {
        try await allApps().filter { identifiers.contains($0.id) }
    }

    func entities(matching string: String) async throws -> [RevflareAppEntity] {
        try await allApps().filter { $0.name.localizedCaseInsensitiveContains(string) }
    }

    func suggestedEntities() async throws -> [RevflareAppEntity] {
        try await allApps()
    }
}

/// Widget configuration: all apps or one.
struct SelectAppIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Choose app"
    static let description = IntentDescription("Show all apps or just one.")

    @Parameter(title: "App")
    var app: RevflareAppEntity?

    init() {}
    init(app: RevflareAppEntity?) { self.app = app }
}

/// Interactive widget button: shows the next app in the "App spotlight" widget.
struct NextSpotlightAppIntent: AppIntent {
    static let title: LocalizedStringResource = "Next app"
    static let isDiscoverable = false

    init() {}

    func perform() async throws -> some IntentResult {
        SharedSettings.spotlightIndex += 1
        WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.spotlight)
        return .result()
    }
}

/// Opens the app (Control Center control).
struct OpenRevflareIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Revflare"
    static let openAppWhenRun = true
    static let isDiscoverable = false

    init() {}

    func perform() async throws -> some IntentResult { .result() }
}

enum WidgetKinds {
    static let today = "\(AppIdentity.bundleID).today"
    static let mrr = "\(AppIdentity.bundleID).mrr"
    static let chart = "\(AppIdentity.bundleID).chart"
    static let spotlight = "\(AppIdentity.bundleID).spotlight"
    static let goal = "\(AppIdentity.bundleID).goal"
    static let control = "\(AppIdentity.bundleID).control.today"
}

import AppIntents
import Foundation

enum RevflareIntentError: Error, CustomLocalizedStringResourceConvertible {
    case signedOut
    case failed(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .signedOut: "Open Revflare and sign in first."
        case let .failed(message): "Revflare could not load your numbers: \(message)"
        }
    }
}

private func loadOverview(app: RevflareAppEntity?) async throws -> Overview {
    guard let client = APIClient.current() else { throw RevflareIntentError.signedOut }
    do {
        return try await client.overview(apps: app.map { [$0.id] } ?? [])
    } catch {
        throw RevflareIntentError.failed(error.localizedDescription)
    }
}

/// "How much did I make today?"
struct TodayRevenueIntent: AppIntent {
    static let title: LocalizedStringResource = "Today's revenue"
    static let description = IntentDescription("Tells you how much you made today, for all apps or one.")

    @Parameter(title: "App")
    var app: RevflareAppEntity?

    static var parameterSummary: some ParameterSummary {
        Summary("Today's revenue for \(\.$app)")
    }

    init() {}

    func perform() async throws -> some IntentResult & ReturnsValue<Double> & ProvidesDialog {
        let o = try await loadOverview(app: app)
        let net = SharedSettings.showProceeds
        let value = net ? o.today.proceeds : o.today.revenue
        let amount = Fmt.money(value, o.currency)
        let sales = o.today.sales
        if let name = app?.name {
            return .result(value: value, dialog: "\(name) made \(amount) today from \(sales) sales.")
        }
        return .result(value: value, dialog: "You made \(amount) today from \(sales) sales.")
    }
}

/// "What's my MRR?" (optionally for one app).
struct MRRIntent: AppIntent {
    static let title: LocalizedStringResource = "MRR"
    static let description = IntentDescription("Tells you the monthly recurring revenue, for all apps or one.")

    @Parameter(title: "App")
    var app: RevflareAppEntity?

    static var parameterSummary: some ParameterSummary {
        Summary("MRR of \(\.$app)")
    }

    init() {}

    func perform() async throws -> some IntentResult & ReturnsValue<Double> & ProvidesDialog {
        let o = try await loadOverview(app: app)
        let kpi = o.kpi("mrr")
        let value = kpi?.value ?? 0
        let amount = Fmt.money(value, o.currency)
        let subs = Int(o.kpi("active_subscriptions")?.value ?? 0)
        if let name = app?.name {
            return .result(value: value, dialog: "The MRR of \(name) is \(amount) with \(subs) active subscriptions.")
        }
        return .result(value: value, dialog: "Your MRR is \(amount) with \(subs) active subscriptions.")
    }
}

struct RevflareShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: TodayRevenueIntent(),
            phrases: [
                "How much did I make today in \(.applicationName)",
                "How much did I make today with \(.applicationName)",
                "Today's revenue in \(.applicationName)",
                "\(.applicationName) today",
                "How much did \(\.$app) make today in \(.applicationName)",
            ],
            shortTitle: "Today's revenue",
            systemImageName: "dollarsign.circle"
        )
        AppShortcut(
            intent: MRRIntent(),
            phrases: [
                "What's my MRR in \(.applicationName)",
                "\(.applicationName) MRR",
                "What's the MRR of \(\.$app) in \(.applicationName)",
            ],
            shortTitle: "MRR",
            systemImageName: "arrow.triangle.2.circlepath"
        )
    }
}

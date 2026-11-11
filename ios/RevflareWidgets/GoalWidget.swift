import SwiftUI
import WidgetKit

// MARK: - Goals

struct GoalWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: WidgetKinds.goal, intent: SelectAppIntent.self, provider: AppSnapshotProvider()) { entry in
            GoalWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(URL(string: entry.snapshot?.goal.map { "revflare://goals/\($0.id)" } ?? "revflare://goals"))
        }
        .configurationDisplayName("Goals")
        .description("Your goals and how close you are.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
        .pushHandler(RevflareWidgetPushHandler.self)
    }
}

struct GoalWidgetView: View {
    @Environment(\.widgetFamily) private var family
    var entry: SnapshotEntry

    var body: some View {
        if let s = entry.snapshot {
            let names = GoalAppNames.cached()
            if let g = s.goal {
                switch family {
                case .accessoryCircular:
                    Gauge(value: min(max(g.progress, 0), 1)) {
                        Image(systemName: "target")
                    } currentValueLabel: {
                        Text(Fmt.percent(min(g.progress, 9.99))).monospacedDigit()
                    }
                    .gaugeStyle(.accessoryCircularCapacity)
                    .widgetAccentable()
                    .containerBackground(for: .widget) { AccessoryWidgetBackground() }
                case .accessoryRectangular:
                    VStack(alignment: .leading, spacing: 2) {
                        Label(g.title(appName: names), systemImage: "target")
                            .font(.caption2.weight(.semibold))
                            .lineLimit(1)
                            .widgetAccentable()
                        Text("\(value(g, g.current, s)) / \(value(g, g.target, s))")
                            .font(.system(.headline, design: .rounded))
                            .minimumScaleFactor(0.6)
                            .lineLimit(1)
                            .privacySensitive()
                        Gauge(value: min(max(g.progress, 0), 1)) { EmptyView() }
                            .gaugeStyle(.accessoryLinearCapacity)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                case .systemMedium:
                    VStack(alignment: .leading, spacing: 8) {
                        WidgetTitle(title: "Goals", subtitle: s.appName)
                        ForEach((s.goals ?? [g]).prefix(3)) { goal in
                            Link(destination: URL(string: "revflare://goals/\(goal.id)")!) {
                                compactRow(goal, s, names: names)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                default:
                    VStack(alignment: .leading, spacing: 5) {
                        WidgetTitle(title: "Goal", subtitle: nil)
                        Text(g.title(appName: names)).font(.subheadline.weight(.semibold)).lineLimit(2)
                        Spacer(minLength: 0)
                        Text(Fmt.percent(min(g.progress, 9.99)))
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                            .foregroundStyle(g.isReached ? Color.green : Color.primary)
                            .minimumScaleFactor(0.5)
                            .lineLimit(1)
                        bar(g)
                        Text("\(value(g, g.current, s)) / \(value(g, g.target, s))")
                            .font(.caption.weight(.medium))
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                            .privacySensitive()
                        Text("\(GoalPace.title(g.paceValue)) · \(g.timeLeft)")
                            .font(.caption2)
                            .foregroundStyle(GoalPace.color(g.paceValue))
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                VStack(spacing: 6) {
                    Image(systemName: "target").font(.title2).foregroundStyle(.secondary)
                    Text("No goals yet").font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else {
            SignedOutView(signedIn: entry.signedIn)
        }
    }

    private func value(_ g: GoalProgress, _ v: Double, _ s: WidgetSnapshot) -> String {
        g.formatted(v, currency: s.currency, compact: true, hide: entry.privacy && g.isMoney)
    }

    private func bar(_ g: GoalProgress) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.accentColor.opacity(0.18))
                Capsule()
                    .fill(g.isReached ? Color.green : Color.accentColor)
                    .frame(width: max(6, geo.size.width * min(max(g.progress, 0), 1)))
            }
        }
        .frame(height: 6)
    }

    private func compactRow(_ g: GoalProgress, _ s: WidgetSnapshot, names: (String) -> String?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(g.title(appName: names)).font(.caption.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 4)
                Text("\(value(g, g.current, s)) / \(value(g, g.target, s))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .privacySensitive()
                Text(Fmt.percent(min(g.progress, 9.99)))
                    .font(.caption.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(g.isReached ? Color.green : Color.primary)
            }
            bar(g)
        }
    }
}

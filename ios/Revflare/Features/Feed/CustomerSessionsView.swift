import SwiftUI

/// What the customer did in the app lately (`Customer.activity`): their latest sessions, each as a flow of events.
struct CustomerSessionsSection: View {
    var activity: CustomerActivity
    @State private var showAll = false

    var body: some View {
        Section {
            if activity.sessions.isEmpty {
                Text("No events from their installs yet.").font(.subheadline).foregroundStyle(.secondary)
            } else {
                let shown = showAll ? activity.sessions : Array(activity.sessions.prefix(3))
                ForEach(shown) { s in SessionFlowRow(session: s) }
                if activity.sessions.count > shown.count {
                    Button(String(localized: "Show \(activity.sessions.count - shown.count) more")) { withAnimation { showAll = true } }
                }
            }
        } header: {
            Text("Recent activity")
        } footer: {
            Text(activity.source == "events"
                 ? String(localized: "Their latest sessions with every event, newest first.")
                 : String(localized: "Key events only (paywalls, purchases, onboarding). Set up event queries on the server to see app opens and screens."))
        }
    }
}

private struct SessionFlowRow: View {
    var session: CustomerSession

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(Fmt.dateTime(ms: session.startedAt)).font(.subheadline.weight(.semibold).monospacedDigit())
                Text(Fmt.date(ms: session.endedAt), format: .relative(presentation: .named)).font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                if let v = session.appVersion { Text("v\(v)").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                if let env = session.environment, env != "production" {
                    Text(env).font(.caption2.weight(.semibold)).padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.orange.opacity(0.15), in: Capsule()).foregroundStyle(.orange)
                }
            }
            FlowLayout(spacing: 4) {
                ForEach(Array(session.events.enumerated()), id: \.offset) { i, e in
                    HStack(spacing: 4) {
                        if i > 0 { Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold)).foregroundStyle(.tertiary) }
                        EventChip(event: e)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

private struct EventChip: View {
    var event: CustomerSessionEvent

    private var tint: Color {
        if event.name.hasPrefix("purchase_") || event.name.hasPrefix("restore_") { return .green }
        if event.name.hasPrefix("paywall_") { return .brand }
        if event.name.hasPrefix("onboarding_") { return .blue }
        return .secondary
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 3) {
                Text(event.name).font(.caption.weight(.semibold))
                if event.count > 1 { Text("×\(event.count)").font(.caption2).foregroundStyle(.secondary) }
            }
            if let d = event.detail { Text(d).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .foregroundStyle(tint == .secondary ? Color.primary : tint)
        .background((tint == .secondary ? Color.secondary : tint).opacity(0.12), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

/// Lays children out left to right, wrapping to new lines.
struct FlowLayout: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, maxX: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0 && x + s.width > width { x = 0; y += line + spacing; line = 0 }
            x += s.width + spacing
            line = max(line, s.height)
            maxX = max(maxX, x - spacing)
        }
        return CGSize(width: min(maxX, width), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX && x + s.width > bounds.maxX { x = bounds.minX; y += line + spacing; line = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            line = max(line, s.height)
        }
    }
}

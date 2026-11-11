import Charts
import SwiftUI

/// The Revflare mark: a coin crossed by the flare, cream on Cloudflare orange (same as the app icon).
struct BrandMark: View {
    var size: CGFloat = 56

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.25, style: .continuous)
            .fill(Color(red: 1, green: 0.314, blue: 0.039))
            .frame(width: size, height: size)
            .overlay { Image("BrandGlyph").resizable().scaledToFit() }
            .clipShape(RoundedRectangle(cornerRadius: size * 0.25, style: .continuous))
            .shadow(color: .black.opacity(0.15), radius: size * 0.08, y: size * 0.04)
            .accessibilityHidden(true)
    }
}

/// An amount that privacy mode hides (redaction with `.privacy`).
struct MoneyText: View {
    var value: Double
    var currency: String
    var compact = false

    var body: some View {
        Text(Fmt.money(value, currency, compact: compact))
            .monospacedDigit()
            .privacySensitive()
    }
}

/// A metric value: money is privacy-sensitive, counts and rates are not.
struct MetricValueText: View {
    var value: Double
    var format: String
    var currency: String
    var compact = false

    var body: some View {
        if format == "money" {
            MoneyText(value: value, currency: currency, compact: compact)
        } else {
            Text(Fmt.value(value, format: format, currency: currency, compact: compact)).monospacedDigit()
        }
    }
}

struct ChangePill: View {
    var change: Double?
    var lowerIsBetter = false

    var body: some View {
        if let change {
            HStack(spacing: 2) {
                Image(systemName: change >= 0 ? "arrow.up.right" : "arrow.down.right")
                    .font(.caption2.weight(.bold))
                Text(Fmt.change(change))
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
            }
            .foregroundStyle(changeColor(change, lowerIsBetter: lowerIsBetter))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(changeColor(change, lowerIsBetter: lowerIsBetter).opacity(0.12), in: Capsule())
            .accessibilityLabel(Text("Change \(Fmt.change(change))"))
        }
    }
}

struct Sparkline: View {
    var values: [Double]
    var color: Color = .brand
    var filled = true

    var body: some View {
        if values.count > 1 {
            let lo = values.min() ?? 0
            let hi = values.max() ?? 1
            Chart {
                ForEach(Array(values.enumerated()), id: \.offset) { i, v in
                    if filled {
                        AreaMark(x: .value("Day", i), yStart: .value("Base", lo), yEnd: .value("Value", v))
                            .foregroundStyle(LinearGradient(colors: [color.opacity(0.28), color.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                            .interpolationMethod(.monotone)
                    }
                    LineMark(x: .value("Day", i), y: .value("Value", v))
                        .foregroundStyle(color)
                        .lineStyle(StrokeStyle(lineWidth: 1.8, lineCap: .round))
                        .interpolationMethod(.monotone)
                }
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartLegend(.hidden)
            .chartYScale(domain: lo...(hi == lo ? lo + 1 : hi))
            .accessibilityHidden(true)
        } else {
            Color.clear
        }
    }
}

/// Grouped card background used across the dashboard.
struct CardModifier: ViewModifier {
    var padding: CGFloat = 16
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

extension View {
    func card(padding: CGFloat = 16) -> some View { modifier(CardModifier(padding: padding)) }
}

struct SectionHeader: View {
    var title: LocalizedStringKey
    var systemImage: String?

    var body: some View {
        HStack(spacing: 6) {
            if let systemImage { Image(systemName: systemImage).foregroundStyle(.secondary) }
            Text(title)
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityAddTraits(.isHeader)
    }
}

/// App icon from `iconUrl`, cached in the App Group (shared with the widgets).
struct AppIconView: View {
    var url: String?
    var name: String
    var size: CGFloat = 36

    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().interpolation(.high)
            } else {
                ZStack {
                    LinearGradient(colors: [.brand.opacity(0.85), .brand.opacity(0.55)], startPoint: .topLeading, endPoint: .bottomTrailing)
                    Text(String(name.prefix(1)).uppercased())
                        .font(.system(size: size * 0.45, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.225, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: size * 0.225, style: .continuous).strokeBorder(.primary.opacity(0.08), lineWidth: 0.5))
        .task(id: url) {
            if let data = ResponseCache.cachedIcon(url) { image = UIImage(data: data); return }
            if let data = await ResponseCache.icon(url) { image = UIImage(data: data) }
        }
        .accessibilityHidden(true)
    }
}

/// Goal progress ring.
struct ProgressRing: View {
    var progress: Double
    var lineWidth: CGFloat = 10
    var color: Color = .brand

    var body: some View {
        ZStack {
            Circle().stroke(color.opacity(0.15), lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: min(max(progress, 0), 1))
                .stroke(AngularGradient(colors: [color.opacity(0.7), color], center: .center), style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
            if progress > 1 {
                // Second lap when the goal is beaten.
                Circle()
                    .trim(from: 0, to: min(progress - 1, 1))
                    .stroke(Color.yellow, style: StrokeStyle(lineWidth: lineWidth * 0.55, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
        }
        .animation(.smooth(duration: 0.8), value: progress)
    }
}

struct ErrorBanner: View {
    var message: String
    var retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(message).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
            if let retry {
                Button("Retry", action: retry).font(.footnote.weight(.semibold))
            }
        }
        .padding(12)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// One calm notice for the whole app while the server is over its Cloudflare Free plan daily database limit
/// (`503 { code: "quota" }`): screens keep their cached data; everything reloads at the reset (00:00 UTC).
struct QuotaBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let reset = model.quotaResetAt {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                HStack(spacing: 10) {
                    Image(systemName: "moon.zzz.fill")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Server resting until \(reset.formatted(date: .omitted, time: .shortened))")
                            .font(.footnote.weight(.semibold))
                        Text("Daily database limit reached. Showing saved data; live numbers return in \(Self.remaining(until: reset, now: context.date)).")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .padding(.horizontal, 16)
                .padding(.bottom, 6)
                .accessibilityElement(children: .combine)
            }
            .task(id: reset) {
                let wait = reset.timeIntervalSinceNow
                if wait > 0 { try? await Task.sleep(for: .seconds(wait + 5)) }
                if !Task.isCancelled { model.quotaResetReached() }
            }
        }
    }

    /// "3 h 12 min" (never "0 min").
    static func remaining(until reset: Date, now: Date) -> String {
        let seconds = max(60, reset.timeIntervalSince(now).rounded(.up))
        let rounded = (seconds / 60).rounded(.up) * 60
        return Duration.seconds(rounded).formatted(.units(allowed: [.hours, .minutes], width: .abbreviated))
    }
}

extension View {
    /// Pins the `QuotaBanner` under the navigation bar while the server is over its daily limit.
    func quotaBanner() -> some View { modifier(QuotaBannerInset()) }
}

private struct QuotaBannerInset: ViewModifier {
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .top, spacing: 0) {
                if model.quotaResetAt != nil { QuotaBanner().padding(.top, 4).transition(.opacity) }
            }
            .animation(.smooth, value: model.quotaResetAt)
    }
}

/// "Updated 2 min ago" / offline hint under the header.
struct UpdatedLabel: View {
    var date: Date?
    var offline: Bool

    var body: some View {
        if let date {
            HStack(spacing: 4) {
                if offline { Image(systemName: "icloud.slash") }
                Text("Updated \(date, style: .relative)")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}

struct KindBadge: View {
    var kind: String
    var refunded = false

    var body: some View {
        Text(refunded ? String(localized: "Refund") : Self.title(kind))
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(refunded ? .red : Self.color(kind))
            .background((refunded ? Color.red : Self.color(kind)).opacity(0.13), in: Capsule())
    }

    static func title(_ kind: String) -> String {
        switch kind {
        case "trial": String(localized: "Trial")
        case "conversion": String(localized: "Conversion")
        case "new": String(localized: "New")
        case "renewal": String(localized: "Renewal")
        case "one_time": String(localized: "Purchase")
        case "cancellation": String(localized: "Cancelled")
        default: kind
        }
    }

    static func color(_ kind: String) -> Color {
        switch kind {
        case "trial": .purple
        case "conversion": .teal
        case "new": .green
        case "renewal": .blue
        case "one_time": .indigo
        case "cancellation": .red
        default: .gray
        }
    }
}

/// "⚡ 2 min": bought within 5 minutes of the install, or cancelled within 5 minutes of the purchase.
struct QuickChip: View {
    var ms: Double?
    var cancel = false

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "bolt.fill").accessibilityHidden(true)
            Text(ms.map { Fmt.duration(ms: $0) } ?? String(localized: "5 min"))
        }
        .font(.caption2.weight(.bold))
        .lineLimit(1)
        .padding(.horizontal, 6).padding(.vertical, 2)
        .foregroundStyle(cancel ? Color.red : Color.orange)
        .background((cancel ? Color.red : Color.orange).opacity(0.14), in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(cancel ? Text("Cancelled within 5 minutes") : Text("Bought within 5 minutes"))
    }
}

/// Multi-select app picker (Overview filter, notification filter).
struct AppPickerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var title: LocalizedStringKey
    @Binding var selection: Set<String>
    @State private var search = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        selection = []
                    } label: {
                        HStack {
                            Label("All apps", systemImage: "square.grid.2x2")
                            Spacer()
                            if selection.isEmpty { Image(systemName: "checkmark").foregroundStyle(.tint) }
                        }
                    }
                    .foregroundStyle(.primary)
                }
                Section {
                    ForEach(filtered) { app in
                        Button {
                            if selection.contains(app.id) { selection.remove(app.id) } else { selection.insert(app.id) }
                        } label: {
                            HStack(spacing: 12) {
                                AppIconView(url: app.iconUrl, name: app.name, size: 30)
                                Text(app.name).foregroundStyle(.primary)
                                Spacer()
                                if selection.contains(app.id) { Image(systemName: "checkmark").foregroundStyle(.tint) }
                            }
                        }
                    }
                }
            }
            .searchable(text: $search)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .overlay {
                if model.apps.isEmpty { ProgressView() }
            }
        }
    }

    private var filtered: [RFApp] {
        let apps = model.apps.filter { !$0.archived }
        return search.isEmpty ? apps : apps.filter { $0.name.localizedCaseInsensitiveContains(search) }
    }
}

/// Falling confetti for record days and beaten goals.
struct ConfettiView: View {
    var count = 70
    @State private var start = Date()

    private struct Piece {
        var x: Double, speed: Double, spin: Double, size: Double, hue: Double, delay: Double, drift: Double
    }

    @State private var pieces: [Piece] = (0..<70).map { _ in
        Piece(x: .random(in: 0...1), speed: .random(in: 160...320), spin: .random(in: -6...6), size: .random(in: 6...11),
              hue: [0.13, 0.36, 0.55, 0.0, 0.8].randomElement()!, delay: .random(in: 0...0.9), drift: .random(in: -40...40))
    }

    var body: some View {
        TimelineView(.animation) { timeline in
            Canvas { context, size in
                let t = timeline.date.timeIntervalSince(start)
                for p in pieces {
                    let time = t - p.delay
                    guard time > 0 else { continue }
                    let y = -20 + time * p.speed
                    guard y < size.height + 20 else { continue }
                    let x = p.x * size.width + sin(time * 2 + p.drift) * p.drift
                    var ctx = context
                    ctx.translateBy(x: x, y: y)
                    ctx.rotate(by: .radians(time * p.spin))
                    let rect = CGRect(x: -p.size / 2, y: -p.size / 4, width: p.size, height: p.size / 2)
                    ctx.fill(Path(roundedRect: rect, cornerRadius: 1.5), with: .color(Color(hue: p.hue, saturation: 0.8, brightness: 0.95)))
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

extension Double {
    var nonZero: Double? { self == 0 ? nil : self }
}

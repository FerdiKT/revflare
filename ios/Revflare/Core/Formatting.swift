import Foundation
import SwiftUI

/// Number, money and date formatting. Privacy mode replaces amounts with a mask (screen sharing).
enum Fmt {
    static let mask = "•••"

    /// "$1,234.56" — two decimals below 1,000, none above. The app hides amounts with `.privacySensitive()` +
    /// redaction; widgets pass `hide` (privacy mode).
    static func money(_ value: Double, _ currency: String, compact: Bool = false, hide: Bool = false) -> String {
        if hide { return mask }
        if compact, abs(value) >= 10_000 {
            return value.formatted(.currency(code: currency).notation(.compactName).precision(.significantDigits(1...3)))
        }
        let digits = abs(value) >= 1000 ? 0 : 2
        return value.formatted(.currency(code: currency).precision(.fractionLength(digits)))
    }

    static func count(_ value: Double, compact: Bool = false) -> String {
        if compact, abs(value) >= 10_000 { return value.formatted(.number.notation(.compactName).precision(.significantDigits(1...3))) }
        return value.formatted(.number.precision(.fractionLength(0...1)))
    }

    static func count(_ value: Int) -> String { value.formatted(.number) }

    static func percent(_ fraction: Double) -> String {
        fraction.formatted(.percent.precision(.fractionLength(0...1)))
    }

    static func value(_ value: Double, format: String, currency: String, compact: Bool = false, hide: Bool = false) -> String {
        switch format {
        case "money": money(value, currency, compact: compact, hide: hide)
        case "percent": percent(value)
        default: count(value, compact: compact)
        }
    }

    static func value(_ value: Double, format: MetricFormat, currency: String, compact: Bool = false, hide: Bool = false) -> String {
        Self.value(value, format: format.rawValue, currency: currency, compact: compact, hide: hide)
    }

    /// "+12%" / "−3%".
    static func change(_ change: Double) -> String {
        let pct = (change * 100)
        let text = abs(pct) >= 10 ? String(format: "%.0f%%", abs(pct)) : String(format: "%.1f%%", abs(pct))
        return (change >= 0 ? "+" : "−") + text
    }

    static func date(ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

    private static let dayParser: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// "2026-10-16" (UTC day) → Date at UTC midnight.
    static func day(_ s: String) -> Date? {
        if s.count == 7 { return dayParser.date(from: s + "-01") }
        return dayParser.date(from: String(s.prefix(10)))
    }

    static func dayLabel(_ s: String, interval: String = "day") -> String {
        guard let d = day(s) else { return s }
        var style = Date.FormatStyle(timeZone: TimeZone(identifier: "UTC")!)
        switch interval {
        case "month": style = style.month(.abbreviated).year()
        default: style = style.day().month(.abbreviated)
        }
        return d.formatted(style)
    }

    static func relative(ms: Double) -> String {
        date(ms: ms).formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }

    /// "30 Oct 2026 10:38" (local time zone; 12 / 24 hours by the locale).
    static func dateTime(ms: Double) -> String {
        date(ms: ms).formatted(date: .abbreviated, time: .shortened)
    }

    /// "Today 10:38" / "Yesterday 10:38" / "30 Oct 10:38" / "30 Oct 2025 10:38".
    static func shortDateTime(ms: Double) -> String {
        let d = date(ms: ms)
        let cal = Calendar.current
        let time = d.formatted(date: .omitted, time: .shortened)
        if cal.isDateInToday(d) { return String(localized: "Today, \(time)") }
        if cal.isDateInYesterday(d) { return String(localized: "Yesterday, \(time)") }
        if cal.isDate(d, equalTo: .now, toGranularity: .year) { return d.formatted(.dateTime.day().month(.abbreviated).hour().minute()) }
        return dateTime(ms: ms)
    }

    /// A duration by the locale: "2 min, 14 sec" / "2 dk. 14 sn.", "3 hr, 5 min", "4 days, 2 hr". Seconds only under 10 minutes.
    static func duration(ms: Double) -> String {
        let s = max(0, (ms / 1000).rounded())
        if s < 600 {
            return Duration.seconds(Int64(s)).formatted(.units(allowed: [.minutes, .seconds], width: .abbreviated, maximumUnitCount: 2))
        }
        let minutes = (s / 60).rounded() * 60
        return Duration.seconds(Int64(minutes)).formatted(.units(allowed: [.days, .hours, .minutes], width: .abbreviated, maximumUnitCount: 2))
    }

    static func flag(_ alpha2: String?) -> String {
        guard let code = alpha2?.uppercased(), code.count == 2 else { return "🌐" }
        var s = ""
        for scalar in code.unicodeScalars {
            guard let u = UnicodeScalar(127397 + scalar.value) else { return "🌐" }
            s.unicodeScalars.append(u)
        }
        return s
    }

    static func country(_ alpha2: String?) -> String {
        guard let code = alpha2 else { return String(localized: "Unknown") }
        return Locale.current.localizedString(forRegionCode: code) ?? code
    }

    /// ISO 8601 period ("P1M") → "Monthly".
    static func period(_ p: String?) -> String? {
        switch p {
        case "P1W": String(localized: "Weekly")
        case "P1M": String(localized: "Monthly")
        case "P2M": String(localized: "Every 2 months")
        case "P3M": String(localized: "Quarterly")
        case "P6M": String(localized: "Every 6 months")
        case "P1Y": String(localized: "Yearly")
        case "trial": String(localized: "Trial")
        case nil: nil
        default: p
        }
    }
}

extension Color {
    static let brand = Color("AccentColor")
    static let positive = Color.green
    static let negative = Color.red
}

/// Change pill colour: green when the metric moved the good way.
func changeColor(_ change: Double?, lowerIsBetter: Bool = false) -> Color {
    guard let change, abs(change) >= 0.0005 else { return .secondary }
    return (change > 0) != lowerIsBetter ? .positive : .negative
}

import SwiftUI

/// Small capsule on trials / purchases of installs attributed to Apple Ads (or Google Ads, Android); `test`: Apple's test payload.
struct AppleAdsBadge: View {
    var test = false
    /// Ads source: "apple_ads" | "google_ads".
    var source = "apple_ads"

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "megaphone.fill").font(.system(size: 8, weight: .bold)).accessibilityHidden(true)
            if source == "google_ads" {
                Text("Google Ads")
            } else {
                Text(test ? "Apple Ads · Test" : "Apple Ads")
            }
        }
        .font(.caption2.weight(.semibold))
        .lineLimit(1)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .foregroundStyle(color)
        .background(color.opacity(0.13), in: Capsule())
    }

    private var color: Color { test ? .orange : .blue }
}

/// "App Store" / "Google Play" capsule of an app or a sale (shown when the workspace has Android apps).
struct StoreBadge: View {
    var android: Bool

    var body: some View {
        Text(Store.title(android: android))
            .font(.caption2.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .foregroundStyle(android ? Color.green : Color.blue)
            .background((android ? Color.green : Color.blue).opacity(0.13), in: Capsule())
    }
}

/// "Test" capsule (Apple's AdServices test payload, sandbox / Xcode builds, test devices).
struct TestBadge: View {
    var body: some View {
        Text("Test")
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(.orange)
            .background(Color.orange.opacity(0.13), in: Capsule())
    }
}

/// Rows of an "Acquisition" section (customer, transaction): Apple Ads campaign / ad group / keyword, Google Ads,
/// referral (Android Play Install Referrer), organic or unknown.
/// Plain HStack rows: LabeledContent with a Label inside a List row left a tall empty gap on iOS 26.
struct AcquisitionRows: View {
    var attribution: AdsAttribution
    private var a: AdsAttribution { attribution }

    var body: some View {
        Group {
            switch a.source {
            case "apple_ads":
                line("Source") {
                    HStack(spacing: 6) {
                        if a.test { TestBadge() }
                        Image(systemName: "megaphone.fill").accessibilityHidden(true)
                        Text("Apple Ads")
                    }
                    .foregroundStyle(.blue)
                }
                if let label = AdsAttribution.label(name: a.campaignName, id: a.campaignId) { value("Campaign", label, named: a.campaignName) }
                if let label = AdsAttribution.label(name: a.adGroupName, id: a.adGroupId) { value("Ad group", label, named: a.adGroupName) }
                if let label = AdsAttribution.label(name: a.keywordName, id: a.keywordId) { value("Keyword", label, named: a.keywordName) }
            case "google_ads":
                line("Source") {
                    HStack(spacing: 6) {
                        Image(systemName: "megaphone.fill").accessibilityHidden(true)
                        Text("Google Ads")
                    }
                    .foregroundStyle(.blue)
                }
            case "referral":
                line("Source") {
                    HStack(spacing: 6) {
                        Image(systemName: "link").accessibilityHidden(true)
                        Text("Referral")
                    }
                    .foregroundStyle(.purple)
                }
            case "organic":
                line("Source") {
                    HStack(spacing: 6) {
                        Image(systemName: "leaf").accessibilityHidden(true)
                        Text("Organic")
                    }
                    .foregroundStyle(.green)
                }
            default:
                line("Source") {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("Unknown")
                        Text("No RevflareKit install linked").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func line<Content: View>(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title)
            Spacer(minLength: 8)
            content()
        }
    }

    private func value(_ title: LocalizedStringKey, _ label: String, named: String?) -> some View {
        line(title) {
            Text(label)
                .font(named?.isEmpty == false ? .body : .body.monospacedDigit())
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
                .textSelection(.enabled)
        }
    }
}

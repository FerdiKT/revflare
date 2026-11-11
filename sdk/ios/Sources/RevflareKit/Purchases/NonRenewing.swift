import Foundation
import CryptoKit

/// How long a non-renewing subscription (a pass: "Pro for 3 days") lasts after its purchase.
///
/// StoreKit gives non-renewing transactions no expiration date, so without a duration RevflareKit treats them like a
/// lifetime purchase. Set durations in Revflare (web → the app → Offerings → Entitlements, or
/// `revflare entitlements <app> duration <productId> 3d`) or locally with
/// ``Revflare/configurePurchases(productIds:entitlements:nonRenewingDurations:)`` (the local one wins for the same
/// product).
///
/// Durations only ever apply to **non-renewing subscriptions** (`Product.ProductType.nonRenewable`): non-consumables
/// are always lifetime, subscriptions use their own expiry. A duration set in Revflare is ignored for a product the app
/// declares itself (its product ids or entitlement map) unless the app also sets a local duration for it: a server
/// configuration never shortens access to the products the app shipped with.
///
/// The end is computed on the UTC calendar: a day is 24 hours, a week 7 days; months and years keep the day of the
/// month and the time, clamped to the month's last day (Jan 31 + 1 month = Feb 28 / 29). The Revflare server and the
/// Android SDK use the same rules.
public struct NonRenewingDuration: Sendable, Hashable, Codable, CustomStringConvertible {
    public enum Unit: String, Sendable, Hashable, Codable, CaseIterable {
        case day, week, month, year
    }

    public var unit: Unit
    /// Whole units, at least 1.
    public var count: Int

    public init(unit: Unit, count: Int) {
        self.unit = unit
        self.count = max(1, count)
    }

    public static func days(_ count: Int) -> NonRenewingDuration { .init(unit: .day, count: count) }
    public static func weeks(_ count: Int) -> NonRenewingDuration { .init(unit: .week, count: count) }
    public static func months(_ count: Int) -> NonRenewingDuration { .init(unit: .month, count: count) }
    public static func years(_ count: Int) -> NonRenewingDuration { .init(unit: .year, count: count) }

    public var description: String { "\(count) \(unit.rawValue)\(count == 1 ? "" : "s")" }

    private static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    /// The end of a pass that starts at `start`.
    public func end(from start: Date) -> Date {
        switch unit {
        case .day: return start.addingTimeInterval(TimeInterval(count) * 86_400)
        case .week: return start.addingTimeInterval(TimeInterval(count) * 7 * 86_400)
        case .month: return Self.calendar.date(byAdding: .month, value: count, to: start) ?? start
        case .year: return Self.calendar.date(byAdding: .year, value: count, to: start) ?? start
        }
    }

    private enum CodingKeys: String, CodingKey { case unit, count }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        unit = try container.decode(Unit.self, forKey: .unit)
        let count = try container.decode(Int.self, forKey: .count)
        guard count >= 1 else {
            throw DecodingError.dataCorruptedError(forKey: .count, in: container, debugDescription: "count must be >= 1")
        }
        self.count = count
    }
}

/// The entitlements and durations set in Revflare (inside `GET /sdk/v1/offerings`), kept on the device.
struct ServerEntitlements: Codable, Equatable, Sendable {
    var entitlements: [String: [String]] = [:]
    var durations: [String: NonRenewingDuration] = [:]

    var isEmpty: Bool { entitlements.isEmpty && durations.isEmpty }

    /// Product ids the server mapping and durations refer to, sorted.
    var productIds: [String] {
        Array(Set(entitlements.values.flatMap { $0 }).union(durations.keys)).sorted()
    }

    /// The UserDefaults key of the copy kept on the device, one per server + SDK key (a build pointed at another
    /// server or app never applies this one's map).
    static func storageKey(server: URL, sdkKey: String) -> String {
        let digest = SHA256.hash(data: Data("\(server.absoluteString)\n\(sdkKey)".utf8))
        return "app.revflare.kit.serverEntitlements." + digest.prefix(12).map { String(format: "%02x", $0) }.joined()
    }

    static func load(from store: KeyValueStore, key: String?) -> ServerEntitlements {
        guard let key, let data = store.data(forKey: key),
              let value = try? JSONDecoder().decode(ServerEntitlements.self, from: data) else { return ServerEntitlements() }
        return value
    }

    func save(to store: KeyValueStore, key: String?) {
        guard let key else { return }
        store.set(isEmpty ? nil : try? JSONEncoder().encode(self), forKey: key)
    }
}

/// Merge and expiry rules (pure, tested).
enum NonRenewingRules {
    /// The app's map plus the server's: union per entitlement. The app's map always applies (also offline).
    static func mergedMapping(local: EntitlementMapping, server: [String: [String]]) -> EntitlementMapping {
        var merged = local.entitlements
        for (name, ids) in server { merged[name, default: []].formUnion(ids) }
        return EntitlementMapping(merged)
    }

    /// The app's own durations plus the server's for products the app does **not** declare (`declared`: its product
    /// ids and entitlement map). A server duration never applies to a product the app shipped with unless the app sets
    /// a local duration for it too (then the local one applies): a mistake in Revflare (a duration on a lifetime
    /// product) can never take access away from those purchases.
    static func mergedDurations(local: [String: NonRenewingDuration], server: [String: NonRenewingDuration],
                                declared: Set<String> = []) -> [String: NonRenewingDuration] {
        server.filter { !declared.contains($0.key) }.merging(local) { _, local in local }
    }

    /// Gives non-renewing transactions of products with a duration their expiration date. Only `.nonRenewable`
    /// transactions: non-consumables are always lifetime, whatever the durations say.
    ///
    /// Repeat purchases of the same product **stack**: sorted by purchase date, each pass starts at the later of its
    /// purchase and the end of the previous one, and lasts the duration. Revoked (refunded) passes are left out of the
    /// chain (and give no access), so the passes bought after a refunded one start, and end, earlier. Transactions
    /// that already have an expiration date are kept as they are.
    static func applyingDurations(_ durations: [String: NonRenewingDuration],
                                  to transactions: [RevflareTransaction]) -> [RevflareTransaction] {
        guard !durations.isEmpty else { return transactions }
        var result = transactions
        var chains: [String: [Int]] = [:]
        for (index, transaction) in transactions.enumerated()
        where transaction.kind == .nonRenewable
            && transaction.expirationDate == nil && durations[transaction.productId] != nil {
            chains[transaction.productId, default: []].append(index)
        }
        for (productId, indices) in chains {
            guard let duration = durations[productId] else { continue }
            let ordered = indices.sorted {
                let a = transactions[$0], b = transactions[$1]
                return a.purchaseDate != b.purchaseDate ? a.purchaseDate < b.purchaseDate : a.id < b.id
            }
            var end: Date?
            for index in ordered {
                let transaction = transactions[index]
                if transaction.revocationDate != nil {
                    result[index].expirationDate = duration.end(from: transaction.purchaseDate)
                    continue
                }
                let start = max(transaction.purchaseDate, end ?? transaction.purchaseDate)
                let passEnd = duration.end(from: start)
                result[index].expirationDate = passEnd
                end = passEnd
            }
        }
        return result
    }
}

/// The cached pass history (``PassHistoryRules``).
struct PassHistoryCache: Equatable, Sendable {
    var productIds: Set<String>
    /// ``PassHistoryRules/anchors(productIds:current:)`` when it was loaded.
    var anchors: [String: UInt64]
    /// Non-revoked non-renewing transactions of `productIds` (`Transaction.all`).
    var transactions: [RevflareTransaction]
}

/// Keeps the cached pass history in line with `Transaction.currentEntitlements` (pure, tested).
///
/// `currentEntitlements` holds the latest transaction of each non-renewing product the customer still owns: it is the
/// cheap, always-current signal. The full history (`Transaction.all`, needed for stacking) is walked again only when
/// that signal changes, and a pass product's history counts only while `currentEntitlements` still has a transaction
/// of it (its anchor). So a pass whose transactions are gone (StoreKit testing "Delete transactions", a refund or
/// revocation whose `Transaction.updates` event never reached the app) stops granting on the next refresh.
///
/// Tradeoff: if StoreKit drops the refunded latest pass from `currentEntitlements` without showing an earlier one, the
/// earlier passes of that product (stacked time) stop counting too, until the next purchase of it.
enum PassHistoryRules {
    /// Pass product id → id of its latest non-revoked transaction in `current` (products without one are absent).
    static func anchors(productIds: Set<String>, current: [RevflareTransaction]) -> [String: UInt64] {
        var latest: [String: RevflareTransaction] = [:]
        for transaction in current
        where transaction.kind == .nonRenewable && transaction.revocationDate == nil && productIds.contains(transaction.productId) {
            if let existing = latest[transaction.productId],
               existing.purchaseDate > transaction.purchaseDate
                || (existing.purchaseDate == transaction.purchaseDate && existing.id > transaction.id) { continue }
            latest[transaction.productId] = transaction
        }
        return latest.mapValues(\.id)
    }

    /// The history that counts: non-revoked transactions of the anchored products only.
    static func counted(_ history: [RevflareTransaction], anchors: [String: UInt64]) -> [RevflareTransaction] {
        history.filter { $0.revocationDate == nil && anchors[$0.productId] != nil }
    }
}

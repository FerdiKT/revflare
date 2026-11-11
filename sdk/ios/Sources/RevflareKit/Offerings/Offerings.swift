import Foundation
import StoreKit

// MARK: JSON metadata

/// A JSON value: the free-form metadata of offerings and packages (titles, colors, layout keys...) set in Revflare.
///
/// ```swift
/// offering.metadata["title"]?.stringValue          // "Go Pro"
/// offering.metadata["features"]?.arrayValue        // [.string("No ads"), ...]
/// offering.metadata("theme", as: Theme.self)        // a Decodable of your own
/// try offering.decodeMetadata(PaywallConfig.self)   // the whole metadata object
/// ```
public enum RevflareJSON: Sendable, Hashable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([RevflareJSON])
    case object([String: RevflareJSON])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([RevflareJSON].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: RevflareJSON].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// The string, or nil when the value is not a string.
    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    /// The number, or nil when the value is not a number.
    public var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    /// The number as an `Int` when it is a whole number, else nil.
    public var intValue: Int? {
        guard case .number(let value) = self, value.rounded() == value, abs(value) < 9.0e15 else { return nil }
        return Int(value)
    }

    /// The boolean, or nil when the value is not a boolean.
    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    /// The array, or nil when the value is not an array.
    public var arrayValue: [RevflareJSON]? {
        if case .array(let value) = self { return value }
        return nil
    }

    /// The object, or nil when the value is not an object.
    public var objectValue: [String: RevflareJSON]? {
        if case .object(let value) = self { return value }
        return nil
    }

    public var isNull: Bool { self == .null }

    /// The value at `key` when this is an object.
    public subscript(key: String) -> RevflareJSON? { objectValue?[key] }

    /// The element at `index` when this is an array (nil when out of range).
    public subscript(index: Int) -> RevflareJSON? {
        guard let array = arrayValue, array.indices.contains(index) else { return nil }
        return array[index]
    }

    /// Decodes the value into a `Decodable` type of your own.
    public func decode<T: Decodable>(_ type: T.Type = T.self) throws -> T {
        let data = try JSONEncoder().encode(self)
        return try JSONDecoder().decode(T.self, from: data)
    }
}

extension RevflareJSON: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByFloatLiteral, ExpressibleByStringLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral {
    public init(nilLiteral: ()) { self = .null }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(stringLiteral value: String) { self = .string(value) }
    public init(arrayLiteral elements: RevflareJSON...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, RevflareJSON)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { first, _ in first }))
    }
}

/// Metadata helpers shared by offerings and packages.
public protocol RevflareMetadataContainer {
    var metadata: [String: RevflareJSON] { get }
}

extension RevflareMetadataContainer {
    /// The metadata value at `key` decoded as `T` (`String`, `Int`, `Bool`, `[String]`, a `Decodable` struct...), or
    /// nil when it is missing or has another shape.
    public func metadata<T: Decodable>(_ key: String, as type: T.Type = T.self) -> T? {
        guard let value = metadata[key] else { return nil }
        return try? value.decode(T.self)
    }

    /// The whole metadata object decoded as `T`.
    public func decodeMetadata<T: Decodable>(_ type: T.Type = T.self) throws -> T {
        try RevflareJSON.object(metadata).decode(T.self)
    }
}

// MARK: Public model

/// How ``Revflare/offerings(fetchPolicy:)`` gets the offerings.
public enum OfferingsFetchPolicy: Sendable, Equatable {
    /// Returns the offerings cached on the device at once when they are fresh (fetched or confirmed by the server in
    /// the last 5 minutes); otherwise asks the server. If the server can't be reached, falls back to the cached
    /// offerings (however old), else throws.
    case cachedOrFetched
    /// Always asks the server (a cheap 304 when nothing changed); falls back to the cached offerings when the server
    /// can't be reached.
    case fetchCurrent
}

/// Well-known package identifiers (any other string works too).
public enum RevflarePackageIdentifier {
    public static let weekly = "$weekly"
    public static let monthly = "$monthly"
    public static let twoMonth = "$two_month"
    public static let threeMonth = "$three_month"
    public static let sixMonth = "$six_month"
    public static let annual = "$annual"
    public static let lifetime = "$lifetime"
}

/// The offerings of the app, as set in Revflare (web → the app → Offerings, or `revflare offerings`).
public struct RevflareOfferings: Sendable, Equatable {
    /// The configuration's version (the server's ETag): changes whenever an offering or a placement changes.
    public let version: String
    /// The offering marked "current" in Revflare (nil when none is).
    public let current: RevflareOffering?
    /// Every offering, by identifier.
    public let all: [String: RevflareOffering]
    /// Every offering, in the server's order.
    public let ordered: [RevflareOffering]
    /// Placement → offering identifier (nil: the current offering).
    public let placements: [String: String?]
    /// Entitlement → product ids set in Revflare (web → the app → Offerings → Entitlements). ``RevflareStore`` adds
    /// them to the app's own map (union per entitlement). Empty from servers before Revflare 1.9.
    public let entitlements: [String: [String]]
    /// Durations of non-renewing products set in Revflare, by product id. ``RevflareStore`` uses them for passes
    /// (the app's own durations win for the same product).
    public let nonRenewingDurations: [String: NonRenewingDuration]

    /// The offering with this identifier.
    public subscript(identifier: String) -> RevflareOffering? { all[identifier] }

    /// The offering to show at a paywall location of the app ("onboarding", "settings"...). An unknown placement,
    /// a placement without an offering, or one pointing at an offering that no longer exists gives ``current``.
    public func offering(forPlacement placement: String) -> RevflareOffering? {
        OfferingRules.offeringId(forPlacement: placement, placements: placements, current: current?.identifier,
                                 available: Set(all.keys)).flatMap { all[$0] }
    }

    init(_ snapshot: OfferingsSnapshot<Product>) {
        version = snapshot.version
        placements = snapshot.placements
        entitlements = snapshot.entitlements
        nonRenewingDurations = snapshot.durations
        let ordered = snapshot.offerings.map(RevflareOffering.init)
        let all = Dictionary(ordered.map { ($0.identifier, $0) }, uniquingKeysWith: { first, _ in first })
        self.ordered = ordered
        self.all = all
        current = snapshot.currentOfferingId.flatMap { all[$0] }
    }
}

/// One offering: the packages (products) a paywall shows, in display order, with free-form metadata.
public struct RevflareOffering: Sendable, Equatable, Identifiable, RevflareMetadataContainer {
    public let identifier: String
    public let displayName: String
    /// Free-form JSON set in Revflare for the paywall (titles, colors, layout keys...).
    public let metadata: [String: RevflareJSON]
    /// The packages, in the server's order. Packages whose App Store product StoreKit can't load are left out.
    public let packages: [RevflarePackage]

    public var id: String { identifier }

    /// The first package with this identifier.
    public func package(identifier: String) -> RevflarePackage? { packages.first { $0.identifier == identifier } }

    /// The package that sells this product.
    public func package(productId: String) -> RevflarePackage? { packages.first { $0.product.id == productId } }

    public var weekly: RevflarePackage? { package(identifier: RevflarePackageIdentifier.weekly) }
    public var monthly: RevflarePackage? { package(identifier: RevflarePackageIdentifier.monthly) }
    public var twoMonth: RevflarePackage? { package(identifier: RevflarePackageIdentifier.twoMonth) }
    public var threeMonth: RevflarePackage? { package(identifier: RevflarePackageIdentifier.threeMonth) }
    public var sixMonth: RevflarePackage? { package(identifier: RevflarePackageIdentifier.sixMonth) }
    public var annual: RevflarePackage? { package(identifier: RevflarePackageIdentifier.annual) }
    public var lifetime: RevflarePackage? { package(identifier: RevflarePackageIdentifier.lifetime) }

    init(_ entry: OfferingEntry<Product>) {
        identifier = entry.identifier
        displayName = entry.displayName
        metadata = entry.metadata
        packages = entry.packages.map(RevflarePackage.init)
    }
}

/// A product as offered in an offering.
public struct RevflarePackage: Sendable, Equatable, Identifiable, RevflareMetadataContainer {
    /// `$annual`, `$weekly`... or a custom string.
    public let identifier: String
    /// The StoreKit 2 product (price: `product.displayPrice`; buy: `store.purchase(package)` or
    /// `product.purchase(options: Revflare.purchaseOptions)`).
    public let product: Product
    /// Free-form JSON set in Revflare for this package (badge, highlight...).
    public let metadata: [String: RevflareJSON]
    /// The offering the package belongs to.
    public let offeringIdentifier: String

    /// `offeringIdentifier/identifier`.
    public var id: String { "\(offeringIdentifier)/\(identifier)" }

    init(_ entry: PackageEntry<Product>) {
        identifier = entry.identifier
        product = entry.product
        metadata = entry.metadata
        offeringIdentifier = entry.offeringIdentifier
    }
}

// MARK: Rules (product-independent, tested with fake products)

enum OfferingRules {
    /// The offering id a placement resolves to: its own offering when set and present, else the current one.
    static func offeringId(forPlacement placement: String, placements: [String: String?], current: String?,
                           available: Set<String>) -> String? {
        if let mapped = placements[placement] ?? nil, available.contains(mapped) { return mapped }
        if let current, available.contains(current) { return current }
        return nil
    }
}

/// The offerings with each package's product resolved (StoreKit `Product` in the app, anything in tests).
struct OfferingsSnapshot<Item: Sendable>: Sendable {
    var version: String
    var currentOfferingId: String?
    var offerings: [OfferingEntry<Item>]
    var placements: [String: String?]
    var entitlements: [String: [String]]
    var durations: [String: NonRenewingDuration]
    /// Product ids of packages left out because no product was available, in server order (no duplicates).
    var droppedProductIds: [String]

    init(response: OfferingsResponse, products: [String: Item]) {
        version = response.version
        currentOfferingId = response.currentOfferingId
        placements = response.placements
        entitlements = response.entitlements
        durations = response.durations
        var dropped: [String] = []
        offerings = response.offerings.map { offering in
            var packages: [PackageEntry<Item>] = []
            for package in offering.packages {
                guard let product = products[package.productId] else {
                    if !dropped.contains(package.productId) { dropped.append(package.productId) }
                    continue
                }
                packages.append(PackageEntry(identifier: package.identifier, productId: package.productId,
                                             metadata: package.metadata, offeringIdentifier: offering.identifier,
                                             product: product))
            }
            return OfferingEntry(identifier: offering.identifier, displayName: offering.displayName,
                                 metadata: offering.metadata, packages: packages)
        }
        droppedProductIds = dropped
    }

    var current: OfferingEntry<Item>? { currentOfferingId.flatMap(offering(identifier:)) }

    func offering(identifier: String) -> OfferingEntry<Item>? { offerings.first { $0.identifier == identifier } }

    func offering(forPlacement placement: String) -> OfferingEntry<Item>? {
        OfferingRules.offeringId(forPlacement: placement, placements: placements, current: currentOfferingId,
                                 available: Set(offerings.map(\.identifier))).flatMap(offering(identifier:))
    }
}

struct OfferingEntry<Item: Sendable>: Sendable {
    var identifier: String
    var displayName: String
    var metadata: [String: RevflareJSON]
    var packages: [PackageEntry<Item>]

    func package(identifier: String) -> PackageEntry<Item>? { packages.first { $0.identifier == identifier } }
}

struct PackageEntry<Item: Sendable>: Sendable {
    var identifier: String
    var productId: String
    var metadata: [String: RevflareJSON]
    var offeringIdentifier: String
    var product: Item
}

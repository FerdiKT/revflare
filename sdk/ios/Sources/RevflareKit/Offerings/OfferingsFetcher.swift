import Foundation
import CryptoKit
import StoreKit

/// Errors thrown by ``Revflare/offerings(fetchPolicy:)``.
public enum RevflareOfferingsError: LocalizedError, Equatable {
    /// ``Revflare/configure(sdkKey:server:)`` was not called yet.
    case notConfigured
    /// The server does not know the SDK key (404).
    case unknownSDKKey
    /// The server answered with an unexpected HTTP status.
    case server(status: Int)
    /// The server could not be reached.
    case network(String)
    /// The server's answer could not be read.
    case invalidResponse(String)
    /// StoreKit could not load the offerings' products.
    case productsUnavailable(String)

    public var errorDescription: String? {
        switch self {
        case .notConfigured: return "RevflareKit is not configured: call Revflare.configure(sdkKey:server:) first."
        case .unknownSDKKey: return "The Revflare server does not know this SDK key."
        case .server(let status): return "The Revflare server answered HTTP \(status)."
        case .network(let message): return "The Revflare server could not be reached (\(message))."
        case .invalidResponse(let message): return "The offerings could not be read (\(message))."
        case .productsUnavailable(let message): return "The App Store products could not be loaded (\(message))."
        }
    }
}

// MARK: Wire format (`GET /sdk/v1/offerings`)

struct OfferingsResponse: Decodable, Equatable, Sendable {
    var version: String
    var currentOfferingId: String?
    var offerings: [OfferingPayload]
    /// Placement → offering id; nil means the current offering.
    var placements: [String: String?]
    /// Server-driven entitlements (Revflare 1.9+ servers; empty from older ones): entitlement → product ids.
    var entitlements: [String: [String]]
    /// Durations of non-renewing products (`products.<id>.duration`; empty from older servers).
    var durations: [String: NonRenewingDuration]

    private enum CodingKeys: String, CodingKey { case version, currentOfferingId, offerings, placements, entitlements, products }

    init(version: String, currentOfferingId: String?, offerings: [OfferingPayload], placements: [String: String?],
         entitlements: [String: [String]] = [:], durations: [String: NonRenewingDuration] = [:]) {
        self.version = version
        self.currentOfferingId = currentOfferingId
        self.offerings = offerings
        self.placements = placements
        self.entitlements = entitlements
        self.durations = durations
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decodeIfPresent(String.self, forKey: .version) ?? ""
        currentOfferingId = try container.decodeIfPresent(String.self, forKey: .currentOfferingId)
        // One malformed offering does not hide the others.
        offerings = (try container.decodeIfPresent([Lossy<OfferingPayload>].self, forKey: .offerings) ?? [])
            .compactMap(\.value)
        placements = (try? container.decodeIfPresent([String: String?].self, forKey: .placements)) ?? [:]
        // Lenient: a malformed entry is left out, the rest is used.
        let rawEntitlements = (try? container.decodeIfPresent([String: Lossy<[String]>].self, forKey: .entitlements)) ?? [:]
        entitlements = rawEntitlements.compactMapValues(\.value)
        let rawProducts = (try? container.decodeIfPresent([String: Lossy<ProductPayload>].self, forKey: .products)) ?? [:]
        durations = rawProducts.compactMapValues { $0.value?.duration }
    }

    /// What the store merges with the app's own map.
    var serverEntitlements: ServerEntitlements { ServerEntitlements(entitlements: entitlements, durations: durations) }

    /// Every product id of every package, in server order, without duplicates.
    var productIds: [String] {
        var seen = Set<String>()
        return offerings.flatMap(\.packages).map(\.productId).filter { seen.insert($0).inserted }
    }
}

struct OfferingPayload: Decodable, Equatable, Sendable {
    var identifier: String
    var displayName: String
    var metadata: [String: RevflareJSON]
    var packages: [PackagePayload]

    private enum CodingKeys: String, CodingKey { case identifier, displayName, metadata, packages }

    init(identifier: String, displayName: String, metadata: [String: RevflareJSON] = [:], packages: [PackagePayload]) {
        self.identifier = identifier
        self.displayName = displayName
        self.metadata = metadata
        self.packages = packages
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        identifier = try container.decode(String.self, forKey: .identifier)
        displayName = try container.decodeIfPresent(String.self, forKey: .displayName) ?? identifier
        metadata = (try? container.decodeIfPresent([String: RevflareJSON].self, forKey: .metadata)) ?? [:]
        packages = (try container.decodeIfPresent([Lossy<PackagePayload>].self, forKey: .packages) ?? [])
            .compactMap(\.value)
    }
}

struct PackagePayload: Decodable, Equatable, Sendable {
    var identifier: String
    var productId: String
    var metadata: [String: RevflareJSON]

    private enum CodingKeys: String, CodingKey { case identifier, productId, metadata }

    init(identifier: String, productId: String, metadata: [String: RevflareJSON] = [:]) {
        self.identifier = identifier
        self.productId = productId
        self.metadata = metadata
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        identifier = try container.decode(String.self, forKey: .identifier)
        productId = try container.decode(String.self, forKey: .productId)
        metadata = (try? container.decodeIfPresent([String: RevflareJSON].self, forKey: .metadata)) ?? [:]
    }
}

/// Settings of a product (`products.<id>`): the duration of a non-renewing product.
struct ProductPayload: Decodable, Equatable, Sendable {
    var duration: NonRenewingDuration?

    private enum CodingKeys: String, CodingKey { case duration }

    init(duration: NonRenewingDuration?) { self.duration = duration }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        duration = try? container.decodeIfPresent(NonRenewingDuration.self, forKey: .duration)
    }
}

/// Decodes an element, or nil when it is malformed.
private struct Lossy<Value: Decodable>: Decodable {
    let value: Value?
    init(from decoder: Decoder) throws { value = try? Value(from: decoder) }
}

// MARK: Fetching and caching

/// The last good answer, kept on the device (one UserDefaults entry per server + SDK key).
struct CachedOfferings: Codable, Equatable, Sendable {
    var etag: String?
    /// When the server last sent or confirmed (304) this answer.
    var fetchedAt: Date
    /// The app version the answer was fetched for (the server may target app versions).
    var appVersion: String?
    /// The raw JSON body.
    var body: Data
}

extension ReportClient {
    /// `GET /sdk/v1/offerings`.
    func offeringsRequest(etag: String?, appVersion: String?) -> URLRequest {
        var url = self.url(.offerings)
        if let appVersion, !appVersion.isEmpty,
           var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.queryItems = [URLQueryItem(name: "appVersion", value: appVersion)]
            url = components.url ?? url
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(sdkKey, forHTTPHeaderField: "X-Revflare-Key")
        request.setValue("RevflareKit/\(Revflare.version)", forHTTPHeaderField: "User-Agent")
        if let etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        return request
    }
}

/// Fetches the offerings configuration, keeps the last good answer on disk and revalidates it with its ETag.
/// Concurrent requests share one network call.
actor OfferingsFetcher {
    /// A cached answer younger than this is used without asking the server (``OfferingsFetchPolicy/cachedOrFetched``).
    static let maxAge: TimeInterval = 5 * 60

    private let client: ReportClient
    private let store: KeyValueStore
    private let appVersion: String?
    private let now: @Sendable () -> Date
    let cacheKey: String

    private var cache: (entry: CachedOfferings, response: OfferingsResponse)?
    private var loadedFromDisk = false
    private var inFlight: Task<OfferingsResponse, Error>?

    init(client: ReportClient, store: KeyValueStore, appVersion: String?, now: @escaping @Sendable () -> Date = { Date() }) {
        self.client = client
        self.store = store
        self.appVersion = appVersion
        self.now = now
        cacheKey = Self.cacheKey(server: client.server, sdkKey: client.sdkKey)
    }

    static func cacheKey(server: URL, sdkKey: String) -> String {
        let digest = SHA256.hash(data: Data("\(server.absoluteString)\n\(sdkKey)".utf8))
        return "app.revflare.kit.offerings." + digest.prefix(12).map { String(format: "%02x", $0) }.joined()
    }

    func offerings(policy: OfferingsFetchPolicy) async throws -> OfferingsResponse {
        if policy == .cachedOrFetched, let cached = loadCache(), isFresh(cached.entry) {
            return cached.response
        }
        if let inFlight { return try await inFlight.value }
        let task = Task { try await self.fetchOrFallBack() }
        inFlight = task
        defer { inFlight = nil }
        return try await task.value
    }

    /// The cached answer, if any (for diagnostics and tests).
    var cachedEntry: CachedOfferings? { loadCache()?.entry }

    private func isFresh(_ entry: CachedOfferings) -> Bool {
        let age = now().timeIntervalSince(entry.fetchedAt)
        return age >= 0 && age < Self.maxAge && entry.appVersion == appVersion
    }

    private func fetchOrFallBack() async throws -> OfferingsResponse {
        let cached = loadCache()
        do {
            return try await fetch(cached: cached)
        } catch {
            guard let cached else { throw error }
            Log.debug("Offerings: \(error.localizedDescription) Using the cached offerings (version \(cached.response.version)).")
            return cached.response
        }
    }

    private func fetch(cached: (entry: CachedOfferings, response: OfferingsResponse)?) async throws -> OfferingsResponse {
        let request = client.offeringsRequest(etag: cached?.entry.etag, appVersion: appVersion)
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await client.transport.send(request)
        } catch {
            throw RevflareOfferingsError.network(String(describing: error))
        }
        switch response.statusCode {
        case 200..<300:
            let decoded: OfferingsResponse
            do {
                decoded = try JSONDecoder().decode(OfferingsResponse.self, from: data)
            } catch {
                throw RevflareOfferingsError.invalidResponse(String(describing: error))
            }
            let etag = response.value(forHTTPHeaderField: "ETag") ?? (decoded.version.isEmpty ? nil : "\"\(decoded.version)\"")
            save(CachedOfferings(etag: etag, fetchedAt: now(), appVersion: appVersion, body: data), response: decoded)
            Log.debug("Offerings: version \(decoded.version), \(decoded.offerings.count) offering(s)")
            return decoded
        case 304:
            guard let cached else { throw RevflareOfferingsError.invalidResponse("304 without a cached answer") }
            var entry = cached.entry
            entry.fetchedAt = now()
            entry.appVersion = appVersion
            save(entry, response: cached.response)
            Log.debug("Offerings: unchanged (version \(cached.response.version))")
            return cached.response
        case 404:
            Log.error("Offerings: the Revflare server does not know this SDK key (404). Check Revflare.configure(sdkKey:).")
            throw RevflareOfferingsError.unknownSDKKey
        default:
            throw RevflareOfferingsError.server(status: response.statusCode)
        }
    }

    private func loadCache() -> (entry: CachedOfferings, response: OfferingsResponse)? {
        if !loadedFromDisk {
            loadedFromDisk = true
            if cache == nil,
               let data = store.data(forKey: cacheKey),
               let entry = try? JSONDecoder().decode(CachedOfferings.self, from: data),
               let response = try? JSONDecoder().decode(OfferingsResponse.self, from: entry.body) {
                cache = (entry, response)
            }
        }
        return cache
    }

    private func save(_ entry: CachedOfferings, response: OfferingsResponse) {
        cache = (entry, response)
        loadedFromDisk = true
        if let data = try? JSONEncoder().encode(entry) { store.set(data, forKey: cacheKey) }
    }
}

// MARK: Products

/// Loads App Store products by id (StoreKit in the app, a fake in tests).
protocol ProductCatalog: Sendable {
    associatedtype Item: Sendable
    /// The products StoreKit knows, by product id (unknown ids are left out).
    func products(for ids: Set<String>) async throws -> [String: Item]
}

struct StoreKitProductCatalog: ProductCatalog {
    func products(for ids: Set<String>) async throws -> [String: Product] {
        let loaded = try await Product.products(for: ids)
        return Dictionary(loaded.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }
}

/// Fetches the offerings and resolves their products: one catalog call per fetch for the products not loaded yet;
/// loaded products are kept in memory.
actor OfferingsService<Catalog: ProductCatalog> {
    let fetcher: OfferingsFetcher
    private let catalog: Catalog
    private var products: [String: Catalog.Item] = [:]
    private var reportedMissing: Set<String> = []

    init(fetcher: OfferingsFetcher, catalog: Catalog) {
        self.fetcher = fetcher
        self.catalog = catalog
    }

    func offerings(policy: OfferingsFetchPolicy) async throws -> OfferingsSnapshot<Catalog.Item> {
        let response = try await fetcher.offerings(policy: policy)
        let needed = Set(response.productIds)
        let missing = needed.subtracting(products.keys)
        if !missing.isEmpty {
            do {
                let loaded = try await catalog.products(for: missing)
                products.merge(loaded) { _, new in new }
            } catch {
                // Nothing to show at all: say why. Otherwise show the packages already loaded.
                if needed.isDisjoint(with: products.keys) {
                    throw RevflareOfferingsError.productsUnavailable(String(describing: error))
                }
                Log.debug("Offerings: some products failed to load: \(error)")
            }
        }
        let snapshot = OfferingsSnapshot(response: response, products: products)
        let newlyMissing = snapshot.droppedProductIds.filter { !reportedMissing.contains($0) }
        if !newlyMissing.isEmpty {
            reportedMissing.formUnion(newlyMissing)
            Log.error("Offerings: packages left out, StoreKit has no product \(newlyMissing) (check the product ids in "
                + "Revflare and App Store Connect, or the StoreKit configuration file)")
        }
        return snapshot
    }
}

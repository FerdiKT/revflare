import Foundation
import StoreKit

/// Errors of promotional offer signing (``RevflareStore/purchase(_:promotionalOffer:placement:appAccountToken:)``,
/// ``Revflare/promotionalOfferSignature(productId:offerId:appAccountToken:)``).
public enum RevflareOfferError: LocalizedError, Equatable {
    /// ``Revflare/configure(sdkKey:server:)`` was not called yet.
    case sdkNotConfigured
    /// 403: the offer is not in the app's allowlist in Revflare (web → the app → Offers), or the server refused it.
    case notAllowed(String)
    /// 409: the Revflare server has no In-App Purchase key for this app, so it cannot sign offers.
    case notConfigured
    /// 404: the server does not know the SDK key.
    case unknownSDKKey
    /// 429: too many signature requests; retry after the given number of seconds (when the server said).
    case rateLimited(retryAfter: TimeInterval?)
    /// The server could not be reached (offline, timeout).
    case network(String)
    /// The server answered with an unexpected HTTP status.
    case server(status: Int)
    /// The server's answer could not be read (or does not match the request).
    case invalidResponse(String)

    public var errorDescription: String? {
        switch self {
        case .sdkNotConfigured: return "RevflareKit is not configured: call Revflare.configure(sdkKey:server:) first."
        case .notAllowed(let message):
            return message.isEmpty ? "This offer is not available." : "This offer is not available (\(message))."
        case .notConfigured: return "The Revflare server has no In-App Purchase key to sign offers."
        case .unknownSDKKey: return "The Revflare server does not know this SDK key."
        case .rateLimited: return "Too many offer requests. Try again later."
        case .network(let message): return "The Revflare server could not be reached (\(message))."
        case .server(let status): return "The Revflare server answered HTTP \(status)."
        case .invalidResponse(let message): return "The offer signature could not be read (\(message))."
        }
    }
}

/// The kind of subscription offer a purchase uses (the `offer_type` event property).
enum PurchaseOfferType: String, Sendable {
    case promotional
    case winBack = "win_back"
}

// MARK: Wire format (`POST /sdk/v1/offers/sign`)

/// Body of `POST /sdk/v1/offers/sign`.
struct OfferSignatureRequest: Encodable, Equatable, Sendable {
    var installId: String
    var productId: String
    var offerId: String
    /// Lowercase; left out when the purchase sends none. The legacy signature covers it.
    var appAccountToken: String?

    init(installId: UUID, productId: String, offerId: String, appAccountToken: UUID?) {
        self.installId = installId.uuidString.lowercased()
        self.productId = productId
        self.offerId = offerId
        self.appAccountToken = appAccountToken?.uuidString.lowercased()
    }
}

/// A promotional offer signature made by the Revflare server with the app's In-App Purchase key.
///
/// Use ``purchaseOptions()`` with `product.purchase(options:)` when buying with your own StoreKit code; with
/// ``RevflareStore`` call ``RevflareStore/purchase(_:promotionalOffer:placement:appAccountToken:)`` instead.
/// A signature is single-use (its nonce) and short-lived: fetch it right before the purchase.
public struct RevflarePromotionalOfferSignature: Sendable, Equatable, Decodable {
    public let productId: String
    public let offerId: String
    /// The In-App Purchase key id.
    public let keyId: String
    public let nonce: UUID
    /// Milliseconds since 1970.
    public let timestamp: Int
    /// Base64 DER ES256 signature (legacy form).
    public let signature: String
    /// The same offer signed as a compact JWS (iOS 26 SDK form), when the server sent it.
    public let jws: String?
    /// The `appAccountToken` the signature was requested for; ``purchaseOptions()`` sends the same one.
    public internal(set) var appAccountToken: UUID?

    private enum CodingKeys: String, CodingKey { case productId, offerId, keyId, nonce, timestamp, signature, jws }

    init(productId: String, offerId: String, keyId: String, nonce: UUID, timestamp: Int, signature: String,
         jws: String?, appAccountToken: UUID? = nil) {
        self.productId = productId
        self.offerId = offerId
        self.keyId = keyId
        self.nonce = nonce
        self.timestamp = timestamp
        self.signature = signature
        self.jws = jws
        self.appAccountToken = appAccountToken
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        productId = try container.decode(String.self, forKey: .productId)
        offerId = try container.decode(String.self, forKey: .offerId)
        keyId = try container.decode(String.self, forKey: .keyId)
        let nonceString = try container.decode(String.self, forKey: .nonce)
        guard let nonce = UUID(uuidString: nonceString) else {
            throw DecodingError.dataCorruptedError(forKey: .nonce, in: container, debugDescription: "nonce is not a UUID")
        }
        self.nonce = nonce
        timestamp = try container.decode(Int.self, forKey: .timestamp)
        signature = try container.decode(String.self, forKey: .signature)
        let jws = try container.decodeIfPresent(String.self, forKey: .jws)
        self.jws = (jws?.isEmpty ?? true) ? nil : jws
        appAccountToken = nil
    }

    /// The purchase options that redeem the offer: the JWS form when the app is built with the iOS 26 SDK (Swift 6.2+;
    /// back-deployed to iOS 15) and the server sent one, else the legacy signature; plus ``appAccountToken``.
    ///
    /// - Throws: ``RevflareOfferError/invalidResponse(_:)`` when the signature can't be decoded.
    public func purchaseOptions() throws -> Set<Product.PurchaseOption> {
        try purchaseOptions(encoding: .preferred)
    }

    func purchaseOptions(encoding: PromotionalOfferEncoding) throws -> Set<Product.PurchaseOption> {
        var options: Set<Product.PurchaseOption> = []
        if let appAccountToken { options.insert(.appAccountToken(appAccountToken)) }
        #if compiler(>=6.2)
        if encoding == .jws, let jws {
            options.formUnion(Product.PurchaseOption.promotionalOffer(offerId, compactJWS: jws))
            return options
        }
        #endif
        guard let data = Data(base64Encoded: signature), !data.isEmpty else {
            throw RevflareOfferError.invalidResponse("the signature is not base64")
        }
        options.insert(LegacyPromotionalOffer.make(offerID: offerId, keyID: keyId, nonce: nonce, signature: data,
                                                   timestamp: timestamp))
        return options
    }
}

/// Which purchase option form a promotional offer uses.
enum PromotionalOfferEncoding: Sendable, Equatable {
    /// `promotionalOffer(_:compactJWS:)` (iOS 26 SDK, back-deployed to iOS 15).
    case jws
    /// `promotionalOffer(offerID:keyID:nonce:signature:timestamp:)`.
    case legacy

    /// JWS when the compiler (and so the SDK) has it.
    static var preferred: PromotionalOfferEncoding {
        #if compiler(>=6.2)
        return .jws
        #else
        return .legacy
        #endif
    }
}

/// Builds the legacy option without a deprecation warning (deprecated in the iOS 26 SDK; still the only form older
/// SDKs have, and the fallback when the server sends no JWS): the deprecated witness is called through the protocol.
private protocol LegacyPromotionalOfferBuilding {
    static func make(offerID: String, keyID: String, nonce: UUID, signature: Data, timestamp: Int) -> Product.PurchaseOption
}

private enum LegacyPromotionalOfferBuilder: LegacyPromotionalOfferBuilding {
    @available(iOS, deprecated: 26.0)
    @available(macOS, deprecated: 26.0)
    @available(tvOS, deprecated: 26.0)
    @available(watchOS, deprecated: 26.0)
    @available(visionOS, deprecated: 26.0)
    static func make(offerID: String, keyID: String, nonce: UUID, signature: Data, timestamp: Int) -> Product.PurchaseOption {
        .promotionalOffer(offerID: offerID, keyID: keyID, nonce: nonce, signature: signature, timestamp: timestamp)
    }
}

enum LegacyPromotionalOffer {
    static func make(offerID: String, keyID: String, nonce: UUID, signature: Data, timestamp: Int) -> Product.PurchaseOption {
        let builder: LegacyPromotionalOfferBuilding.Type = LegacyPromotionalOfferBuilder.self
        return builder.make(offerID: offerID, keyID: keyID, nonce: nonce, signature: signature, timestamp: timestamp)
    }
}

// MARK: Signing client

/// Asks the Revflare server to sign a promotional offer.
struct OfferSignatureClient: Sendable {
    /// The purchase waits for this, so it gives up early.
    static let timeout: TimeInterval = 10

    let client: ReportClient

    func request(_ body: OfferSignatureRequest) throws -> URLRequest {
        var request = try client.makeRequest(body, to: .offersSign)
        request.timeoutInterval = Self.timeout
        return request
    }

    func sign(_ body: OfferSignatureRequest) async throws -> RevflarePromotionalOfferSignature {
        let request: URLRequest
        do {
            request = try self.request(body)
        } catch {
            throw RevflareOfferError.invalidResponse("could not encode the request: \(error)")
        }
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await client.transport.send(request)
        } catch {
            throw RevflareOfferError.network(String(describing: error))
        }
        try Self.check(status: response.statusCode, data: data, retryAfter: response.value(forHTTPHeaderField: "Retry-After"))
        let signature: RevflarePromotionalOfferSignature
        do {
            signature = try JSONDecoder().decode(RevflarePromotionalOfferSignature.self, from: data)
        } catch {
            throw RevflareOfferError.invalidResponse(String(describing: error))
        }
        guard signature.productId == body.productId, signature.offerId == body.offerId else {
            throw RevflareOfferError.invalidResponse("signed \(signature.productId) / \(signature.offerId) instead")
        }
        Log.debug("Offers: signed \(body.offerId) for \(body.productId)")
        return signature
    }

    /// Maps the HTTP status to ``RevflareOfferError``; returns for 2xx.
    static func check(status: Int, data: Data, retryAfter: String?) throws {
        switch status {
        case 200..<300:
            return
        case 403:
            throw RevflareOfferError.notAllowed(errorMessage(data))
        case 409:
            throw RevflareOfferError.notConfigured
        case 404:
            Log.error("Offers: the Revflare server does not know this SDK key (404). Check Revflare.configure(sdkKey:).")
            throw RevflareOfferError.unknownSDKKey
        case 429:
            throw RevflareOfferError.rateLimited(retryAfter: retryAfterSeconds(retryAfter))
        default:
            throw RevflareOfferError.server(status: status)
        }
    }

    /// `Retry-After` in seconds (delta-seconds or an HTTP date).
    static func retryAfterSeconds(_ value: String?, now: Date = Date()) -> TimeInterval? {
        guard let value = value?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
        if let seconds = TimeInterval(value), seconds >= 0 { return seconds }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        guard let date = formatter.date(from: value) else { return nil }
        return max(0, date.timeIntervalSince(now))
    }

    private static func errorMessage(_ data: Data) -> String {
        struct Body: Decodable { var error: String?; var code: String? }
        guard let body = try? JSONDecoder().decode(Body.self, from: data) else { return "" }
        return body.error ?? body.code ?? ""
    }
}

// MARK: Eligibility

/// Pure offer eligibility rules (tested without StoreKit).
enum OfferEligibility {
    /// Promotional offers are only for customers who have or had a subscription in the group: a purchase in the
    /// group (`Transaction.all`), a status of the group, or a subscription the store knows.
    static func hasSubscriptionHistory(groupId: String, purchasedGroups: Set<String>,
                                       statuses: [SubscriptionStatusRecord], customer: CustomerEntitlements) -> Bool {
        if purchasedGroups.contains(groupId) { return true }
        if statuses.contains(where: { $0.transaction.subscriptionGroupId == groupId && $0.transaction.ownership == .purchased }) {
            return true
        }
        return customer.subscriptions.values.contains { $0.subscriptionGroupId == groupId && $0.ownership == .purchased }
    }

    /// The win-back offer ids StoreKit says the customer can redeem in the group, in StoreKit's order, without
    /// duplicates.
    static func eligibleWinBackOfferIds(groupId: String, statuses: [SubscriptionStatusRecord]) -> [String] {
        var seen = Set<String>()
        return statuses
            .filter { $0.transaction.subscriptionGroupId == nil || $0.transaction.subscriptionGroupId == groupId }
            .flatMap(\.eligibleWinBackOfferIds)
            .filter { seen.insert($0).inserted }
    }

    /// The offers whose id is eligible, in the order of `eligibleIds`.
    static func matching<Offer>(_ offers: [Offer], eligibleIds: [String], id: (Offer) -> String?) -> [Offer] {
        eligibleIds.compactMap { eligible in offers.first { id($0) == eligible } }
    }
}

extension CustomerEntitlements {
    /// The customer's most recently expired subscription in the group, when the customer has no access in that group
    /// any more and is not in a billing grace period or billing retry (those are still subscribers: nudge them to
    /// update their payment method instead of offering a discount). Nil otherwise.
    ///
    /// Only groups whose status StoreKit returned are known: the groups of the store's loaded products and of the
    /// current entitlements.
    public func lapsedSubscription(groupID: String) -> SubscriptionDetails? {
        let inGroup = subscriptions.values.filter { $0.subscriptionGroupId == groupID }
        return Self.lapsed(among: inGroup)
    }

    /// Whether the customer had the entitlement through a subscription that expired, with no access now and no
    /// billing grace period / retry in progress (see ``lapsedSubscription(groupID:)``).
    public func isLapsed(entitlement: String, mapping: EntitlementMapping) -> Bool {
        guard active[entitlement] == nil, let productIds = mapping.entitlements[entitlement] else { return false }
        let related = subscriptions.values.filter { productIds.contains($0.productId) }
        return Self.lapsed(among: related) != nil
    }

    private static func lapsed(among details: [SubscriptionDetails]) -> SubscriptionDetails? {
        guard !details.contains(where: { $0.isActive || $0.isInGracePeriod || $0.isInBillingRetry }) else { return nil }
        return details
            .filter { $0.state == .expired }
            .max { ($0.expirationDate ?? .distantPast) < ($1.expirationDate ?? .distantPast) }
    }
}

import Foundation
import CryptoKit

/// Body of `POST /sdk/v1/report`.
struct ReportBody: Codable, Equatable, Sendable {
    var installId: String
    var attributionToken: String?
    var originalTransactionIds: [String]?
    var appVersion: String?
    /// When RevflareKit first ran on this device (ms since 1970, ``ReporterState/firstAttemptAt``): the install time
    /// for LTV, so a first report that arrives late (offline first launch) keeps the right install time.
    var installedAt: Int64?
}

/// Body of `POST /sdk/v1/identifiers`: what Revflare needs to send this install's purchases to Meta's Conversions API.
/// Only built after the app opted in.
struct IdentifiersBody: Codable, Equatable, Sendable {
    var installId: String
    /// The Facebook SDK's `AppEvents.shared.anonymousID`, when the app set it.
    var fbAnonId: String?
    /// Uppercase IDFA, only when tracking is authorized.
    var idfa: String?
    /// Uppercase IDFV.
    var idfv: String?
    var attStatus: String
    var bundleId: String
    var appVersion: String
    var appBuild: String
    var osVersion: String
    var deviceModel: String
    var locale: String
    var timeZone: String
    /// Meta's device info array (16 strings, "i2" first).
    var extinfo: [String]

    private enum CodingKeys: String, CodingKey {
        case installId, fbAnonId, idfa, idfv, attStatus, bundleId, appVersion, appBuild, osVersion, deviceModel, locale
        case timeZone, extinfo
    }

    init(
        installId: String, fbAnonId: String?, idfa: String?, idfv: String?, attStatus: String, bundleId: String,
        appVersion: String, appBuild: String, osVersion: String, deviceModel: String, locale: String, timeZone: String,
        extinfo: [String]
    ) {
        self.installId = installId
        self.fbAnonId = fbAnonId
        self.idfa = idfa
        self.idfv = idfv
        self.attStatus = attStatus
        self.bundleId = bundleId
        self.appVersion = appVersion
        self.appBuild = appBuild
        self.osVersion = osVersion
        self.deviceModel = deviceModel
        self.locale = locale
        self.timeZone = timeZone
        self.extinfo = extinfo
    }

    init(installId: UUID, fbAnonId: String?, device: DeviceIdentifiers) {
        self.init(
            installId: installId.uuidString.lowercased(),
            fbAnonId: fbAnonId,
            idfa: device.idfa,
            idfv: device.idfv,
            attStatus: device.attStatus.rawValue,
            bundleId: device.bundleId,
            appVersion: device.appVersion,
            appBuild: device.appBuild,
            osVersion: device.osVersion,
            deviceModel: device.deviceModel,
            locale: device.locale,
            timeZone: device.timeZone,
            extinfo: device.extinfo
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(installId, forKey: .installId)
        // Sent as null (not left out) when absent.
        try container.encode(fbAnonId, forKey: .fbAnonId)
        try container.encode(idfa, forKey: .idfa)
        try container.encode(idfv, forKey: .idfv)
        try container.encode(attStatus, forKey: .attStatus)
        try container.encode(bundleId, forKey: .bundleId)
        try container.encode(appVersion, forKey: .appVersion)
        try container.encode(appBuild, forKey: .appBuild)
        try container.encode(osVersion, forKey: .osVersion)
        try container.encode(deviceModel, forKey: .deviceModel)
        try container.encode(locale, forKey: .locale)
        try container.encode(timeZone, forKey: .timeZone)
        try container.encode(extinfo, forKey: .extinfo)
    }

    /// Identifies the fields that matter for matching, leaving out the volatile ones (free disk space and the rest of
    /// extinfo): a change here means the server should hear about it. Hashed, so no identifier is stored in clear.
    var fingerprint: String {
        let fields = [installId, fbAnonId ?? "", idfa ?? "", idfv ?? "", attStatus, appVersion, appBuild, osVersion, locale]
        let digest = SHA256.hash(data: Data(fields.joined(separator: "\u{1F}").utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

/// Answer of `POST /sdk/v1/report` and `POST /sdk/v1/identifiers`.
///
/// `{ "ok": true, "attribution": "pending" | "resolved" | "failed" | …, "source": "apple_ads" | "organic" | "unknown",
/// "campaignId": "123" | null, "adGroupId": … | null, "keywordId": … | null }`. Servers before 1.8 only send
/// `attribution`.
struct ReportResponse: Decodable, Equatable, Sendable {
    var ok: Bool?
    var attribution: String?
    var source: String?
    var campaignId: String?
    var adGroupId: String?
    var keywordId: String?

    init(ok: Bool? = nil, attribution: String? = nil, source: String? = nil, campaignId: String? = nil,
         adGroupId: String? = nil, keywordId: String? = nil) {
        self.ok = ok
        self.attribution = attribution
        self.source = source
        self.campaignId = campaignId
        self.adGroupId = adGroupId
        self.keywordId = keywordId
    }

    private enum CodingKeys: String, CodingKey { case ok, attribution, source, campaignId, adGroupId, keywordId }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = (try? container.decodeIfPresent(Bool.self, forKey: .ok)) ?? nil
        attribution = Self.text(container, .attribution)
        source = Self.text(container, .source)
        campaignId = Self.text(container, .campaignId)
        adGroupId = Self.text(container, .adGroupId)
        keywordId = Self.text(container, .keywordId)
    }

    /// A string, or a number written as one (lenient about ids); empty → nil.
    private static func text(_ container: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> String? {
        if let string = (try? container.decodeIfPresent(String.self, forKey: key)) ?? nil {
            return string.isEmpty ? nil : string
        }
        if let number = (try? container.decodeIfPresent(Int64.self, forKey: key)) ?? nil { return String(number) }
        return nil
    }
}

/// What came of one report.
enum ReportOutcome: Equatable, Sendable {
    /// 200: the server stored the report (an unreadable body decodes as an empty response).
    case accepted(ReportResponse)
    /// 4xx: the server refused it (unknown SDK key, bad input). Retried later with a long backoff.
    case rejected(status: Int, message: String)
    /// Network error, timeout, 5xx, 429: retried with backoff.
    case retryable(String)
}

/// Sends HTTP requests (URLSession in the app, a fake in tests).
protocol Transport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

struct URLSessionTransport: Transport {
    let session: URLSession

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 40
        config.waitsForConnectivity = false
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        config.urlCache = nil
        session = URLSession(configuration: config)
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }
}

/// Builds and sends reports to one Revflare server.
struct ReportClient: Sendable {
    static let maxTransactionIdsPerReport = 90

    let server: URL
    let sdkKey: String
    let transport: Transport
    /// The resolved environment (``Revflare/environment``), added as `"environment"` to every JSON body; nil leaves
    /// it out (tests). Read per request: a StoreKit transaction seen later can refine it.
    var environment: @Sendable () -> String? = { nil }

    /// The SDK endpoints.
    enum Path: String, Sendable {
        case report
        case identifiers
        case offerings
        case events
        case config
        case offersSign = "offers/sign"
    }

    /// `POST /sdk/v1/report`.
    var endpoint: URL { url(.report) }

    func url(_ path: Path) -> URL {
        server.appendingPathComponent("sdk").appendingPathComponent("v1").appendingPathComponent(path.rawValue)
    }

    func makeRequest<Body: Encodable>(_ body: Body, to path: Path = .report) throws -> URLRequest {
        var request = URLRequest(url: url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(sdkKey, forHTTPHeaderField: "X-Revflare-Key")
        request.setValue("RevflareKit/\(Revflare.version)", forHTTPHeaderField: "User-Agent")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        if let environment = environment() {
            request.httpBody = try encoder.encode(EnvironmentEnvelope(body: body, environment: environment))
        } else {
            request.httpBody = try encoder.encode(body)
        }
        return request
    }

    func send<Body: Encodable & Sendable>(_ body: Body, to path: Path = .report) async -> ReportOutcome {
        let request: URLRequest
        do {
            request = try makeRequest(body, to: path)
        } catch {
            return .rejected(status: 0, message: "Could not encode the report: \(error)")
        }
        do {
            let (data, response) = try await transport.send(request)
            switch response.statusCode {
            case 200..<300:
                let decoded = try? JSONDecoder().decode(ReportResponse.self, from: data)
                return .accepted(decoded ?? ReportResponse())
            case 429, 500...:
                return .retryable("HTTP \(response.statusCode)")
            default:
                let message = String(data: data.prefix(300), encoding: .utf8) ?? ""
                return .rejected(status: response.statusCode, message: message)
            }
        } catch {
            return .retryable(String(describing: error))
        }
    }
}

/// Encodes a JSON object body with `"environment"` added at its top level.
struct EnvironmentEnvelope<Body: Encodable>: Encodable {
    let body: Body
    let environment: String

    private struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    func encode(to encoder: Encoder) throws {
        try body.encode(to: encoder)
        var container = encoder.container(keyedBy: Key.self)
        try container.encode(environment, forKey: Key(stringValue: "environment"))
    }
}

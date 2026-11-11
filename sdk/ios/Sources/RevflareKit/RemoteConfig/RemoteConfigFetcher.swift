import Foundation
import CryptoKit
import StoreKit

// MARK: Wire format (`GET /sdk/v1/config`)

/// The values the server resolved for this device.
struct RemoteConfigResponse: Decodable, Equatable, Sendable {
    /// The configuration's version (also the ETag).
    var version: String
    /// Parameter key → value resolved for this device. Parameters left out use the app's defaults.
    var values: [String: RevflareJSON]
    /// Names of the conditions that matched, in the server's order.
    var conditions: [String]
    /// The country the server used (App Store storefront, else the IP country), ISO alpha-2.
    var country: String?
    /// The running experiments this device is enrolled in (their variant's values are already in ``values``). Empty
    /// when the field is missing (servers before experiments).
    var experiments: [RevflareExperiment]

    private enum CodingKeys: String, CodingKey { case version, values, conditions, country, experiments }

    init(version: String, values: [String: RevflareJSON], conditions: [String] = [], country: String? = nil,
         experiments: [RevflareExperiment] = []) {
        self.version = version
        self.values = values
        self.conditions = conditions
        self.country = country
        self.experiments = experiments
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = (try? container.decodeIfPresent(String.self, forKey: .version)) ?? ""
        values = try container.decodeIfPresent([String: RevflareJSON].self, forKey: .values) ?? [:]
        conditions = (try? container.decodeIfPresent([String].self, forKey: .conditions)) ?? []
        let country = (try? container.decodeIfPresent(String.self, forKey: .country)) ?? nil
        self.country = country.flatMap { $0.isEmpty ? nil : $0 }
        // Lenient: a malformed entry is skipped, the rest of the answer stays usable.
        let entries = (try? container.decodeIfPresent([LenientExperiment].self, forKey: .experiments)) ?? nil
        experiments = (entries ?? []).compactMap(\.value)
    }
}

/// One entry of `experiments`, nil when malformed (no id or variant).
private struct LenientExperiment: Decodable {
    var value: RevflareExperiment?

    private enum CodingKeys: String, CodingKey { case id, variant, keys }

    init(from decoder: Decoder) throws {
        guard let container = try? decoder.container(keyedBy: CodingKeys.self),
              let id = try? container.decode(String.self, forKey: .id), !id.isEmpty,
              let variant = try? container.decode(String.self, forKey: .variant), !variant.isEmpty else {
            value = nil
            return
        }
        let keys = (try? container.decodeIfPresent([String].self, forKey: .keys)) ?? nil
        value = RevflareExperiment(id: id, variant: variant, keys: keys ?? [])
    }
}

/// What a config request says about the device (no identifiers apart from the random install id).
struct RemoteConfigContext: Equatable, Sendable {
    var installId: UUID
    var appVersion: String
    var appBuild: String
    var osVersion: String
    /// Underscore form, e.g. "zh_CN".
    var locale: String
    /// App Store storefront country, ISO alpha-2 ("CN"), nil when unknown.
    var storefront: String?
    /// ``Revflare/attribution`` (`source` = `apple_ads` / `organic` / `unknown`, the ids only for Apple Ads).
    var attribution: RevflareAttribution = .unknown
    /// ``Revflare/environment`` (`production` / `sandbox` / `xcode`), nil leaves it out (tests).
    var environment: String?

    /// Identifies what the server may target (not the install id): when it changes, cached values may be stale.
    var fingerprint: String {
        let fields = [appVersion, appBuild, osVersion, locale, storefront ?? "", attribution.source.rawValue,
                      attribution.campaignId ?? "", attribution.adGroupId ?? "", attribution.keywordId ?? "",
                      environment ?? ""]
        let digest = SHA256.hash(data: Data(fields.joined(separator: "\u{1F}").utf8))
        return digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    /// The query of `GET /sdk/v1/config`, in a stable order.
    var queryItems: [URLQueryItem] {
        var items = [
            URLQueryItem(name: "installId", value: installId.uuidString.lowercased()),
            URLQueryItem(name: "appVersion", value: appVersion),
            URLQueryItem(name: "appBuild", value: appBuild),
            URLQueryItem(name: "osVersion", value: osVersion),
            URLQueryItem(name: "locale", value: locale),
        ]
        if let storefront, !storefront.isEmpty { items.append(URLQueryItem(name: "storefront", value: storefront)) }
        items.append(URLQueryItem(name: "source", value: attribution.source.rawValue))
        if let campaign = attribution.campaignId { items.append(URLQueryItem(name: "campaign", value: campaign)) }
        if let adGroup = attribution.adGroupId { items.append(URLQueryItem(name: "adGroup", value: adGroup)) }
        if let keyword = attribution.keywordId { items.append(URLQueryItem(name: "keyword", value: keyword)) }
        if let environment { items.append(URLQueryItem(name: "environment", value: environment)) }
        items.append(URLQueryItem(name: "sdk", value: Revflare.version))
        return items
    }
}

/// Source of the ``RemoteConfigContext`` (the system in the app, a fake in tests).
protocol RemoteConfigContextProvider: Sendable {
    func context() async -> RemoteConfigContext
}

/// Reads the bundle, the OS, the locale, StoreKit's storefront, the attribution and the environment.
struct SystemRemoteConfigContextProvider: RemoteConfigContextProvider {
    /// Never wait longer than this for StoreKit's storefront.
    static let storefrontTimeout: TimeInterval = 1.5

    let identity: InstallIdentity
    /// First launch: the first context waits for the first attribution report (at most 3 s).
    var gate: AttributionGate?
    var attribution: @Sendable () -> RevflareAttribution = { .unknown }
    var environment: @Sendable () -> String? = { nil }

    func context() async -> RemoteConfigContext {
        let bundle = Bundle.main
        async let storefrontLookup = firstResult(timeout: Self.storefrontTimeout) { await Storefront.current?.countryCode }
        await gate?.wait()
        let storefront = await storefrontLookup
        return RemoteConfigContext(
            installId: identity.resolve().id,
            appVersion: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
            appBuild: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
            osVersion: SystemDeviceIdentifierProvider.osVersion(),
            locale: SystemDeviceIdentifierProvider.localeIdentifier(Locale.current.identifier),
            storefront: (storefront ?? nil).flatMap(CountryCode.alpha2),
            attribution: attribution(),
            environment: environment()
        )
    }
}

// MARK: Country codes

/// ISO 3166-1 country codes. StoreKit gives the storefront as alpha-3 ("CHN"); Revflare uses alpha-2 ("CN").
enum CountryCode {
    /// Alpha-3 then alpha-2, five letters per country (ISO 3166-1, plus the exceptionally reserved codes ICU knows).
    private static let table = """
        ASCACANDADAREAEAFGAFATGAGAIAAIALBALARMAMAGOAOATAAQARGARASMASAUTATAUSAUABWAWALAAXAZEAZBIHBABRBBBBGDBDBELBE\
        BFABFBGRBGBHRBHBDIBIBENBJBLMBLBMUBMBRNBNBOLBOBESBQBRABRBHSBSBTNBTBVTBVBWABWBLRBYBLZBZCANCACCKCCCODCDCAFCF\
        COGCGCHECHCIVCICOKCKCHLCLCMRCMCHNCNCOLCOCPTCPCRQCQCRICRCUBCUCPVCVCUWCWCXRCXCYPCYCZECZDEUDEDGADGDJIDJDNKDK\
        DMADMDOMDODZADZXEAEAECUECESTEEEGYEGESHEHERIERESPESETHETFINFIFJIFJFLKFKFSMFMFROFOFRAFRGABGAGBRGBGRDGDGEOGE\
        GUFGFGGYGGGHAGHGIBGIGRLGLGMBGMGINGNGLPGPGNQGQGRCGRSGSGSGTMGTGUMGUGNBGWGUYGYHKGHKHMDHMHNDHNHRVHRHTIHTHUNHU\
        XICICIDNIDIRLIEISRILIMNIMINDINIOTIOIRQIQIRNIRISLISITAITJEYJEJAMJMJORJOJPNJPKENKEKGZKGKHMKHKIRKICOMKMKNAKN\
        PRKKPKORKRKWTKWCYMKYKAZKZLAOLALBNLBLCALCLIELILKALKLBRLRLSOLSLTULTLUXLULVALVLBYLYMARMAMCOMCMDAMDMNEMEMAFMF\
        MDGMGMHLMHMKDMKMLIMLMMRMMMNGMNMACMOMNPMPMTQMQMRTMRMSRMSMLTMTMUSMUMDVMVMWIMWMEXMXMYSMYMOZMZNAMNANCLNCNERNE\
        NFKNFNGANGNICNINLDNLNORNONPLNPNRUNRNIUNUNZLNZOMNOMPANPAPERPEPYFPFPNGPGPHLPHPAKPKPOLPLSPMPMPCNPNPRIPRPSEPS\
        PRTPTPLWPWPRYPYQATQAREUREROUROSRBRSRUSRURWARWSAUSASLBSBSYCSCSDNSDSWESESGPSGSHNSHSVNSISJMSJSVKSKSLESLSMRSM\
        SENSNSOMSOSURSRSSDSSSTPSTSLVSVSXMSXSYRSYSWZSZTAATATCATCTCDTDATFTFTGOTGTHATHTJKTJTKLTKTLSTLTKMTMTUNTNTONTO\
        TURTRTTOTTTUVTVTWNTWTZATZUKRUAUGAUGUMIUMUSAUSURYUYUZBUZVATVAVCTVCVENVEVGBVGVIRVIVNMVNVUTVUWLFWFWSMWSXKKXK\
        YEMYEMYTYTZAFZAZMBZMZWEZW
        """

    /// Alpha-3 → alpha-2.
    static let alpha3ToAlpha2: [String: String] = {
        let chars = Array(table)
        var map: [String: String] = ["XKS": "XK"] // Kosovo, as Apple writes it
        var index = 0
        while index + 5 <= chars.count {
            map[String(chars[index..<index + 3])] = String(chars[index + 3..<index + 5])
            index += 5
        }
        return map
    }()

    /// "CHN" → "CN"; an alpha-2 code is returned uppercased; anything else gives nil.
    static func alpha2(_ code: String) -> String? {
        let value = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard value.allSatisfy({ $0.isASCII && $0.isLetter }) else { return nil }
        switch value.count {
        case 2: return value
        case 3: return alpha3ToAlpha2[value]
        default: return nil
        }
    }
}

// MARK: Request

extension ReportClient {
    /// `GET /sdk/v1/config?installId=…&appVersion=…&appBuild=…&osVersion=…&locale=…&storefront=…&source=…`
    /// `&campaign=…&adGroup=…&keyword=…&environment=…&sdk=…`.
    func remoteConfigRequest(context: RemoteConfigContext, etag: String?) -> URLRequest {
        var url = self.url(.config)
        if var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.queryItems = context.queryItems
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

// MARK: Cache

/// One answer of the server, as kept on the device.
struct CachedRemoteConfig: Codable, Equatable, Sendable {
    var etag: String?
    /// When the server last sent or confirmed (304) this answer.
    var fetchedAt: Date
    /// ``RemoteConfigContext/fingerprint`` of the request.
    var context: String
    /// The raw JSON body.
    var body: Data
}

/// What is kept on the device for one server + SDK key: the active values and, after a ``RevflareRemoteConfig/fetch()``
/// without ``RevflareRemoteConfig/activate()``, the fetched ones.
struct RemoteConfigState: Codable, Equatable, Sendable {
    var active: CachedRemoteConfig?
    var pending: CachedRemoteConfig?

    /// The newest answer (the one to revalidate).
    var newest: CachedRemoteConfig? { pending ?? active }
}

/// Reads and writes ``RemoteConfigState`` in a ``KeyValueStore`` (UserDefaults in the app).
struct RemoteConfigStorage: Sendable {
    /// Remembers the cache key of the last ``Revflare/configure(sdkKey:server:)``, so the values are available on first
    /// access, before `configure` runs again.
    static let scopeKey = "app.revflare.kit.remoteConfig.scope"

    let store: KeyValueStore

    static func cacheKey(server: URL, sdkKey: String) -> String {
        let digest = SHA256.hash(data: Data("\(server.absoluteString)\n\(sdkKey)".utf8))
        return "app.revflare.kit.remoteConfig." + digest.prefix(12).map { String(format: "%02x", $0) }.joined()
    }

    var lastScope: String? { store.string(forKey: Self.scopeKey) }

    func rememberScope(_ key: String) {
        if store.string(forKey: Self.scopeKey) != key { store.set(key, forKey: Self.scopeKey) }
    }

    func load(_ key: String) -> RemoteConfigState {
        guard let data = store.data(forKey: key),
              let state = try? JSONDecoder().decode(RemoteConfigState.self, from: data) else { return RemoteConfigState() }
        return state
    }

    func save(_ state: RemoteConfigState, key: String) {
        store.set(try? JSONEncoder().encode(state), forKey: key)
    }
}

// MARK: Fetching

/// What came of one config request.
enum RemoteConfigFetchOutcome: Equatable, Sendable {
    /// 200: new values (not active yet).
    case fetched(CachedRemoteConfig, RemoteConfigResponse)
    /// 304: the cached answer is still current.
    case notModified
    /// 429: the server asks to slow down.
    case throttled
    /// Network error, 5xx, 404 (unknown SDK key), unreadable answer.
    case failed(String)
}

/// Sends `GET /sdk/v1/config`.
struct RemoteConfigFetcher: Sendable {
    let client: ReportClient
    let contextProvider: RemoteConfigContextProvider
    let now: @Sendable () -> Date

    init(client: ReportClient, contextProvider: RemoteConfigContextProvider, now: @escaping @Sendable () -> Date = { Date() }) {
        self.client = client
        self.contextProvider = contextProvider
        self.now = now
    }

    var cacheKey: String { RemoteConfigStorage.cacheKey(server: client.server, sdkKey: client.sdkKey) }

    func context() async -> RemoteConfigContext { await contextProvider.context() }

    func fetch(context: RemoteConfigContext, etag: String?) async -> RemoteConfigFetchOutcome {
        let request = client.remoteConfigRequest(context: context, etag: etag)
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await client.transport.send(request)
        } catch {
            return .failed("network: \(error.localizedDescription)")
        }
        switch response.statusCode {
        case 200..<300:
            let decoded: RemoteConfigResponse
            do {
                decoded = try JSONDecoder().decode(RemoteConfigResponse.self, from: data)
            } catch {
                return .failed("unreadable answer: \(error)")
            }
            let etag = response.value(forHTTPHeaderField: "ETag") ?? (decoded.version.isEmpty ? nil : "\"\(decoded.version)\"")
            let entry = CachedRemoteConfig(etag: etag, fetchedAt: now(), context: context.fingerprint, body: data)
            return .fetched(entry, decoded)
        case 304:
            return etag == nil ? .failed("304 without a cached answer") : .notModified
        case 429:
            return .throttled
        case 404:
            Log.error("Remote config: the Revflare server does not know this SDK key (404). Check Revflare.configure(sdkKey:).")
            return .failed("HTTP 404")
        default:
            return .failed("HTTP \(response.statusCode)")
        }
    }
}

// MARK: Timeout

/// The result of `work`, or nil when it takes longer than `timeout` seconds (the work keeps running, unobserved).
func firstResult<T: Sendable>(timeout: TimeInterval, _ work: @escaping @Sendable () async -> T) async -> T? {
    guard timeout.isFinite else { return await work() }
    let resumed = Locked(false)
    let timerTask = Locked<Task<Void, Never>?>(nil)
    return await withCheckedContinuation { (continuation: CheckedContinuation<T?, Never>) in
        let finish: @Sendable (T?) -> Void = { value in
            let first = resumed.withLock { done -> Bool in
                defer { done = true }
                return !done
            }
            guard first else { return }
            continuation.resume(returning: value)
            timerTask.current?.cancel()
        }
        let timer = Task {
            try? await Task.sleep(nanoseconds: UInt64(max(0, timeout) * 1_000_000_000))
            guard !Task.isCancelled else { return }
            finish(nil)
        }
        timerTask.withLock { $0 = timer }
        Task { finish(await work()) }
        if resumed.current { timer.cancel() }
    }
}

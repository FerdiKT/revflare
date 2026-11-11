import Foundation
@testable import RevflareKit

final class MemoryStore: KeyValueStore, @unchecked Sendable {
    private let values = Locked<[String: Any]>([:])

    func data(forKey key: String) -> Data? { values.current[key] as? Data }
    func set(_ data: Data?, forKey key: String) { values.withLock { $0[key] = data } }
    func string(forKey key: String) -> String? { values.current[key] as? String }
    func set(_ string: String?, forKey key: String) { values.withLock { $0[key] = string } }
}

final class MemorySecureStore: SecureStore, @unchecked Sendable {
    let stored = Locked<UUID?>(nil)
    let isLocked = Locked(false)
    let writes = Locked(0)

    func readInstallId() -> SecureReadResult {
        if isLocked.current { return .locked }
        if let id = stored.current { return .found(id) }
        return .notFound
    }

    func writeInstallId(_ id: UUID) -> Bool {
        writes.withLock { $0 += 1 }
        stored.withLock { $0 = id }
        return true
    }
}

/// Answers requests from a script; records them.
final class FakeTransport: Transport, @unchecked Sendable {
    enum Reply {
        case status(Int, String)
        /// Status, body and response headers.
        case response(Int, String, [String: String])
        case networkError
    }

    let requests = Locked<[URLRequest]>([])
    private let replies = Locked<[Reply]>([])
    /// Used when the script is empty.
    var defaultReply: Reply = .status(200, #"{"ok":true,"attribution":"pending"}"#)

    func enqueue(_ reply: Reply...) { replies.withLock { $0.append(contentsOf: reply) } }

    /// Bodies sent to `/sdk/v1/report`.
    var bodies: [ReportBody] {
        requests(to: "/sdk/v1/report").compactMap { $0.httpBody }.compactMap { try? JSONDecoder().decode(ReportBody.self, from: $0) }
    }

    /// Bodies sent to `/sdk/v1/identifiers`.
    var identifierBodies: [IdentifiersBody] {
        requests(to: "/sdk/v1/identifiers").compactMap { $0.httpBody }
            .compactMap { try? JSONDecoder().decode(IdentifiersBody.self, from: $0) }
    }

    func requests(to path: String) -> [URLRequest] {
        requests.current.filter { $0.url?.path.hasSuffix(path) == true }
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.withLock { $0.append(request) }
        let reply = replies.withLock { $0.isEmpty ? defaultReply : $0.removeFirst() }
        switch reply {
        case .networkError:
            throw URLError(.notConnectedToInternet)
        case .status(let code, let body):
            let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(body.utf8), response)
        case .response(let code, let body, let headers):
            let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: headers)!
            return (Data(body.utf8), response)
        }
    }
}

final class FakeTokenProvider: AttributionTokenProvider, @unchecked Sendable {
    private let results = Locked<[TokenResult]>([])
    var fallback: TokenResult = .token("token-abcdefghijklmnop")
    let calls = Locked(0)

    func enqueue(_ result: TokenResult...) { results.withLock { $0.append(contentsOf: result) } }

    func attributionToken() async -> TokenResult {
        calls.withLock { $0 += 1 }
        return results.withLock { $0.isEmpty ? fallback : $0.removeFirst() }
    }
}

final class FakeTransactions: TransactionSource, @unchecked Sendable {
    let ids = Locked<Set<String>>([])
    func originalTransactionIds() async -> Set<String> { ids.current }
}

final class FakeDeviceIdentifiers: DeviceIdentifierProvider, @unchecked Sendable {
    static let idfa = "0F8FAD5B-D9CB-469F-A165-70867728950E"
    static let idfv = "7C9E6679-7425-40DE-944B-E07FC1F90AE7"
    let info = Locked(DeviceIdentifiers(
        idfa: nil,
        idfv: FakeDeviceIdentifiers.idfv,
        attStatus: .notDetermined,
        bundleId: "com.example.app",
        appVersion: "1.2.3",
        appBuild: "45",
        osVersion: "18.1",
        deviceModel: "iPhone15,2",
        locale: "en_US",
        timeZone: "Europe/Istanbul",
        extinfo: ["i2", "com.example.app", "1.2.3", "45", "18.1", "iPhone15,2", "en_US", "GMT+3", "", "393", "852",
                  "3.00", "6", "119", "42", "Europe/Istanbul"]
    ))
    let calls = Locked(0)

    func allowTracking() {
        info.withLock {
            $0.idfa = Self.idfa
            $0.attStatus = .authorized
        }
    }

    func deviceIdentifiers() async -> DeviceIdentifiers {
        calls.withLock { $0 += 1 }
        return info.current
    }
}

final class TestClock: @unchecked Sendable {
    let date = Locked(Date(timeIntervalSince1970: 1_800_000_000))
    var now: Date { date.current }
    func advance(_ seconds: TimeInterval) { date.withLock { $0 = $0.addingTimeInterval(seconds) } }
}

/// One simulated app: shared storage survives "relaunches" (new Reporter instances).
final class Harness: @unchecked Sendable {
    static let metaAnonId = "XZ5A1B2C3D-0000-4000-8000-000000000001"

    let transport = FakeTransport()
    let tokens = FakeTokenProvider()
    let transactions = FakeTransactions()
    let device = FakeDeviceIdentifiers()
    let store = MemoryStore()
    let secure = MemorySecureStore()
    let clock = TestClock()
    let sleeps = Locked<[TimeInterval]>([])
    var server = URL(string: "https://revflare.example.com")!
    let sdkKey = "rfp_test"
    /// Sent as `environment` when set.
    var environment: String?
    /// What the reporters announced (``ReporterEnvironment/onAttributionChange``).
    let attributionChanges = Locked<[RevflareAttribution]>([])
    let firstReports = Locked(0)

    lazy var identity = InstallIdentity(secure: secure, defaults: store)

    func makeReporter() -> Reporter {
        let clock = self.clock
        let sleeps = self.sleeps
        let env = ReporterEnvironment(
            transport: transport,
            tokenProvider: tokens,
            transactions: transactions,
            store: store,
            identity: InstallIdentity(secure: secure, defaults: store),
            appVersion: "1.2.3",
            deviceIdentifiers: device,
            now: { clock.now },
            onAttributionChange: { [attributionChanges] value in attributionChanges.withLock { $0.append(value) } },
            onFirstAttributionReport: { [firstReports] in firstReports.withLock { $0 += 1 } },
            sleep: { seconds in sleeps.withLock { $0.append(seconds) } },
            retryInSession: false
        )
        let environment = self.environment
        return Reporter(client: ReportClient(server: server, sdkKey: sdkKey, transport: transport,
                                             environment: { environment }), environment: env)
    }

    /// What ``Revflare/setMetaAnonymousID(_:)`` stores.
    func setMetaAnonymousId(_ id: String = Harness.metaAnonId) { Reporter.optIn(store: store, metaAnonymousId: id) }
    /// What ``Revflare/collectDeviceIdentifiers()`` stores.
    func collectDeviceIdentifiers() { Reporter.optIn(store: store, metaAnonymousId: nil) }
}

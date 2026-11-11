import Foundation
import XCTest
@testable import RevflareKit

final class MetaTests: XCTestCase {
    private let resolved = #"{"ok":true,"attribution":"resolved"}"#
    private let ok = #"{"ok":true}"#

    private func json(_ request: URLRequest?) throws -> String {
        try XCTUnwrap(String(data: XCTUnwrap(request?.httpBody), encoding: .utf8))
    }

    func testNothingCollectedOrSentBeforeOptIn() async throws {
        let h = Harness()
        h.transactions.ids.withLock { $0 = ["1000000000000001"] }
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        await reporter.sync(.manual)
        await reporter.sync(.identifiers)
        XCTAssertEqual(h.transport.requests.current.count, 2)
        XCTAssertTrue(h.transport.requests(to: "/sdk/v1/identifiers").isEmpty)
        XCTAssertEqual(h.device.calls.current, 0)
        let fingerprint = await reporter.snapshot.identifiersFingerprint
        XCTAssertNil(fingerprint)
    }

    func testSentOnceAfterSetMetaAnonymousID() async throws {
        let h = Harness()
        h.transport.enqueue(.status(200, resolved))
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        XCTAssertEqual(h.transport.requests.current.count, 1)

        h.setMetaAnonymousId()
        await reporter.sync(.identifiers)
        XCTAssertEqual(h.transport.identifierBodies.count, 1)
        let body = try XCTUnwrap(h.transport.identifierBodies.first)
        XCTAssertEqual(body.installId, h.identity.resolve().id.uuidString.lowercased())
        XCTAssertEqual(body.fbAnonId, Harness.metaAnonId)
        XCTAssertNil(body.idfa)
        XCTAssertEqual(body.idfv, FakeDeviceIdentifiers.idfv)
        XCTAssertEqual(body.attStatus, "notDetermined")
        XCTAssertEqual(body.bundleId, "com.example.app")
        XCTAssertEqual(body.appVersion, "1.2.3")
        XCTAssertEqual(body.appBuild, "45")
        XCTAssertEqual(body.osVersion, "18.1")
        XCTAssertEqual(body.deviceModel, "iPhone15,2")
        XCTAssertEqual(body.locale, "en_US")
        XCTAssertEqual(body.timeZone, "Europe/Istanbul")
        XCTAssertEqual(body.extinfo.count, 16)
        let fingerprint = await reporter.snapshot.identifiersFingerprint
        XCTAssertNotNil(fingerprint)
        // Hashed: no identifier stored in clear.
        XCTAssertFalse(fingerprint?.contains(FakeDeviceIdentifiers.idfv) ?? true)

        // Same data on later passes and launches: nothing more.
        await reporter.sync(.manual)
        await reporter.sync(.identifiers)
        h.clock.advance(3600)
        await h.makeReporter().sync(.launch)
        XCTAssertEqual(h.transport.identifierBodies.count, 1)
        XCTAssertEqual(h.transport.requests.current.count, 2)
    }

    func testSentOnFirstLaunchWhenOptedInBeforeConfigure() async {
        let h = Harness()
        h.setMetaAnonymousId()
        await h.makeReporter().sync(.launch)
        // The token report, then the identifiers.
        XCTAssertEqual(h.transport.requests.current.map { $0.url?.lastPathComponent }, ["report", "identifiers"])
        XCTAssertNotNil(h.transport.bodies.first?.attributionToken)
    }

    func testCollectDeviceIdentifiersWithoutAnonId() async throws {
        let h = Harness()
        h.transport.enqueue(.status(200, resolved))
        let reporter = h.makeReporter()
        await reporter.sync(.launch)

        h.collectDeviceIdentifiers()
        await reporter.sync(.identifiers)
        XCTAssertEqual(h.transport.identifierBodies.count, 1)
        XCTAssertNil(h.transport.identifierBodies.first?.fbAnonId)
        // Absent ids are sent as null, not left out.
        let text = try json(h.transport.requests(to: "/sdk/v1/identifiers").first)
        XCTAssertTrue(text.contains(#""fbAnonId":null"#))
        XCTAssertTrue(text.contains(#""idfa":null"#))

        // Setting the anonymous id later changes the fingerprint: sent again.
        h.setMetaAnonymousId()
        await reporter.sync(.identifiers)
        XCTAssertEqual(h.transport.identifierBodies.count, 2)
        XCTAssertEqual(h.transport.identifierBodies.last?.fbAnonId, Harness.metaAnonId)
    }

    func testResentWhenTrackingAuthorized() async {
        let h = Harness()
        h.collectDeviceIdentifiers()
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        XCTAssertEqual(h.transport.identifierBodies.count, 1)
        XCTAssertNil(h.transport.identifierBodies.last?.idfa)

        // The app's ATT prompt completed, then it calls collectDeviceIdentifiers() again.
        h.device.allowTracking()
        await reporter.sync(.identifiers)
        XCTAssertEqual(h.transport.identifierBodies.count, 2)
        XCTAssertEqual(h.transport.identifierBodies.last?.idfa, FakeDeviceIdentifiers.idfa)
        XCTAssertEqual(h.transport.identifierBodies.last?.attStatus, "authorized")

        await reporter.sync(.manual)
        XCTAssertEqual(h.transport.identifierBodies.count, 2)
    }

    func testResentWhenAppOrOSVersionChangesButNotForVolatileFields() async {
        let h = Harness()
        h.setMetaAnonymousId()
        await h.makeReporter().sync(.launch)
        XCTAssertEqual(h.transport.identifierBodies.count, 1)

        // Free disk space (extinfo) and the time zone change: not resent.
        h.device.info.withLock {
            $0.extinfo[14] = "41"
            $0.timeZone = "Europe/Paris"
        }
        await h.makeReporter().sync(.launch)
        XCTAssertEqual(h.transport.identifierBodies.count, 1)

        h.device.info.withLock { $0.appBuild = "46" }
        await h.makeReporter().sync(.launch)
        XCTAssertEqual(h.transport.identifierBodies.count, 2)

        h.device.info.withLock { $0.appVersion = "1.3.0" }
        await h.makeReporter().sync(.launch)
        XCTAssertEqual(h.transport.identifierBodies.count, 3)
        XCTAssertEqual(h.transport.identifierBodies.last?.appVersion, "1.3.0")

        h.device.info.withLock { $0.osVersion = "18.2" }
        await h.makeReporter().sync(.launch)
        XCTAssertEqual(h.transport.identifierBodies.count, 4)
    }

    func testAdvertisingIdRules() {
        let idfa = FakeDeviceIdentifiers.idfa
        for status in [TrackingStatus.denied, .restricted, .notDetermined, .unavailable] {
            XCTAssertNil(SystemDeviceIdentifierProvider.advertisingId(status: status, rawIdfa: idfa), status.rawValue)
        }
        XCTAssertNil(SystemDeviceIdentifierProvider.advertisingId(status: .authorized, rawIdfa: SystemDeviceIdentifierProvider.zeroIdfa))
        XCTAssertNil(SystemDeviceIdentifierProvider.advertisingId(status: .authorized, rawIdfa: nil))
        XCTAssertEqual(SystemDeviceIdentifierProvider.advertisingId(status: .authorized, rawIdfa: idfa.lowercased()), idfa)
    }

    func testEndpointAndReportBodiesWithoutMeta() async throws {
        let h = Harness()
        h.setMetaAnonymousId()
        h.device.allowTracking()
        h.transactions.ids.withLock { $0 = ["1000000000000001"] }
        await h.makeReporter().sync(.launch)
        let identifiers = h.transport.requests(to: "/sdk/v1/identifiers")
        XCTAssertEqual(identifiers.count, 1)
        XCTAssertEqual(identifiers.first?.url?.absoluteString, "https://revflare.example.com/sdk/v1/identifiers")
        XCTAssertEqual(identifiers.first?.httpMethod, "POST")
        XCTAssertEqual(identifiers.first?.value(forHTTPHeaderField: "X-Revflare-Key"), "rfp_test")

        let reports = h.transport.requests(to: "/sdk/v1/report")
        XCTAssertEqual(reports.count, 2)
        for request in reports {
            let text = try json(request)
            for key in ["meta", "fbAnonId", "anonId", "idfa", "idfv", "extinfo", "attStatus"] {
                XCTAssertFalse(text.contains("\"\(key)\""), key)
            }
        }
    }

    func testRejectedBacksOffWithoutBlockingLinks() async {
        let h = Harness()
        h.setMetaAnonymousId()
        h.transport.enqueue(.status(200, resolved), .status(400, #"{"error":"Bad identifiers"}"#))
        let reporter = h.makeReporter()
        await reporter.sync(.launch)
        XCTAssertEqual(h.transport.requests.current.count, 2)
        let fingerprint = await reporter.snapshot.identifiersFingerprint
        XCTAssertNil(fingerprint)

        // A new purchase is still linked; the identifiers wait, even when the app asks for a re-check.
        h.transactions.ids.withLock { $0 = ["1000000000000002"] }
        await reporter.sync(.transactionUpdate)
        await reporter.sync(.identifiers)
        XCTAssertEqual(h.transport.requests.current.count, 3)
        XCTAssertEqual(h.transport.bodies.last?.originalTransactionIds, ["1000000000000002"])
        XCTAssertEqual(h.transport.requests(to: "/sdk/v1/identifiers").count, 1)

        // After the long backoff: sent again.
        h.clock.advance(Reporter.rejectedBackoff + 1)
        h.transport.enqueue(.status(200, ok))
        await reporter.sync(.manual)
        XCTAssertEqual(h.transport.requests(to: "/sdk/v1/identifiers").count, 2)
        let accepted = await reporter.snapshot.identifiersFingerprint
        XCTAssertNotNil(accepted)
    }

    func testIdentifierFailureDoesNotBlockLinksAndRecheckSkipsNetworkBackoff() async {
        let h = Harness()
        h.transport.enqueue(.status(200, resolved))
        let reporter = h.makeReporter()
        await reporter.sync(.launch)

        h.collectDeviceIdentifiers()
        h.transport.enqueue(.status(503, ""))
        await reporter.sync(.identifiers)
        XCTAssertEqual(h.transport.requests(to: "/sdk/v1/identifiers").count, 1)

        // Backing off: an ordinary pass does not retry them, but links still go out.
        h.transactions.ids.withLock { $0 = ["1000000000000003"] }
        await reporter.sync(.transactionUpdate)
        XCTAssertEqual(h.transport.bodies.last?.originalTransactionIds, ["1000000000000003"])
        XCTAssertEqual(h.transport.requests(to: "/sdk/v1/identifiers").count, 1)

        // An explicit re-check (e.g. right after the ATT prompt) does not wait for the network backoff.
        await reporter.sync(.identifiers)
        XCTAssertEqual(h.transport.requests(to: "/sdk/v1/identifiers").count, 2)
        let accepted = await reporter.snapshot.identifiersFingerprint
        XCTAssertNotNil(accepted)
    }

    func testOldStateDecodes() throws {
        let old = #"{"server":"https://revflare.example.com","attribution":"resolved","failures":0,"reportedTransactionIds":["1000000000000001"]}"#
        let state = try JSONDecoder().decode(ReporterState.self, from: Data(old.utf8))
        XCTAssertEqual(state.attribution, .resolved)
        XCTAssertEqual(state.reportedTransactionIds, ["1000000000000001"])
        XCTAssertNil(state.identifiersFingerprint)

        // A pre-release 1.2.0 build stored "metaFingerprint": ignored.
        let prerelease = #"{"server":"https://revflare.example.com","attribution":"pending","failures":0,"reportedTransactionIds":[],"metaFingerprint":"x"}"#
        XCTAssertNil(try JSONDecoder().decode(ReporterState.self, from: Data(prerelease.utf8)).identifiersFingerprint)
    }

    func testOldStateKeepsProgressInReporter() async {
        let h = Harness()
        let old = #"{"server":"https://revflare.example.com","attribution":"resolved","failures":0,"reportedTransactionIds":[]}"#
        h.store.set(Data(old.utf8), forKey: Reporter.stateKey)
        h.setMetaAnonymousId()
        await h.makeReporter().sync(.launch)
        // No token resent: one token-less report (state from before 1.8 learns its source once), the identifiers.
        XCTAssertEqual(h.transport.requests.current.count, 2)
        XCTAssertEqual(h.transport.bodies.map(\.attributionToken), [nil])
        XCTAssertEqual(h.transport.identifierBodies.count, 1)
    }

    func testExtinfoLayout() async {
        let info = await SystemDeviceIdentifierProvider().deviceIdentifiers()
        XCTAssertEqual(info.extinfo.count, 16)
        XCTAssertEqual(info.extinfo.first, "i2")
        XCTAssertEqual(info.extinfo[15], TimeZone.current.identifier)
        XCTAssertEqual(info.timeZone, TimeZone.current.identifier)
        XCTAssertFalse(info.extinfo[5].isEmpty)
        XCTAssertEqual(info.extinfo[5], info.deviceModel)
        XCTAssertNotNil(Int(info.extinfo[12]))
        XCTAssertFalse(info.locale.contains("-"))
        XCTAssertFalse(info.locale.contains("@"))
        XCTAssertNotEqual(info.attStatus, .authorized)
        XCTAssertNil(info.idfa)

        let built = SystemDeviceIdentifierProvider.extinfo(
            bundleId: "com.example.app", appVersion: "1.2.3", buildVersion: "45", osVersion: "18.1", model: "iPhone15,2",
            locale: "en_US", timeZoneAbbreviation: "GMT+3", carrier: "", screenWidth: 393, screenHeight: 852,
            screenScale: 3, cpuCores: 6, totalDiskGB: 119, freeDiskGB: 42, timeZoneIdentifier: "Europe/Istanbul"
        )
        XCTAssertEqual(built, ["i2", "com.example.app", "1.2.3", "45", "18.1", "iPhone15,2", "en_US", "GMT+3", "", "393",
                               "852", "3.00", "6", "119", "42", "Europe/Istanbul"])
    }

    func testLocaleIdentifier() {
        XCTAssertEqual(SystemDeviceIdentifierProvider.localeIdentifier("en_US"), "en_US")
        XCTAssertEqual(SystemDeviceIdentifierProvider.localeIdentifier("en-US"), "en_US")
        XCTAssertEqual(SystemDeviceIdentifierProvider.localeIdentifier("tr_TR@rg=gbzzzz"), "tr_TR")
    }

    func testIdentifiersJSONShape() throws {
        let client = ReportClient(server: URL(string: "https://revflare.example.com")!, sdkKey: "rfp_abc", transport: FakeTransport())
        let body = IdentifiersBody(
            installId: "0f8fad5b-d9cb-469f-a165-70867728950e", fbAnonId: "XZanon", idfa: nil, idfv: FakeDeviceIdentifiers.idfv,
            attStatus: "denied", bundleId: "com.example.app", appVersion: "1.0", appBuild: "1", osVersion: "18.1",
            deviceModel: "iPhone15,2", locale: "en_US", timeZone: "Europe/Istanbul", extinfo: ["i2"]
        )
        let request = try client.makeRequest(body, to: .identifiers)
        XCTAssertEqual(request.url?.absoluteString, "https://revflare.example.com/sdk/v1/identifiers")
        XCTAssertEqual(try json(request), #"{"appBuild":"1","appVersion":"1.0","attStatus":"denied","bundleId":"com.example.app","deviceModel":"iPhone15,2","extinfo":["i2"],"fbAnonId":"XZanon","idfa":null,"idfv":"7C9E6679-7425-40DE-944B-E07FC1F90AE7","installId":"0f8fad5b-d9cb-469f-a165-70867728950e","locale":"en_US","osVersion":"18.1","timeZone":"Europe/Istanbul"}"#)
    }
}

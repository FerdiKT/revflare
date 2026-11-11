import Foundation
import XCTest
@testable import RevflareKit

private let experimentJSON = #"""
{ "version": "e1", "values": { "paywall_variant": "b", "trial_days": 7, "onboarding_version": "v2" },
  "conditions": [], "country": "US",
  "experiments": [ { "id": "exp_paywall1", "variant": "b", "keys": ["paywall_variant", "trial_days"] } ] }
"""#

private let reassignedJSON = #"""
{ "version": "e2", "values": { "paywall_variant": "c", "trial_days": 3 },
  "experiments": [ { "id": "exp_paywall1", "variant": "c", "keys": ["paywall_variant", "trial_days"] } ] }
"""#

private func ok(_ body: String) -> FakeTransport.Reply {
    .response(200, body, ["Content-Type": "application/json"])
}

private let exposureB = ["experiment": "exp_paywall1", "variant": "exp_paywall1:b"]

final class ExperimentDecodingTests: XCTestCase {
    func testDecodesExperiments() throws {
        let response = try JSONDecoder().decode(RemoteConfigResponse.self, from: Data(experimentJSON.utf8))
        XCTAssertEqual(response.experiments, [
            RevflareExperiment(id: "exp_paywall1", variant: "b", keys: ["paywall_variant", "trial_days"]),
        ])
        XCTAssertEqual(response.values["trial_days"], .number(7))
    }

    func testMissingExperimentsMeansNone() throws {
        let response = try JSONDecoder().decode(RemoteConfigResponse.self,
                                                from: Data(#"{ "version": "v", "values": { "a": 1 } }"#.utf8))
        XCTAssertEqual(response.experiments, [])
        let null = try JSONDecoder().decode(RemoteConfigResponse.self,
                                            from: Data(#"{ "version": "v", "values": {}, "experiments": null }"#.utf8))
        XCTAssertEqual(null.experiments, [])
    }

    func testMalformedEntriesAreSkipped() throws {
        let json = #"""
        { "version": "v", "values": {}, "experiments": [ { "id": "a", "variant": "x" }, { "id": "b" }, 3,
          { "id": "", "variant": "y" }, { "id": "c", "variant": "z", "keys": "nope" } ] }
        """#
        let response = try JSONDecoder().decode(RemoteConfigResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.experiments, [
            RevflareExperiment(id: "a", variant: "x", keys: []),
            RevflareExperiment(id: "c", variant: "z", keys: []),
        ])
        // A bad `experiments` field never costs the values.
        let wrong = try JSONDecoder().decode(RemoteConfigResponse.self,
                                             from: Data(#"{ "version": "v", "values": { "a": 1 }, "experiments": {} }"#.utf8))
        XCTAssertEqual(wrong.values["a"], .number(1))
        XCTAssertEqual(wrong.experiments, [])
    }
}

@MainActor
final class ExperimentExposureTests: XCTestCase {
    private func enrolledApp(_ body: String = experimentJSON) async -> (RemoteConfigHarness, RevflareRemoteConfig) {
        let app = RemoteConfigHarness()
        app.transport.enqueue(ok(body))
        let config = app.configuredLaunch()
        await config.fetchAndActivate()
        return (app, config)
    }

    func testPublicAPI() async {
        let (_, config) = await enrolledApp()
        let experiment = RevflareExperiment(id: "exp_paywall1", variant: "b", keys: ["paywall_variant", "trial_days"])
        XCTAssertEqual(config.experiments, [experiment])
        XCTAssertEqual(config.experiment("exp_paywall1"), experiment)
        XCTAssertNil(config.experiment("exp_other"))
        XCTAssertEqual(config.variant(forExperiment: "exp_paywall1"), "b")
        XCTAssertNil(config.variant(forExperiment: "exp_other"))
    }

    func testFirstReadOfAnExperimentKeyTracksExposureOnce() async {
        let (app, config) = await enrolledApp()
        XCTAssertTrue(app.tracked.isEmpty, "activating records nothing")
        _ = config.variant(forExperiment: "exp_paywall1")
        _ = config.experiments
        _ = config.source(for: "paywall_variant")
        XCTAssertTrue(app.tracked.isEmpty, "only reading a parameter is an exposure")

        XCTAssertEqual(config.string("paywall_variant"), "b")
        XCTAssertEqual(app.tracked.count, 1)
        XCTAssertEqual(app.tracked.first?.name, "experiment_exposure")
        XCTAssertEqual(app.tracked.first?.props, exposureB)

        // Other getters, the other key, the subscript, decode: no second event.
        XCTAssertEqual(config.int("trial_days"), 7)
        _ = config["paywall_variant"]
        _ = config.json("trial_days")
        _ = config.decode("trial_days", as: Int.self)
        _ = config.bool("paywall_variant")
        XCTAssertEqual(app.tracked.count, 1)
    }

    func testEveryGetterCounts() async {
        let reads: [(RevflareRemoteConfig) -> Void] = [
            { _ = $0.int("trial_days") }, { _ = $0.double("trial_days") }, { _ = $0.bool("trial_days") },
            { _ = $0["trial_days"] }, { _ = $0.json("trial_days") }, { _ = $0.decode("trial_days", as: Int.self) },
        ]
        for read in reads {
            let (app, config) = await enrolledApp()
            read(config)
            XCTAssertEqual(app.tracked.map(\.props), [exposureB])
        }
    }

    func testNonExperimentKeysTrackNothing() async {
        let (app, config) = await enrolledApp()
        XCTAssertEqual(config.string("onboarding_version"), "v2")
        XCTAssertEqual(config.int("missing", default: 1), 1)
        XCTAssertTrue(app.tracked.isEmpty)
    }

    func testDefaultSourcedValuesOfAnExperimentKeyAreExposures() async {
        let app = RemoteConfigHarness()
        // The control keeps the app's defaults: the server sends no value for its keys. Reading one is still an
        // exposure, else the control would be under-exposed against the variants (sample-ratio mismatch).
        app.transport.enqueue(ok(#"""
        { "version": "e1", "values": { "onboarding_version": "v2", "paywall_variant": null },
          "experiments": [ { "id": "exp_paywall1", "variant": "a", "keys": ["paywall_variant", "trial_days"] } ] }
        """#))
        let config = app.configuredLaunch()
        config.setDefaults(["trial_days": 3, "paywall_variant": "a"])
        await config.fetchAndActivate()

        XCTAssertEqual(config.string("onboarding_version"), "v2")
        XCTAssertTrue(app.tracked.isEmpty)
        XCTAssertEqual(config.int("trial_days"), 3)
        XCTAssertEqual(config.source(for: "trial_days"), .default)
        XCTAssertEqual(config.string("paywall_variant"), "a")
        XCTAssertEqual(app.tracked.map(\.props), [["experiment": "exp_paywall1", "variant": "exp_paywall1:a"]])
    }

    func testReadWithoutAnyValueIsAnExposure() async {
        let (app, config) = await enrolledApp(#"""
        { "version": "e2", "values": {},
          "experiments": [ { "id": "exp_paywall1", "variant": "a", "keys": ["paywall_variant"] } ] }
        """#)
        XCTAssertEqual(config.string("paywall_variant", default: "classic"), "classic")
        XCTAssertEqual(app.tracked.map(\.props), [["experiment": "exp_paywall1", "variant": "exp_paywall1:a"]])
    }

    func testNoExperimentsNoExposure() async {
        let app = RemoteConfigHarness()
        app.transport.enqueue(ok(#"{ "version": "v", "values": { "paywall_variant": "b" } }"#))
        let config = app.configuredLaunch()
        await config.fetchAndActivate()
        XCTAssertEqual(config.string("paywall_variant"), "b")
        XCTAssertEqual(config.experiments, [])
        XCTAssertTrue(app.tracked.isEmpty)
    }

    func testOnceAcrossRelaunches() async {
        let (app, first) = await enrolledApp()
        _ = first.string("paywall_variant")
        XCTAssertEqual(app.tracked.count, 1)

        // Next launch, offline: cached experiments are there and already exposed.
        app.transport.defaultReply = .networkError
        let second = app.launch()
        XCTAssertEqual(second.variant(forExperiment: "exp_paywall1"), "b")
        _ = second.string("paywall_variant")
        _ = second.int("trial_days")
        XCTAssertEqual(app.tracked.count, 1)
    }

    func testCachedValuesCountAsRemote() async {
        let app = RemoteConfigHarness()
        app.transport.enqueue(ok(experimentJSON))
        await app.configuredLaunch().fetchAndActivate()
        XCTAssertTrue(app.tracked.isEmpty)

        // Next launch, offline, before configure: the first read comes from the disk and is an exposure.
        app.transport.defaultReply = .networkError
        let second = app.launch()
        XCTAssertEqual(second.source(for: "paywall_variant"), .remote)
        XCTAssertEqual(second.string("paywall_variant"), "b")
        XCTAssertEqual(app.tracked.map(\.props), [exposureB])
    }

    func testVariantChangeTracksAgain() async {
        let (app, config) = await enrolledApp()
        _ = config.string("paywall_variant")
        app.transport.enqueue(ok(reassignedJSON))
        await config.fetchAndActivate()
        XCTAssertEqual(config.variant(forExperiment: "exp_paywall1"), "c")
        XCTAssertEqual(config.string("paywall_variant"), "c")
        _ = config.int("trial_days")
        XCTAssertEqual(app.tracked.map(\.props), [
            exposureB,
            ["experiment": "exp_paywall1", "variant": "exp_paywall1:c"],
        ])
    }

    func testManualTrackExposure() async {
        let (app, config) = await enrolledApp()
        XCTAssertFalse(config.trackExposure(experiment: "exp_other"))
        XCTAssertTrue(app.tracked.isEmpty)
        XCTAssertTrue(config.trackExposure(experiment: "exp_paywall1"))
        XCTAssertTrue(config.trackExposure(experiment: "exp_paywall1"))
        _ = config.string("paywall_variant")
        XCTAssertEqual(app.tracked.count, 1)
        XCTAssertEqual(app.tracked.first?.name, "experiment_exposure")
        XCTAssertEqual(app.tracked.first?.props, exposureB)
    }

    func testAnalyticsOffTracksNothingAndExposesLater() async {
        let (app, config) = await enrolledApp()
        app.analyticsEnabled = false
        _ = config.string("paywall_variant")
        config.trackExposure(experiment: "exp_paywall1")
        XCTAssertTrue(app.tracked.isEmpty)

        // Not remembered while off: recorded once the user opts in.
        app.analyticsEnabled = true
        _ = config.string("paywall_variant")
        XCTAssertEqual(app.tracked.map(\.props), [exposureB])
    }

    func testExposureEventPassesTheSanitizer() throws {
        let event = try XCTUnwrap(EventSanitizer.event(name: RevflareRemoteConfig.exposureEvent,
                                                       properties: exposureB, at: Date()))
        XCTAssertEqual(event.name, "experiment_exposure")
        XCTAssertEqual(event.props, exposureB)
    }

    func testExposureStoreKeepsTheNewest() {
        let store = MemoryStore()
        var exposures = ExperimentExposureStore(store: store)
        for index in 0..<(ExperimentExposureStore.maxEntries + 5) {
            XCTAssertTrue(exposures.insert(experiment: "exp\(index)", variant: "a"))
        }
        XCTAssertFalse(exposures.insert(experiment: "exp10", variant: "a"))
        let reloaded = ExperimentExposureStore(store: store)
        XCTAssertFalse(reloaded.contains(experiment: "exp0", variant: "a"))
        XCTAssertTrue(reloaded.contains(experiment: "exp5", variant: "a"))
        XCTAssertFalse(reloaded.contains(experiment: "exp5", variant: "b"))
    }
}

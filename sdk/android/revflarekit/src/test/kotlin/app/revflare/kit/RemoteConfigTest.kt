package app.revflare.kit

import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteConfigTest {
    private val base = 1_760_000_000_000L

    private class FixedContext(var value: RemoteConfigContext) : RemoteConfigContextProvider {
        override suspend fun context(): RemoteConfigContext = value
    }

    private fun context(attribution: RevflareAttribution = RevflareAttribution.UNKNOWN) = RemoteConfigContext(
        installId = INSTALL_ID, appVersion = "1.2.0", appBuild = "42", osVersion = "15", locale = "en_US",
        storefront = "TR", attribution = attribution, environment = "production",
    )

    private val body = """{"version":"v7","values":{"onboarding":"v2","max_free":3,"ratio":"2.5","flag":"yes","paywall":{"title":"Go Pro"},
        |"paywall_json":"{\"a\":1}"},"conditions":["Turkey"],"country":"TR",
        |"experiments":[{"id":"exp_paywall","variant":"b","keys":["paywall","price_test"]},{"variant":"x"}]}""".trimMargin()

    private class Harness(val config: RevflareRemoteConfig, val transport: FakeTransport, val events: MutableList<Pair<String, Map<String, String>>>, val provider: FixedContext)

    private fun TestScope.harness(
        store: MemoryKeyValueStore = MemoryKeyValueStore(),
        transport: FakeTransport = FakeTransport { ok(body, mapOf("ETag" to "\"v7\"")) },
        analytics: () -> Boolean = { true },
        autoFetch: Boolean = true,
        start: Boolean = true,
    ): Harness {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val config = RevflareRemoteConfig({ base + testScheduler.currentTime }, analytics) { name, props -> events.add(name to props) }
        config.autoFetch = autoFetch
        config.attach(store)
        val provider = FixedContext(context())
        if (start) config.start(RemoteConfigFetcher(client(transport), provider) { base + testScheduler.currentTime }, backgroundScope)
        return Harness(config, transport, events, provider)
    }

    @Test
    fun queryCarriesTheContextInAStableOrder() {
        val ctx = context(RevflareAttribution.of("google_ads", "123", null, null))
        val url = client(FakeTransport()).url(RevflareClient.Path.CONFIG, ctx.queryItems)
        assertEquals(
            "$SERVER/sdk/v1/config?installId=$INSTALL_ID&appVersion=1.2.0&appBuild=42&osVersion=15&locale=en_US&storefront=TR" +
                "&source=google_ads&campaign=123&environment=production&sdk=${Revflare.VERSION}",
            url,
        )
    }

    @Test
    fun launchFetchesAndActivates() = runTest {
        val h = harness()
        h.config.setDefaults(mapOf("onboarding" to "v1", "only_default" to 7, "max_free" to 1))
        runCurrent()
        val config = h.config
        assertEquals("v2", config.string("onboarding"))
        assertEquals(3, config.int("max_free"))
        assertEquals(7L, config.long("only_default"))
        assertEquals(2.5, config.double("ratio"), 0.0)
        assertTrue(config.bool("flag"))
        assertEquals("Go Pro", config.json("paywall")?.get("title")?.stringValue)
        assertEquals(1, config.json("paywall_json")?.get("a")?.intValue)
        assertEquals("fallback", config.string("missing", "fallback"))
        assertEquals(RemoteConfigValueSource.REMOTE, config.source("onboarding"))
        assertEquals(RemoteConfigValueSource.DEFAULT, config.source("only_default"))
        assertEquals(RemoteConfigValueSource.STATIC, config.source("missing"))
        val info = config.info.value
        assertTrue(info.isLoaded)
        assertEquals("v7", info.version)
        assertEquals(listOf("Turkey"), info.conditions)
        assertEquals("TR", info.country)
        assertEquals(RemoteConfigFetchStatus.SUCCESS, info.lastFetchStatus)
        assertEquals(listOf(RevflareExperiment("exp_paywall", "b", listOf("paywall", "price_test"))), info.experiments)
    }

    @Test
    fun cachedValuesApplyAtOnceOnTheNextLaunchAndRevalidateWithTheEtag() = runTest {
        val store = MemoryKeyValueStore()
        harness(store)
        runCurrent()
        val transport = FakeTransport { status(304) }
        val next = harness(store, transport, start = false)
        // Before configure finishes: the last server's values.
        assertEquals("v2", next.config.string("onboarding"))
        assertTrue(next.config.info.value.isLoaded)
        next.config.start(RemoteConfigFetcher(client(transport), next.provider) { base + testScheduler.currentTime }, backgroundScope)
        runCurrent()
        assertEquals("\"v7\"", transport.gets("config").single().headers["If-None-Match"])
        assertEquals("v2", next.config.string("onboarding"))
        assertEquals(RemoteConfigFetchStatus.SUCCESS, next.config.info.value.lastFetchStatus)
    }

    @Test
    fun aDifferentContextSendsNoEtag() = runTest {
        val store = MemoryKeyValueStore()
        harness(store)
        runCurrent()
        val transport = FakeTransport { ok(body) }
        val next = harness(store, transport, start = false)
        next.provider.value = context(RevflareAttribution.of("google_ads", "1", null, null))
        next.config.start(RemoteConfigFetcher(client(transport), next.provider) { base }, backgroundScope)
        runCurrent()
        assertNull(transport.gets("config").single().headers["If-None-Match"])
    }

    @Test
    fun fetchWithoutActivateKeepsValuesInUse() = runTest {
        val h = harness(autoFetch = false)
        h.config.setDefaults(mapOf("onboarding" to "v1"))
        assertEquals(RemoteConfigFetchStatus.SUCCESS, h.config.fetch())
        assertEquals("v1", h.config.string("onboarding"))
        assertNotNull(h.config.storedState.pending)
        assertTrue(h.config.activate())
        assertEquals("v2", h.config.string("onboarding"))
        assertFalse(h.config.activate())
    }

    @Test
    fun failuresKeepDefaultsAndReportStatus() = runTest {
        val h = harness(transport = FakeTransport { status(500) }, autoFetch = false)
        h.config.setDefaults(mapOf("onboarding" to "v1"))
        assertFalse(h.config.fetchAndActivate())
        assertEquals("v1", h.config.string("onboarding"))
        assertEquals(RemoteConfigFetchStatus.FAILURE, h.config.info.value.lastFetchStatus)
        h.transport.handler = { status(429) }
        h.config.fetchAndActivate()
        assertEquals(RemoteConfigFetchStatus.THROTTLED, h.config.info.value.lastFetchStatus)
    }

    @Test
    fun readingAnExperimentKeyTracksExposureOncePerVariant() = runTest {
        val store = MemoryKeyValueStore()
        val h = harness(store)
        runCurrent()
        h.config.string("onboarding")
        assertTrue(h.events.isEmpty())
        h.config.json("paywall")
        h.config.string("paywall")
        // A key of the experiment without a remote value (the control keeps the app default) also counts.
        h.config.string("price_test", "default")
        assertEquals(listOf("experiment_exposure" to mapOf("experiment" to "exp_paywall", "variant" to "exp_paywall:b")), h.events)
        // Remembered across launches.
        val next = harness(store, start = false)
        next.config.json("paywall")
        assertTrue(next.events.isEmpty())
        assertEquals("b", next.config.variant("exp_paywall"))
        assertTrue(next.config.trackExposure("exp_paywall"))
        assertTrue(next.events.isEmpty())
        assertFalse(next.config.trackExposure("exp_unknown"))
    }

    @Test
    fun noExposureIsRememberedWhileAnalyticsIsOff() = runTest {
        val store = MemoryKeyValueStore()
        var analytics = false
        val h = harness(store, analytics = { analytics })
        runCurrent()
        h.config.json("paywall")
        assertTrue(h.events.isEmpty())
        analytics = true
        h.config.json("paywall")
        assertEquals(1, h.events.size)
    }

    @Test
    fun attributionChangeFetchesIntoThePendingSlot() = runTest {
        val h = harness()
        runCurrent()
        val changed = """{"version":"v8","values":{"onboarding":"hard_paywall"}}"""
        h.transport.handler = { ok(changed) }
        val attribution = RevflareAttribution.of("google_ads", "9", null, null)
        h.provider.value = context(attribution)
        h.config.attributionChanged(attribution)
        assertEquals("v2", h.config.string("onboarding"))
        assertEquals(attribution, h.config.info.value.attribution)
        h.config.foregroundRefresh()
        assertEquals("hard_paywall", h.config.string("onboarding"))
    }

    @Test
    fun conversions() {
        assertEquals("1", RemoteConfigValue.string(RevflareJson.Number(1.0)))
        assertEquals("2.5", RemoteConfigValue.string(RevflareJson.Number(2.5)))
        assertEquals("{\"a\":[1,true]}", RemoteConfigValue.string(RevflareJson.parse("{\"a\":[1,true]}")))
        assertEquals(true, RemoteConfigValue.bool(RevflareJson.Str("ON")))
        assertEquals(false, RemoteConfigValue.bool(RevflareJson.Str("0")))
        assertNull(RemoteConfigValue.bool(RevflareJson.Str("maybe")))
        assertEquals(3L, RemoteConfigValue.long(RevflareJson.Number(3.9)))
        assertEquals(12L, RemoteConfigValue.long(RevflareJson.Str(" 12 ")))
        assertEquals(1L, RemoteConfigValue.long(RevflareJson.Bool(true)))
    }

    @Test
    fun malformedExperimentsAreSkipped() {
        val parsed = RemoteConfigResponse.parse("""{"version":"1","values":{},"experiments":[{"id":"a"},{"id":"b","variant":"c"},3]}""")
        assertEquals(listOf(RevflareExperiment("b", "c", emptyList())), parsed.experiments)
    }
}

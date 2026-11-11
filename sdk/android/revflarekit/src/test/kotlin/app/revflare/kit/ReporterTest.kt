package app.revflare.kit

import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReporterTest {
    private val base = 1_760_000_000_000L

    private class Harness(
        val reporter: Reporter,
        val transport: FakeTransport,
        val referrer: FakeReferrer,
        val billing: FakeBilling,
        val store: MemoryKeyValueStore,
        val devices: FakeDeviceIdentifiers,
    )

    private fun TestScope.harness(
        transport: FakeTransport = FakeTransport(),
        referrer: FakeReferrer = FakeReferrer(),
        billing: FakeBilling = FakeBilling(),
        store: MemoryKeyValueStore = MemoryKeyValueStore(),
        devices: FakeDeviceIdentifiers = FakeDeviceIdentifiers(),
        changes: MutableList<RevflareAttribution> = mutableListOf(),
    ): Harness {
        val reporter = Reporter(
            client(transport),
            ReporterEnvironment(
                referrer = referrer,
                purchases = billing,
                store = store,
                identity = memoryIdentity(store),
                appVersion = "1.2.0",
                deviceIdentifiers = devices,
                clock = { base + testScheduler.currentTime },
                serial = StandardTestDispatcher(testScheduler),
                scope = backgroundScope,
                onAttributionChange = { changes.add(it) },
                retryInSession = false,
            ),
        )
        return Harness(reporter, transport, referrer, billing, store, devices)
    }

    @Test
    fun baseOrderIdStripsRenewalSuffix() {
        assertEquals("GPA.3301-2345-6789-01234", Reporter.baseOrderId("GPA.3301-2345-6789-01234..5"))
        assertEquals("GPA.3301-2345-6789-01234", Reporter.baseOrderId("GPA.3301-2345-6789-01234..0"))
        assertEquals("GPA.3301-2345-6789-01234", Reporter.baseOrderId("GPA.3301-2345-6789-01234"))
        assertNull(Reporter.baseOrderId(""))
        assertNull(Reporter.baseOrderId(null))
    }

    @Test
    fun firstReportCarriesTheReferrerExactly() = runTest {
        val h = harness()
        h.reporter.sync(SyncTrigger.LAUNCH)
        val reports = h.transport.posts("report")
        assertEquals(1, reports.size)
        assertEquals(
            "{\"appVersion\":\"1.2.0\",\"environment\":\"production\",\"installId\":\"$INSTALL_ID\"," +
                "\"installReferrer\":{\"clickTs\":1700000000,\"installTs\":1700000100,\"referrer\":\"utm_source=google&gclid=abc\"}," +
                "\"installedAt\":$base,\"platform\":\"android\"}",
            reports[0].body,
        )
        assertEquals(SDK_KEY, reports[0].headers["X-Revflare-Key"])
        assertEquals("$SERVER/sdk/v1/report", reports[0].url)
        assertTrue(h.reporter.state.referrerAccepted)
    }

    @Test
    fun referrerIsReadOnceAndNotSentAgainAfterAcceptance() = runTest {
        val h = harness()
        h.transport.handler = { ok("{\"ok\":true,\"attribution\":\"resolved\",\"source\":\"organic\"}") }
        h.reporter.sync(SyncTrigger.LAUNCH)
        testScheduler.advanceTimeBy(120_000)
        h.reporter.sync(SyncTrigger.FOREGROUND)
        h.reporter.sync(SyncTrigger.MANUAL)
        assertEquals(1, h.referrer.reads)
        assertEquals(1, h.transport.posts("report").size)
    }

    @Test
    fun referrerIsResentUntilTheServerAcceptsIt() = runTest {
        val h = harness()
        h.transport.handler = { status(503) }
        h.reporter.sync(SyncTrigger.LAUNCH)
        assertFalse(h.reporter.state.registered)
        assertFalse(h.reporter.state.referrerAccepted)
        // Backoff: nothing before a minute.
        h.reporter.sync(SyncTrigger.MANUAL)
        assertEquals(1, h.transport.posts("report").size)
        testScheduler.advanceTimeBy(61_000)
        h.transport.handler = { ok("{\"ok\":true,\"attribution\":\"pending\",\"source\":\"unknown\"}") }
        h.reporter.sync(SyncTrigger.MANUAL)
        val reports = h.transport.posts("report")
        assertEquals(2, reports.size)
        assertTrue(reports[1].body!!.contains("\"installReferrer\""))
        assertEquals(1, h.referrer.reads)
        assertTrue(h.reporter.state.referrerAccepted)
        // The poll (source unknown) carries no referrer any more.
        testScheduler.advanceTimeBy(61_000)
        h.reporter.sync(SyncTrigger.MANUAL)
        val poll = h.transport.posts("report").last()
        assertEquals(3, h.transport.posts("report").size)
        assertFalse(poll.body!!.contains("installReferrer"))
    }

    @Test
    fun transientReferrerErrorWaitsThenRegisters() = runTest {
        val referrer = FakeReferrer(ReferrerResult.Error("service unavailable"))
        val h = harness(referrer = referrer)
        h.reporter.sync(SyncTrigger.LAUNCH)
        assertEquals(0, h.transport.posts("report").size)
        assertEquals(ReporterState.REFERRER_WAITING, h.reporter.state.referrerStatus)
        referrer.result = ReferrerResult.Found(InstallReferrerData("utm_source=google-play&utm_medium=organic", 0, 0))
        h.reporter.sync(SyncTrigger.MANUAL)
        assertEquals(1, referrer.reads) // still backing off
        testScheduler.advanceTimeBy(61_000)
        h.reporter.sync(SyncTrigger.MANUAL)
        assertEquals(2, referrer.reads)
        assertEquals(1, h.transport.posts("report").size)
        assertTrue(h.transport.posts("report")[0].body!!.contains("utm_medium=organic"))
    }

    @Test
    fun unavailableReferrerRegistersWithoutIt() = runTest {
        val h = harness(referrer = FakeReferrer(ReferrerResult.Unavailable))
        h.reporter.sync(SyncTrigger.LAUNCH)
        val body = h.transport.posts("report").single().body!!
        assertFalse(body.contains("installReferrer"))
        assertTrue(h.reporter.state.registered)
    }

    @Test
    fun sourceAndCampaignAreStored() = runTest {
        val changes = mutableListOf<RevflareAttribution>()
        val h = harness(changes = changes)
        h.transport.handler = { ok("{\"ok\":true,\"attribution\":\"resolved\",\"source\":\"google_ads\",\"campaignId\":123456}") }
        h.reporter.sync(SyncTrigger.LAUNCH)
        val attribution = h.reporter.attribution
        assertEquals(RevflareAttribution.Source.GOOGLE_ADS, attribution.source)
        assertEquals("123456", attribution.campaignId)
        assertEquals(listOf(attribution), changes)
        assertNull(h.reporter.state.nextPollAt)
        // Kept across launches.
        assertEquals(attribution, ReporterState.load(h.store)!!.publicAttribution)
    }

    @Test
    fun unknownSourceIsPolledOnSchedule() = runTest {
        val h = harness()
        h.transport.handler = { ok("{\"ok\":true,\"attribution\":\"pending\",\"source\":\"unknown\"}") }
        h.reporter.sync(SyncTrigger.LAUNCH)
        assertEquals(base + 60_000, h.reporter.state.nextPollAt)
        testScheduler.advanceTimeBy(60_000)
        h.transport.handler = { ok("{\"ok\":true,\"attribution\":\"resolved\",\"source\":\"referral\",\"campaignId\":\"spring\"}") }
        h.reporter.sync(SyncTrigger.MANUAL)
        assertEquals(2, h.transport.posts("report").size)
        assertEquals(RevflareAttribution.Source.REFERRAL, h.reporter.attribution.source)
        assertNull(h.reporter.state.nextPollAt)
    }

    @Test
    fun purchasesAreReportedInBatchesOf90AndRemembered() = runTest {
        val billing = FakeBilling()
        repeat(200) { index ->
            billing.owned.add(purchase(token = "token-%03d".format(index), orderId = "GPA.1234-5678-9012-%05d..%d".format(index, index % 3), time = index.toLong()))
        }
        billing.owned.add(purchase(token = "pending", orderId = null, state = RevflarePurchase.State.PENDING))
        val h = harness(billing = billing)
        h.reporter.sync(SyncTrigger.LAUNCH)
        val links = h.transport.posts("report").drop(1)
        assertEquals(3, links.size)
        val sizes = links.map { RevflareJson.parse(it.body!!)["purchaseTokens"]!!.arrayValue!!.size }
        assertEquals(listOf(90, 90, 20), sizes)
        val first = RevflareJson.parse(links[0].body!!)
        assertEquals("GPA.1234-5678-9012-00000", first["orderIds"]!![0]!!.stringValue)
        assertEquals("token-000", first["purchaseTokens"]!![0]!!.stringValue)
        assertEquals("android", first["platform"]!!.stringValue)
        assertFalse(links.any { it.body!!.contains("\"pending\"") })
        assertEquals(200, h.reporter.state.reportedTokens.size)

        testScheduler.advanceTimeBy(120_000)
        h.reporter.sync(SyncTrigger.MANUAL)
        assertEquals(4, h.transport.posts("report").size)
    }

    @Test
    fun renewalsShareOneBaseOrderId() = runTest {
        val billing = FakeBilling()
        billing.owned.add(purchase(token = "a", orderId = "GPA.1111-2222-3333-44444..3"))
        billing.owned.add(purchase(token = "b", orderId = "GPA.1111-2222-3333-44444..4", product = "pro_annual"))
        val h = harness(billing = billing)
        h.reporter.sync(SyncTrigger.LAUNCH)
        val link = h.transport.posts("report").last().body!!
        assertTrue(link.contains("\"orderIds\":[\"GPA.1111-2222-3333-44444\"]"))
        assertTrue(link.contains("\"purchaseTokens\":[\"a\",\"b\"]"))
    }

    @Test
    fun attributionOnlyNeverAcknowledgesOrConsumes() = runTest {
        val billing = FakeBilling()
        billing.owned.add(purchase(token = "unacked", acknowledged = false))
        billing.owned.add(purchase(token = "coin", type = RevflarePurchase.PRODUCT_TYPE_INAPP, product = "coins_100", acknowledged = false))
        val h = harness(billing = billing)
        h.reporter.sync(SyncTrigger.LAUNCH)
        h.reporter.sync(SyncTrigger.PURCHASE_UPDATE)
        assertTrue(billing.acknowledged.isEmpty())
        assertTrue(billing.consumed.isEmpty())
        assertEquals(setOf("unacked", "coin"), h.reporter.state.reportedTokens)
    }

    @Test
    fun rejectedPurchaseReportBacksOffForAnHour() = runTest {
        val billing = FakeBilling().apply { owned.add(purchase(token = "t1")) }
        val h = harness(billing = billing)
        h.transport.handler = { request -> if (request.body!!.contains("purchaseTokens")) status(400, "bad") else ok() }
        h.reporter.sync(SyncTrigger.LAUNCH)
        assertEquals(2, h.transport.posts("report").size)
        testScheduler.advanceTimeBy(30 * 60_000)
        h.reporter.sync(SyncTrigger.MANUAL)
        assertEquals(2, h.transport.posts("report").size)
        testScheduler.advanceTimeBy(31 * 60_000)
        h.transport.handler = { ok() }
        h.reporter.sync(SyncTrigger.MANUAL)
        assertEquals(3, h.transport.posts("report").size)
        assertEquals(setOf("t1"), h.reporter.state.reportedTokens)
    }

    @Test
    fun identifiersOnlyAfterOptInAndOnlyWhenChanged() = runTest {
        val h = harness()
        h.reporter.sync(SyncTrigger.LAUNCH)
        assertTrue(h.transport.posts("identifiers").isEmpty())

        Reporter.optIn(h.store, "fb-anon-1")
        h.reporter.sync(SyncTrigger.IDENTIFIERS)
        val sent = h.transport.posts("identifiers")
        assertEquals(1, sent.size)
        val expected = "{\"appBuild\":\"42\",\"appVersion\":\"1.2.0\",\"attStatus\":\"authorized\",\"bundleId\":\"com.example.app\"," +
            "\"deviceModel\":\"Pixel 9\",\"environment\":\"production\",\"extinfo\":[\"a2\",\"com.example.app\",\"42\",\"1.2.0\",\"15\"," +
            "\"Pixel 9\",\"en_US\",\"GMT+03:00\",\"\",\"1080\",\"2400\",\"2.63\",\"8\",\"128\",\"64\",\"Europe/Istanbul\"]," +
            "\"fbAnonId\":\"fb-anon-1\",\"gaid\":\"38400000-8cf0-11bd-b23e-10b96e40000d\",\"installId\":\"$INSTALL_ID\"," +
            "\"locale\":\"en_US\",\"osVersion\":\"15\",\"platform\":\"android\",\"timeZone\":\"Europe/Istanbul\"}"
        assertEquals(expected, sent[0].body)

        h.reporter.sync(SyncTrigger.IDENTIFIERS)
        assertEquals(1, h.transport.posts("identifiers").size)

        h.devices.value = sampleDevice(gaid = null)
        h.reporter.sync(SyncTrigger.IDENTIFIERS)
        val second = h.transport.posts("identifiers")
        assertEquals(2, second.size)
        assertTrue(second[1].body!!.contains("\"gaid\":null"))
        assertTrue(second[1].body!!.contains("\"attStatus\":\"denied\""))
    }

    @Test
    fun anotherServerStartsOver() = runTest {
        val store = MemoryKeyValueStore()
        store.set(Reporter.STATE_KEY, ReporterState(server = "https://old.example.com", registered = true).toJson().toJsonString())
        val h = harness(store = store)
        assertFalse(h.reporter.state.registered)
        assertEquals(SERVER, h.reporter.state.server)
        assertNotNull(h)
    }

    @Test
    fun backoffGrowsAndCaps() {
        assertEquals(60_000L, Reporter.backoff(1))
        assertEquals(120_000L, Reporter.backoff(2))
        assertEquals(6 * 3600_000L, Reporter.backoff(30))
        assertEquals(listOf(60_000L, 300_000L, 900_000L, 3_600_000L, 10_800_000L), (0..4).map { Reporter.pollDelay(it) })
    }
}

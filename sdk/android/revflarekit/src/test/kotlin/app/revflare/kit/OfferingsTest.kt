package app.revflare.kit

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class OfferingsTest {
    private val body = """
        {"version":"abc123","currentOfferingId":"default",
         "offerings":[
           {"identifier":"default","displayName":"Default","metadata":{"title":"Go Pro","features":["No ads"]},
            "packages":[
              {"identifier":"${'$'}annual","productId":"pro:annual","metadata":{"badge":"Best value"}},
              {"identifier":"${'$'}monthly","productId":"pro:monthly"},
              {"identifier":"${'$'}lifetime","productId":"pro_lifetime"},
              {"identifier":"${'$'}weekly","productId":"missing_product"}
            ]},
           {"identifier":"onboarding","packages":[{"identifier":"${'$'}annual","productId":"pro:annual"}]},
           {"displayName":"no identifier"},
           {"identifier":"broken","packages":[{"identifier":"x"}]}
         ],
         "placements":{"onboarding":"onboarding","settings":null,"old":"deleted_offering","weird":3}}
    """.trimIndent()

    @Test
    fun parsesLeniently() {
        val response = OfferingsResponse.parse(body)
        assertEquals("abc123", response.version)
        assertEquals(listOf("default", "onboarding", "broken"), response.offerings.map { it.identifier })
        assertEquals("onboarding", response.offerings[1].displayName)
        assertTrue(response.offerings[2].packages.isEmpty())
        assertEquals(mapOf("onboarding" to "onboarding", "settings" to null, "old" to "deleted_offering"), response.placements)
        assertEquals(listOf("pro:annual", "pro:monthly", "pro_lifetime", "missing_product"), response.productIds)
        assertEquals("Go Pro", response.offerings[0].metadata["title"]?.stringValue)
    }

    @Test
    fun packagesWithoutAProductAreDroppedAndPlacementsResolve() {
        val response = OfferingsResponse.parse(body)
        val products = mapOf("pro:annual" to "A", "pro:monthly" to "M", "pro_lifetime" to "L")
        val snapshot = OfferingsSnapshot(response, products)
        assertEquals(listOf("missing_product"), snapshot.droppedProductIds)
        assertEquals(listOf("\$annual", "\$monthly", "\$lifetime"), snapshot.current!!.packages.map { it.identifier })
        assertEquals("A", snapshot.current!!.packages[0].product)
        assertEquals("Best value", snapshot.current!!.packages[0].metadata["badge"]?.stringValue)
        assertEquals("onboarding", snapshot.offeringForPlacement("onboarding")!!.identifier)
        assertEquals("default", snapshot.offeringForPlacement("settings")!!.identifier)
        assertEquals("default", snapshot.offeringForPlacement("old")!!.identifier)
        assertEquals("default", snapshot.offeringForPlacement("unknown")!!.identifier)
        assertNull(OfferingRules.offeringId("x", emptyMap(), "gone", setOf("a")))
    }

    @Test
    fun specsSplitIntoProductAndBasePlan() {
        assertEquals("pro", productIdOf("pro:annual"))
        assertEquals("annual", basePlanIdOf("pro:annual"))
        assertNull(basePlanIdOf("pro"))
    }

    private fun offer(base: String, id: String?, vararg phases: PhaseInfo, tags: List<String> = emptyList()) =
        OfferInfo(base, id, "token-$base-${id ?: "base"}", tags, phases.toList())

    private val annualBase = PhaseInfo(29_990_000, "P1Y", 0, 1)

    @Test
    fun defaultOfferPrefersTheLongestFreeTrial() {
        val offers = listOf(
            offer("annual", null, annualBase),
            offer("annual", "trial3d", PhaseInfo(0, "P3D", 1, 2), annualBase),
            offer("annual", "trial1w", PhaseInfo(0, "P1W", 1, 2), annualBase),
            offer("annual", "intro", PhaseInfo(9_990_000, "P1Y", 1, 2), annualBase),
            offer("annual", "hidden", PhaseInfo(0, "P1M", 1, 2), annualBase, tags = listOf("revflare-ignore")),
            offer("monthly", "trial1m", PhaseInfo(0, "P1M", 1, 2), PhaseInfo(2_990_000, "P1M", 0, 1)),
        )
        assertEquals("trial1w", OfferSelection.defaultOffer(offers, "annual")!!.offerId)
    }

    @Test
    fun defaultOfferFallsBackToTheCheapestThenTheBasePlan() {
        val discounted = listOf(
            offer("annual", null, annualBase),
            offer("annual", "intro50", PhaseInfo(14_990_000, "P1Y", 1, 2), annualBase),
            offer("annual", "intro70", PhaseInfo(8_990_000, "P1Y", 1, 2), annualBase),
        )
        assertEquals("intro70", OfferSelection.defaultOffer(discounted, "annual")!!.offerId)
        val plain = listOf(offer("annual", null, annualBase))
        assertEquals("token-annual-base", OfferSelection.defaultOffer(plain, "annual")!!.offerToken)
    }

    @Test
    fun basePlanSelection() {
        val offers = listOf(
            offer("prepaid", null, PhaseInfo(9_990_000, "P1M", 1, 3)),
            offer("monthly", null, PhaseInfo(2_990_000, "P1M", 0, 1)),
        )
        assertEquals("monthly", OfferSelection.basePlan(offers, null))
        assertEquals("prepaid", OfferSelection.basePlan(offers, "prepaid"))
        assertNull(OfferSelection.basePlan(offers, "yearly"))
        assertEquals(7, OfferSelection.periodDays("P1W"))
        assertEquals(395, OfferSelection.periodDays("P1Y1M"))
    }

    private fun fetcher(transport: FakeTransport, store: MemoryKeyValueStore, clock: () -> Long) =
        OfferingsFetcher(client(transport), store, "1.2.0", clock)

    @Test
    fun cachesRevalidatesAndFallsBack() = runTest {
        var now = 1_000_000L
        val store = MemoryKeyValueStore()
        val transport = FakeTransport { ok(body, mapOf("ETag" to "\"abc123\"")) }
        val fetcher = fetcher(transport, store) { now }
        assertEquals("abc123", fetcher.offerings(OfferingsFetchPolicy.CACHED_OR_FETCHED).version)
        assertEquals("$SERVER/sdk/v1/offerings?appVersion=1.2.0", transport.requests.single().url)

        // Fresh: no request.
        now += 60_000
        fetcher.offerings(OfferingsFetchPolicy.CACHED_OR_FETCHED)
        assertEquals(1, transport.requests.size)

        // Stale: revalidated with the ETag (304).
        now += 5 * 60_000
        transport.handler = { status(304) }
        val next = fetcher(transport, store) { now }
        assertEquals("abc123", next.offerings(OfferingsFetchPolicy.CACHED_OR_FETCHED).version)
        assertEquals("\"abc123\"", transport.requests.last().headers["If-None-Match"])
        assertEquals(now, next.cachedEntry!!.fetchedAt)

        // Offline: the cached answer.
        transport.handler = { networkError() }
        assertEquals("abc123", next.offerings(OfferingsFetchPolicy.FETCH_CURRENT).version)
    }

    @Test
    fun errorsWithoutACache() = runTest {
        val transport = FakeTransport { status(404) }
        try {
            fetcher(transport, MemoryKeyValueStore()) { 0 }.offerings(OfferingsFetchPolicy.FETCH_CURRENT)
            fail("expected an error")
        } catch (error: RevflareOfferingsException.UnknownSdkKey) {
            // expected
        }
        transport.handler = { networkError() }
        try {
            fetcher(transport, MemoryKeyValueStore()) { 0 }.offerings(OfferingsFetchPolicy.FETCH_CURRENT)
            fail("expected an error")
        } catch (error: RevflareOfferingsException.Network) {
            // expected
        }
    }

    @Test
    fun serviceResolvesProductsOnceAndDropsMissingOnes() = runTest {
        val transport = FakeTransport { ok(body) }
        var calls = 0
        val catalog = object : ProductCatalog<String> {
            override suspend fun products(specs: Set<String>): Map<String, String> {
                calls++
                return specs.filter { it != "missing_product" }.associateWith { it.uppercase() }
            }
        }
        val service = OfferingsService(fetcher(transport, MemoryKeyValueStore()) { 0 }, catalog)
        val snapshot = service.offerings(OfferingsFetchPolicy.FETCH_CURRENT)
        assertEquals(listOf("PRO:ANNUAL", "PRO:MONTHLY", "PRO_LIFETIME"), snapshot.current!!.packages.map { it.product })
        service.offerings(OfferingsFetchPolicy.FETCH_CURRENT)
        assertEquals(2, calls) // the missing product is asked again, the others are kept
    }
}

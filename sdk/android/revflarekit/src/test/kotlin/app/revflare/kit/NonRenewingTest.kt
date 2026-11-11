package app.revflare.kit

import com.android.billingclient.api.BillingClient
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class NonRenewingTest {
    private val pass = "com.example.pass_3day"
    private val monthly = "com.example.monthly"
    private val lifetime = "com.example.lifetime"
    private val day = 86_400_000L
    private val base = utc("2026-03-10T12:00:00Z")

    private fun utc(text: String) = Instant.parse(text).toEpochMilli()

    private fun passPurchase(token: String, time: Long, product: String = pass, acknowledged: Boolean = true) =
        purchase(token, product = product, type = RevflarePurchase.PRODUCT_TYPE_INAPP, acknowledged = acknowledged, time = time)

    // Wire format

    private val serverBody = """
        {"version":"v2","currentOfferingId":"default","offerings":[{"identifier":"default","packages":[{"identifier":"${'$'}monthly","productId":"com.example.monthly"}]}],
         "placements":{},
         "entitlements":{"pro":["com.example.monthly","com.example.pass_3day",3],"empty":[],"bad":"x","extra":["com.example.addon"]},
         "products":{"com.example.pass_3day":{"duration":{"unit":"day","count":3}},
                     "com.example.pass_month":{"duration":{"unit":"MONTH","count":1}},
                     "com.example.zero":{"duration":{"unit":"day","count":0}},
                     "com.example.decade":{"duration":{"unit":"decade","count":1}},
                     "com.example.half":{"duration":{"unit":"week","count":1.5}},
                     "com.example.none":{}}}
    """.trimIndent()

    @Test
    fun parsesServerEntitlementsAndDurationsLeniently() {
        val response = OfferingsResponse.parse(serverBody)
        assertEquals(mapOf("pro" to listOf(monthly, pass), "extra" to listOf("com.example.addon")), response.serverProducts.entitlements)
        assertEquals(mapOf(pass to NonRenewingDuration.days(3), "com.example.pass_month" to NonRenewingDuration.months(1)), response.serverProducts.durations)
        assertEquals(listOf(monthly), response.productIds)
        assertEquals(listOf(monthly, "com.example.addon", pass, "com.example.pass_month"), response.allProductIds)

        val old = OfferingsResponse.parse("""{"version":"v1","offerings":[],"placements":{}}""")
        assertEquals(ServerProducts.EMPTY, old.serverProducts)
        val offerings = RevflareOfferings(OfferingsSnapshot(old, emptyMap()))
        assertTrue(offerings.entitlements.isEmpty())
        assertTrue(offerings.nonRenewingDurations.isEmpty())

        // Round trip of the copy kept on the device.
        assertEquals(response.serverProducts, ServerProducts.fromJson(response.serverProducts.toJson()))
    }

    @Test
    fun referencedProductsAreLoadedWithTheOfferings() = runTest {
        val asked = mutableListOf<Set<String>>()
        val catalog = object : ProductCatalog<String> {
            override suspend fun products(specs: Set<String>): Map<String, String> {
                asked.add(specs)
                return specs.filter { it != "com.example.pass_month" }.associateWith { it.uppercase() }
            }
        }
        val fetcher = OfferingsFetcher(client(FakeTransport { ok(serverBody) }), MemoryKeyValueStore(), "1.0", { 0 })
        val snapshot = OfferingsService(fetcher, catalog).offerings(OfferingsFetchPolicy.FETCH_CURRENT)
        assertEquals(setOf(monthly, "com.example.addon", pass, "com.example.pass_month"), asked.single())
        assertEquals(mapOf(monthly to monthly.uppercase(), "com.example.addon" to "COM.EXAMPLE.ADDON", pass to pass.uppercase()), snapshot.referencedProducts)
        assertEquals(listOf(monthly.uppercase()), snapshot.current!!.packages.map { it.product })
    }

    // Durations

    @Test
    fun durationEnds() {
        assertEquals(base + 3 * day, NonRenewingDuration.days(3).end(base))
        assertEquals(base + 14 * day, NonRenewingDuration.weeks(2).end(base))
        assertEquals(utc("2026-02-28T10:00:00Z"), NonRenewingDuration.months(1).end(utc("2026-01-31T10:00:00Z")))
        assertEquals(utc("2028-02-29T10:00:00Z"), NonRenewingDuration.months(1).end(utc("2028-01-31T10:00:00Z")))
        assertEquals(utc("2026-04-30T23:30:00Z"), NonRenewingDuration.months(3).end(utc("2026-01-31T23:30:00Z")))
        assertEquals(utc("2029-02-28T00:00:00Z"), NonRenewingDuration.years(1).end(utc("2028-02-29T00:00:00Z")))
        assertEquals(utc("2027-03-10T12:00:00Z"), NonRenewingDuration.years(1).end(base))
        try {
            NonRenewingDuration.days(0)
            throw AssertionError("expected an error")
        } catch (_: IllegalArgumentException) {
            // expected
        }
    }

    // Merge rules

    @Test
    fun mergeRules() {
        val local = EntitlementMapping.of(mapOf("pro" to listOf(monthly)))
        val merged = ProductConfigRules.mapping(local, mapOf("pro" to listOf(pass), "extra" to listOf("com.example.addon")))
        assertEquals(mapOf("pro" to setOf(monthly, pass), "extra" to setOf("com.example.addon")), merged.entitlements)
        assertEquals(local, ProductConfigRules.mapping(local, emptyMap()))

        val durations = ProductConfigRules.durations(
            local = mapOf(pass to NonRenewingDuration.weeks(1)),
            server = mapOf(pass to NonRenewingDuration.days(3), "com.example.pass_month" to NonRenewingDuration.months(1)),
        )
        assertEquals(mapOf(pass to NonRenewingDuration.weeks(1), "com.example.pass_month" to NonRenewingDuration.months(1)), durations)

        // Declared products (entitlement map, product ids, consumables) never take a server duration; a local one applies.
        val protected = ProductConfigRules.durations(
            local = mapOf(pass to NonRenewingDuration.days(3)),
            server = mapOf(lifetime to NonRenewingDuration.days(3), pass to NonRenewingDuration.weeks(1), "com.example.new:base" to NonRenewingDuration.days(1)),
            declared = setOf(lifetime, pass),
        )
        assertEquals(mapOf(pass to NonRenewingDuration.days(3), "com.example.new:base" to NonRenewingDuration.days(1)), protected)
    }

    // Entitlements

    private val proMapping = EntitlementMapping.of(mapOf("pro" to listOf(monthly, pass, lifetime)))
    private val durations = mapOf(pass to NonRenewingDuration.days(3))

    @Test
    fun passGrantsUntilItsEndAndIsNotLifetime() {
        val bought = listOf(passPurchase("p1", base))
        val active = CustomerEntitlements.compute(bought, proMapping, emptySet(), durations, now = base + 2 * day)
        val info = active.active.getValue("pro")
        assertEquals(pass, info.productId)
        assertEquals(base + 3 * day, info.expirationTime)
        assertFalse(info.isLifetime)
        assertTrue(info.isNonRenewing)
        assertEquals(mapOf(pass to base + 3 * day), active.expirationTimes)
        assertTrue(CustomerEntitlements.compute(bought, proMapping, emptySet(), durations, now = base + 3 * day).active.isEmpty())
        // Without a duration the same product is a lifetime purchase (as before 1.9.0).
        assertTrue(CustomerEntitlements.compute(bought, proMapping).active.getValue("pro").isLifetime)
    }

    @Test
    fun repeatPurchasesStack() {
        val history = listOf(passPurchase("p1", base), passPurchase("p3", base + 20 * day))
        val owned = listOf(passPurchase("p2", base + day))
        val chains = PassChains.compute(owned + history, durations).getValue(pass)
        // p2 extends p1 (bought before p1 ended); p3 starts fresh after a gap.
        assertEquals(listOf(base + 3 * day, base + 6 * day, base + 23 * day), chains.map { it.end })
        val atDay5 = CustomerEntitlements.compute(owned, proMapping, emptySet(), durations, history.take(1), now = base + 5 * day)
        assertEquals(base + 6 * day, atDay5.active.getValue("pro").expirationTime)
        assertEquals(base + 3 * day, PassChains.nextEnd(mapOf(pass to chains), base))
        assertEquals(base + 23 * day, PassChains.nextEnd(mapOf(pass to chains), base + 6 * day))
        assertNull(PassChains.nextEnd(mapOf(pass to chains), base + 23 * day))
        // A quantity of 2 counts twice.
        val double = PassChains.compute(listOf(passPurchase("q", base).copy(quantity = 2)), durations).getValue(pass).single()
        assertEquals(base + 6 * day, double.end)
    }

    @Test
    fun lifetimeBeatsSubscriptionBeatsPassAndDurationsBeatConsumables() {
        val purchases = listOf(
            passPurchase("p1", base + day),
            purchase("sub", product = monthly, time = base),
            purchase("life", product = lifetime, type = RevflarePurchase.PRODUCT_TYPE_INAPP, time = base - day),
        )
        val all = CustomerEntitlements.compute(purchases, proMapping, emptySet(), durations, now = base + day)
        assertEquals(lifetime, all.active.getValue("pro").productId)
        val noLifetime = CustomerEntitlements.compute(purchases.take(2), proMapping, emptySet(), durations, now = base + day)
        assertEquals(monthly, noLifetime.active.getValue("pro").productId)
        assertNull(noLifetime.active.getValue("pro").expirationTime)
        // Listed as a consumable too: still a pass.
        val asConsumable = CustomerEntitlements.compute(purchases.take(1), proMapping, setOf(pass), durations, now = base + day)
        assertEquals(pass, asConsumable.active.getValue("pro").productId)
        // Two passes: the later end wins.
        val week = "com.example.pass_week"
        val two = CustomerEntitlements.compute(
            listOf(passPurchase("p1", base), passPurchase("w", base - day, product = week)),
            EntitlementMapping.of(mapOf("pro" to listOf(pass, week))),
            emptySet(),
            durations + (week to NonRenewingDuration.weeks(1)),
            now = base,
        )
        assertEquals(week, two.active.getValue("pro").productId)
    }

    // Store

    private class Harness(val store: RevflareStore, val billing: FakeBilling, val storage: MemoryKeyValueStore)

    private fun TestScope.passStore(
        billing: FakeBilling = FakeBilling(),
        storage: MemoryKeyValueStore = MemoryKeyValueStore(),
        mapping: Map<String, List<String>> = mapOf("pro" to listOf(monthly, pass)),
        localDurations: Map<String, NonRenewingDuration> = durations,
        consumables: Set<String> = emptySet(),
        loader: (suspend (OfferingsFetchPolicy) -> RevflareOfferings)? = null,
        productIds: List<String> = emptyList(),
    ): Harness {
        val store = RevflareStore(
            productIds = productIds,
            mapping = EntitlementMapping.of(mapping),
            consumables = consumables,
            backend = billing,
            scope = backgroundScope,
            accountId = { INSTALL_ID },
            linkPurchases = {},
            trackEvent = { _, _ -> },
            offeringsLoader = loader,
            loadsOfferingsAutomatically = false,
            nonRenewingDurations = localDurations,
            storage = storage,
            clock = { base + testScheduler.currentTime },
        )
        store.start()
        runCurrent()
        return Harness(store, billing, storage)
    }

    @Test
    fun passIsAcknowledgedNotConsumedAndRecorded() = runTest {
        val h = passStore(consumables = setOf(pass))
        val bought = passPurchase("p1", base, acknowledged = false)
        val outcome = async {
            h.store.purchaseFlow(pass, PurchaseEventContext(pass)) {
                h.billing.owned.add(bought)
                h.billing.flow.emit(PurchasesUpdate(BillingResponse.OK, listOf(bought)))
                BillingResponse.OK
            }
        }
        runCurrent()
        assertTrue(outcome.await().isPurchased)
        assertEquals(listOf("p1"), h.billing.acknowledged)
        assertTrue(h.billing.consumed.isEmpty())
        assertEquals(base + 3 * day, h.store.entitlement("pro")!!.expirationTime)
        assertEquals(listOf("p1"), PassLedger(h.storage).entries.map { it.purchaseToken })
    }

    @Test
    fun ownedPassIsConsumedBeforeBuyingItAgainAndStacks() = runTest {
        val billing = FakeBilling()
        billing.owned.add(passPurchase("p1", base - day))
        val h = passStore(billing)
        assertEquals(base + 2 * day, h.store.entitlement("pro")!!.expirationTime)
        val again = passPurchase("p2", base, acknowledged = false)
        val outcome = async {
            h.store.purchaseFlow(pass, PurchaseEventContext(pass)) {
                // Play would answer ITEM_ALREADY_OWNED if p1 were still owned.
                assertEquals(listOf("p1"), billing.consumed)
                billing.owned.add(again)
                billing.flow.emit(PurchasesUpdate(BillingResponse.OK, listOf(again)))
                BillingResponse.OK
            }
        }
        runCurrent()
        assertTrue(outcome.await().isPurchased)
        // p1 (consumed by the store, no longer returned by Play) still counts: p2 extends it.
        assertEquals(base + 5 * day, h.store.entitlement("pro")!!.expirationTime)
        h.store.refresh()
        assertEquals(base + 5 * day, h.store.entitlement("pro")!!.expirationTime)
    }

    @Test
    fun refundedPassIsExcluded() = runTest {
        val billing = FakeBilling()
        billing.owned.add(passPurchase("p1", base))
        val h = passStore(billing)
        assertTrue(h.store.isActive("pro"))
        // Play no longer returns it and the store did not consume it: refunded / revoked.
        billing.owned.clear()
        h.store.refresh()
        assertFalse(h.store.isActive("pro"))
        assertTrue(PassLedger(h.storage).entries.isEmpty())
    }

    @Test
    fun endedPassRefreshesOnTimeAndIsNeverConsumedOnItsOwn() = runTest {
        val billing = FakeBilling()
        billing.owned.add(passPurchase("p1", base))
        val h = passStore(billing)
        assertTrue(h.store.isActive("pro"))
        assertTrue(h.store.hasExpiryTimer)
        val queries = billing.queries
        advanceTimeBy(3 * day - 1)
        runCurrent()
        assertTrue(h.store.isActive("pro"))
        assertEquals(queries, billing.queries)
        advanceTimeBy(2)
        runCurrent()
        assertFalse(h.store.isActive("pro"))
        // Consuming is irreversible: an ended pass stays owned in Play until the same pass is bought again.
        assertTrue(billing.consumed.isEmpty())
        assertFalse(PassLedger(h.storage).entries.single().consumedByUs)
        assertFalse(h.store.hasExpiryTimer)
        h.store.refresh()
        assertTrue(billing.consumed.isEmpty())
    }

    @Test
    fun serverDurationOnADeclaredLifetimeProductIsIgnoredAndNothingIsConsumed() = runTest {
        // A paying user owns the lifetime product the app ships (declared in its map). Revflare then gets a 3-day
        // duration on it by mistake: the store ignores it (lifetime stays lifetime), never consumes it.
        val billing = FakeBilling()
        billing.owned.add(passPurchase("life", base - 30 * day, product = lifetime))
        val h = passStore(billing, mapping = mapOf("pro" to listOf(monthly, lifetime)), localDurations = emptyMap())
        assertTrue(h.store.applyServerProducts(ServerProducts(durations = mapOf(lifetime to NonRenewingDuration.days(3)))))
        h.store.refresh()
        assertTrue(lifetime in h.store.declaredProductIds)
        assertTrue(h.store.nonRenewingDurations.isEmpty())
        assertTrue(h.store.entitlement("pro")!!.isLifetime)
        advanceTimeBy(400 * day)
        runCurrent()
        h.store.refresh()
        assertTrue(h.store.entitlement("pro")!!.isLifetime)
        assertTrue(billing.consumed.isEmpty())
        assertTrue(PassLedger(h.storage).entries.isEmpty())
        // Declared through productIds only: same protection.
        val viaIds = passStore(billing, mapping = mapOf("pro" to listOf(monthly)), localDurations = emptyMap(), productIds = listOf(lifetime))
        viaIds.store.applyServerProducts(ServerProducts(entitlements = mapOf("pro" to listOf(lifetime)), durations = mapOf(lifetime to NonRenewingDuration.days(3))))
        viaIds.store.refresh()
        assertTrue(viaIds.store.entitlement("pro")!!.isLifetime)
        assertTrue(billing.consumed.isEmpty())
    }

    @Test
    fun serverDurationOnAnUndeclaredEndedPassNeverConsumesIt() = runTest {
        // Even for a product only the server knows: ended passes are not consumed on their own.
        val serverPass = "com.example.server_pass"
        val billing = FakeBilling()
        billing.owned.add(passPurchase("s1", base - 10 * day, product = serverPass))
        val h = passStore(billing, mapping = mapOf("pro" to listOf(monthly)), localDurations = emptyMap())
        h.store.applyServerProducts(ServerProducts(entitlements = mapOf("pro" to listOf(serverPass)), durations = mapOf(serverPass to NonRenewingDuration.days(3))))
        h.store.refresh()
        assertFalse(h.store.isActive("pro"))
        assertTrue(billing.consumed.isEmpty())
    }

    @Test
    fun localConsumablesWinOverServerDurations() = runTest {
        // Coins are a local consumable; a server duration on them is ignored: consumed (granted), never a pass.
        val coins = "com.example.coins"
        val billing = FakeBilling()
        val h = passStore(billing, consumables = setOf(coins), localDurations = emptyMap())
        h.store.applyServerProducts(ServerProducts(durations = mapOf(coins to NonRenewingDuration.days(3))))
        assertTrue(h.store.nonRenewingDurations.isEmpty())
        val bought = passPurchase("c1", base, product = coins, acknowledged = false)
        val outcome = async {
            h.store.purchaseFlow(coins, PurchaseEventContext(coins)) {
                billing.owned.add(bought)
                billing.flow.emit(PurchasesUpdate(BillingResponse.OK, listOf(bought)))
                BillingResponse.OK
            }
        }
        runCurrent()
        assertTrue(outcome.await().isPurchased)
        assertEquals(listOf("c1"), billing.consumed)
        assertTrue(billing.acknowledged.isEmpty())
        assertTrue(PassLedger(h.storage).entries.isEmpty())
    }

    @Test
    fun serverEntitlementsAreMergedPersistedAndAppliedAtStart() = runTest {
        val loaderCalls = mutableListOf<OfferingsFetchPolicy>()
        val storage = MemoryKeyValueStore()
        val billing = FakeBilling()
        billing.owned.add(passPurchase("p1", base))
        val server = RevflareOfferings(OfferingsSnapshot(OfferingsResponse.parse(serverBody), emptyMap()))
        // The app knows only the subscription; the pass is added in Revflare.
        val h = passStore(billing, storage, mapping = mapOf("pro" to listOf(monthly)), localDurations = emptyMap(), loader = { loaderCalls.add(it); server })
        assertEquals(1, loaderCalls.size) // also without useOfferings
        assertNull(h.store.offerings.value)
        assertEquals(setOf(monthly, pass), h.store.mapping.entitlements.getValue("pro"))
        assertEquals(mapOf(pass to NonRenewingDuration.days(3), "com.example.pass_month" to NonRenewingDuration.months(1)), h.store.nonRenewingDurations)
        assertTrue(h.store.productIds.value.containsAll(listOf(pass, "com.example.addon", "com.example.pass_month")))
        assertEquals(pass, h.store.entitlement("pro")!!.productId)
        assertEquals(base + 3 * day, h.store.entitlement("pro")!!.expirationTime)

        // Next launch, offline (no loader answer): the stored copy applies before the first entitlement check.
        val next = passStore(billing, storage, mapping = mapOf("pro" to listOf(monthly)), localDurations = mapOf(pass to NonRenewingDuration.weeks(1)))
        assertEquals(setOf(monthly, pass), next.store.mapping.entitlements.getValue("pro"))
        assertEquals(NonRenewingDuration.weeks(1), next.store.nonRenewingDurations[pass]) // local wins
        assertEquals(base + 7 * day, next.store.entitlement("pro")!!.expirationTime)

        // A server without the fields (older, or the configuration emptied) clears the server part; local stays.
        val cleared = next.store.applyServerProducts(ServerProducts.EMPTY)
        assertTrue(cleared)
        assertNull(storage.string(RevflareStore.SERVER_PRODUCTS_KEY))
        assertEquals(EntitlementMapping.of(mapOf("pro" to listOf(monthly))), next.store.mapping)
        assertEquals(mapOf(pass to NonRenewingDuration.weeks(1)), next.store.nonRenewingDurations)
    }

    @Test
    fun consumedPassInTheLedgerCountsAtLaunch() = runTest {
        val storage = MemoryKeyValueStore()
        PassLedger(storage).apply {
            record(passPurchase("p1", base - day), pass)
            markConsumed("p1")
        }
        // Play no longer returns the consumed pass: the ledger keeps it (no refund: consumed by the store).
        val h = passStore(storage = storage)
        assertEquals(base + 2 * day, h.store.entitlement("pro")!!.expirationTime)
        assertEquals(1, PassLedger(storage).entries.size)
    }

    // 1.9.1: the ledger follows Play's current purchases.

    /** p1 bought and consumed by the store before re-buying the pass as p2 (stacked: base-day → base+5d). */
    private fun TestScope.stackedHarness(): Harness {
        val storage = MemoryKeyValueStore()
        PassLedger(storage).apply {
            record(passPurchase("p1", base - day), pass)
            markConsumed("p1")
        }
        val billing = FakeBilling()
        billing.owned.add(passPurchase("p2", base))
        val h = passStore(billing, storage)
        assertEquals(base + 5 * day, h.store.entitlement("pro")!!.expirationTime)
        return h
    }

    @Test
    fun clearedPurchasesDropTheWholeChain() = runTest {
        // Play test purchases cleared (or the latest pass refunded): Play returns no purchase of the pass any more.
        val h = stackedHarness()
        h.billing.owned.clear()
        assertTrue(h.store.refresh())
        assertFalse(h.store.isActive("pro"))
        assertTrue(PassLedger(h.storage).entries.isEmpty())
        assertFalse(h.store.hasExpiryTimer)
    }

    @Test
    fun refundOfTheLatestPassAlsoRemovesEarlierStackedTime() = runTest {
        // Documented tradeoff: the consumed p1 can't be checked once its anchor (p2) is gone.
        val h = stackedHarness()
        h.billing.owned.removeAll { it.purchaseToken == "p2" }
        h.store.refresh()
        assertFalse(h.store.isActive("pro"))
        assertTrue(PassLedger(h.storage).entries.isEmpty())
    }

    @Test
    fun anchoredConsumedPassesKeepCountingAndOtherProductsAreIndependent() = runTest {
        val week = "com.example.pass_week"
        val storage = MemoryKeyValueStore()
        PassLedger(storage).apply {
            record(passPurchase("p1", base - day), pass)
            markConsumed("p1")
            record(passPurchase("w1", base - 2 * day, product = week), week)
            markConsumed("w1")
        }
        val billing = FakeBilling()
        billing.owned.add(passPurchase("p2", base))
        billing.owned.add(passPurchase("w2", base - day, product = week))
        val h = passStore(billing, storage, mapping = mapOf("pro" to listOf(pass), "extra" to listOf(week)),
            localDurations = durations + (week to NonRenewingDuration.weeks(1)))
        assertEquals(setOf("p1", "p2", "w1", "w2"), PassLedger(storage).entries.map { it.purchaseToken }.toSet())
        assertEquals(base + 5 * day, h.store.entitlement("pro")!!.expirationTime)
        assertEquals(base + 12 * day, h.store.entitlement("extra")!!.expirationTime)
        // The week pass refunded: only its chain goes.
        billing.owned.removeAll { it.purchaseToken == "w2" }
        h.store.refresh()
        assertEquals(setOf("p1", "p2"), PassLedger(storage).entries.map { it.purchaseToken }.toSet())
        assertEquals(base + 5 * day, h.store.entitlement("pro")!!.expirationTime)
        assertFalse(h.store.isActive("extra"))
    }

    @Test
    fun nothingIsDroppedWhenPlayCannotAnswer() = runTest {
        val h = stackedHarness()
        h.billing.owned.clear()
        h.billing.available = false
        assertFalse(h.store.refresh())
        assertEquals(2, PassLedger(h.storage).entries.size)
        assertTrue(h.store.isActive("pro"))
    }

    @Test
    fun reBuyConsumedThenCancelledKeepsTheRunningPass() = runTest {
        val billing = FakeBilling()
        billing.owned.add(passPurchase("p1", base - day))
        val h = passStore(billing)
        // The store consumes p1 before launching the flow; the user cancels.
        val outcome = async {
            h.store.purchaseFlow(pass, PurchaseEventContext(pass)) {
                BillingResponse(BillingClient.BillingResponseCode.USER_CANCELED)
            }
        }
        runCurrent()
        outcome.await()
        assertEquals(listOf("p1"), billing.consumed)
        h.store.refresh()
        // Play returns nothing for the pass, but its latest pass was consumed by the store: expected, kept.
        assertEquals(base + 2 * day, h.store.entitlement("pro")!!.expirationTime)
        assertEquals(1, PassLedger(h.storage).entries.size)
    }

    @Test
    fun ledgerValidationRules() {
        val ledger = PassLedger(MemoryKeyValueStore())
        ledger.record(passPurchase("a", base), pass)
        ledger.markConsumed("a")
        ledger.record(passPurchase("b", base + day), pass)
        ledger.record(passPurchase("c", base + 2 * day), pass)
        // b gone (not consumed by the store): dropped; a stays, anchored by c.
        assertEquals(listOf("b"), ledger.validate(listOf(passPurchase("c", base + 2 * day))).map { it.purchaseToken })
        assertEquals(listOf("a", "c"), ledger.entries.map { it.purchaseToken })
        // A pending purchase of the product is no anchor.
        val pending = passPurchase("d", base + 3 * day).copy(state = RevflarePurchase.State.PENDING)
        assertEquals(listOf("a", "c"), ledger.validate(listOf(pending)).map { it.purchaseToken })
        assertTrue(ledger.entries.isEmpty())
    }

    @Test
    fun localMappingAppliesWithoutServer() = runTest {
        val billing = FakeBilling()
        billing.owned.add(passPurchase("p1", base))
        val h = passStore(billing)
        assertEquals(EntitlementMapping.of(mapOf("pro" to listOf(monthly, pass))), h.store.mapping)
        assertEquals(h.store.localMapping, h.store.mapping)
        assertTrue(h.store.isActive("pro"))
    }
}

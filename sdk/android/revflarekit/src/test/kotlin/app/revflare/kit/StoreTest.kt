package app.revflare.kit

import com.android.billingclient.api.BillingClient
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class StoreTest {
    private class Harness(val store: RevflareStore, val billing: FakeBilling, val events: MutableList<Pair<String, Map<String, String>>>, var links: Int)

    private fun TestScope.harness(
        billing: FakeBilling = FakeBilling(),
        consumables: Set<String> = emptySet(),
        onConsumable: (suspend (RevflarePurchase) -> Unit)? = null,
    ): Harness {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        lateinit var harness: Harness
        val store = RevflareStore(
            productIds = listOf("pro", "pro_lifetime"),
            mapping = EntitlementMapping.of(mapOf("pro" to listOf("pro:monthly", "pro_lifetime"))),
            consumables = consumables,
            backend = billing,
            scope = backgroundScope,
            accountId = { INSTALL_ID },
            linkPurchases = { harness.links++ },
            trackEvent = { name, props -> events.add(name to props) },
            offeringsLoader = null,
            loadsOfferingsAutomatically = false,
        )
        harness = Harness(store, billing, events, 0)
        store.onConsumablePurchased = onConsumable
        store.start()
        runCurrent()
        return harness
    }

    private val context = PurchaseEventContext("pro", offering = "default", pkg = "\$monthly", placement = "onboarding", basePlan = "monthly")

    @Test
    fun purchaseAcknowledgesAndUnlocks() = runTest {
        val h = harness()
        assertTrue(h.store.hasLoadedEntitlements.value)
        assertFalse(h.store.isActive("pro"))
        val bought = purchase("tok1", product = "pro", acknowledged = false)
        val outcome = async {
            h.store.purchaseFlow("pro", context) {
                h.billing.owned.add(bought)
                h.billing.flow.emit(PurchasesUpdate(BillingResponse.OK, listOf(bought)))
                BillingResponse.OK
            }
        }
        runCurrent()
        assertEquals(RevflareStore.PurchaseOutcome.Purchased(bought), outcome.await())
        assertEquals(listOf("tok1"), h.billing.acknowledged)
        assertTrue(h.store.isActive("pro"))
        assertEquals("pro", h.store.entitlement("pro")!!.productId)
        assertTrue(h.links >= 1)
        val props = mapOf("product" to "pro", "offering" to "default", "package" to "\$monthly", "placement" to "onboarding", "base_plan" to "monthly")
        assertEquals(listOf("purchase_start" to props, "purchase_success" to props), h.events)
        assertFalse(h.store.isPurchasing.value)
    }

    @Test
    fun consumablesAreConsumedAndGrantNothing() = runTest {
        val h = harness(consumables = setOf("coins_100"))
        val coins = purchase("c1", product = "coins_100", type = RevflarePurchase.PRODUCT_TYPE_INAPP, acknowledged = false)
        val outcome = async {
            h.store.purchaseFlow("coins_100", PurchaseEventContext("coins_100")) {
                h.billing.owned.add(coins)
                h.billing.flow.emit(PurchasesUpdate(BillingResponse.OK, listOf(coins)))
                BillingResponse.OK
            }
        }
        runCurrent()
        assertTrue(outcome.await().isPurchased)
        assertEquals(listOf("c1"), h.billing.consumed)
        assertTrue(h.billing.acknowledged.isEmpty())
        assertTrue(h.store.entitlements.value.active.isEmpty())
    }

    @Test
    fun consumableBoughtThroughTheFlowIsNotHandedToTheHandler() = runTest {
        val grants = mutableListOf<String>()
        val h = harness(consumables = setOf("coins_100"), onConsumable = { grants.add(it.purchaseToken) })
        val coins = purchase("c1", product = "coins_100", type = RevflarePurchase.PRODUCT_TYPE_INAPP, acknowledged = false)
        val outcome = async {
            h.store.purchaseFlow("coins_100", PurchaseEventContext("coins_100")) {
                h.billing.owned.add(coins)
                h.billing.flow.emit(PurchasesUpdate(BillingResponse.OK, listOf(coins)))
                BillingResponse.OK
            }
        }
        runCurrent()
        assertTrue(outcome.await().isPurchased)
        assertEquals(listOf("c1"), h.billing.consumed)
        assertTrue(grants.isEmpty())
    }

    @Test
    fun consumableCompletedWhileClosedIsGrantedThenConsumed() = runTest {
        val billing = FakeBilling()
        billing.owned.add(purchase("closed", product = "coins_100", type = RevflarePurchase.PRODUCT_TYPE_INAPP, acknowledged = false))
        val grants = mutableListOf<String>()
        val h = harness(billing, consumables = setOf("coins_100"), onConsumable = { grants.add(it.purchaseToken) })
        assertEquals(listOf("closed"), grants)
        assertEquals(listOf("closed"), billing.consumed)
        // Refreshing again grants nothing twice.
        h.store.refresh()
        runCurrent()
        assertEquals(listOf("closed"), grants)
        assertEquals(listOf("closed"), billing.consumed)
    }

    @Test
    fun consumableWaitsForAHandlerAndFailedGrantsAreRetried() = runTest {
        val billing = FakeBilling()
        billing.owned.add(purchase("later", product = "coins_100", type = RevflarePurchase.PRODUCT_TYPE_INAPP, acknowledged = false))
        val h = harness(billing, consumables = setOf("coins_100"))
        // No handler: left unconsumed for the app.
        assertTrue(billing.consumed.isEmpty())
        var fail = true
        val grants = mutableListOf<String>()
        h.store.onConsumablePurchased = {
            if (fail) throw IllegalStateException("server down")
            grants.add(it.purchaseToken)
        }
        runCurrent()
        assertTrue(grants.isEmpty())
        assertTrue(billing.consumed.isEmpty())
        fail = false
        h.store.refresh()
        assertEquals(listOf("later"), grants)
        assertEquals(listOf("later"), billing.consumed)
    }

    @Test
    fun pendingConsumableCompletingWhileOpenIsGrantedOnce() = runTest {
        val grants = mutableListOf<String>()
        val h = harness(consumables = setOf("coins_100"), onConsumable = { grants.add(it.purchaseToken) })
        val completed = purchase("p-coins", product = "coins_100", type = RevflarePurchase.PRODUCT_TYPE_INAPP, acknowledged = false)
        h.billing.owned.add(completed)
        h.billing.flow.emit(PurchasesUpdate(BillingResponse.OK, listOf(completed)))
        runCurrent()
        assertEquals(listOf("p-coins"), grants)
        assertEquals(listOf("p-coins"), h.billing.consumed)
    }

    @Test
    fun purchaseFlowOnlyEndsWithAnUpdateAboutItsProduct() = runTest {
        val h = harness()
        val other = purchase("renewal", product = "pro_lifetime", type = RevflarePurchase.PRODUCT_TYPE_INAPP, acknowledged = false)
        val bought = purchase("tok-pro", product = "pro", acknowledged = false)
        val outcome = async {
            h.store.purchaseFlow("pro", context) {
                // Another purchase completes while the sheet is open.
                h.billing.owned.add(other)
                h.billing.flow.emit(PurchasesUpdate(BillingResponse.OK, listOf(other)))
                BillingResponse.OK
            }
        }
        runCurrent()
        assertFalse(outcome.isCompleted)
        assertEquals(listOf("renewal"), h.billing.acknowledged)
        h.billing.owned.add(bought)
        h.billing.flow.emit(PurchasesUpdate(BillingResponse.OK, listOf(bought)))
        runCurrent()
        assertEquals(RevflareStore.PurchaseOutcome.Purchased(bought), outcome.await())
    }

    @Test
    fun pendingPurchaseWaitsThenUnlocksWhenCompleted() = runTest {
        val h = harness()
        val pending = purchase("p1", product = "pro_lifetime", type = RevflarePurchase.PRODUCT_TYPE_INAPP, orderId = null,
            state = RevflarePurchase.State.PENDING, acknowledged = false)
        val outcome = async {
            h.store.purchaseFlow("pro_lifetime", PurchaseEventContext("pro_lifetime")) {
                h.billing.owned.add(pending)
                h.billing.flow.emit(PurchasesUpdate(BillingResponse.OK, listOf(pending)))
                BillingResponse.OK
            }
        }
        runCurrent()
        assertEquals(RevflareStore.PurchaseOutcome.Pending(pending), outcome.await())
        assertTrue(h.billing.acknowledged.isEmpty())
        assertFalse(h.store.isActive("pro"))
        assertEquals("purchase_pending", h.events.last().first)

        // Payment arrives later through Play's updates.
        val completed = pending.copy(state = RevflarePurchase.State.PURCHASED, orderId = "GPA.1-2-3-4")
        h.billing.owned.replaceAll { completed }
        h.billing.flow.emit(PurchasesUpdate(BillingResponse.OK, listOf(completed)))
        runCurrent()
        assertEquals(listOf("p1"), h.billing.acknowledged)
        assertTrue(h.store.isActive("pro"))
        assertTrue(h.store.entitlement("pro")!!.isLifetime)
    }

    @Test
    fun cancelAndErrors() = runTest {
        val h = harness()
        val cancelled = async {
            h.store.purchaseFlow("pro", PurchaseEventContext("pro")) {
                h.billing.flow.emit(PurchasesUpdate(BillingResponse(BillingClient.BillingResponseCode.USER_CANCELED), emptyList()))
                BillingResponse.OK
            }
        }
        runCurrent()
        assertEquals(RevflareStore.PurchaseOutcome.UserCancelled, cancelled.await())
        assertEquals("purchase_cancel", h.events.last().first)

        try {
            h.store.purchaseFlow("pro", PurchaseEventContext("pro")) { BillingResponse(BillingClient.BillingResponseCode.ITEM_UNAVAILABLE, "gone") }
            fail("expected an error")
        } catch (error: RevflareBillingException) {
            assertEquals("item_unavailable", error.code)
        }
        assertEquals("purchase_failed" to mapOf("product" to "pro", "error" to "item_unavailable"), h.events.last())

        val cancelledAtLaunch = h.store.purchaseFlow("pro", PurchaseEventContext("pro")) { BillingResponse(BillingClient.BillingResponseCode.USER_CANCELED) }
        assertEquals(RevflareStore.PurchaseOutcome.UserCancelled, cancelledAtLaunch)
    }

    @Test
    fun refreshAcknowledgesPurchasesLeftUnacknowledged() = runTest {
        val billing = FakeBilling()
        billing.owned.add(purchase("old", product = "pro", acknowledged = false))
        val h = harness(billing)
        assertEquals(listOf("old"), billing.acknowledged)
        assertTrue(h.store.isActive("pro"))
    }

    @Test
    fun restoreReQueriesAndLinks() = runTest {
        val h = harness()
        h.billing.owned.add(purchase("other-device", product = "pro_lifetime", type = RevflarePurchase.PRODUCT_TYPE_INAPP))
        val restored = h.store.restore()
        assertTrue(restored.isActive("pro"))
        assertEquals(1, h.links)
        assertEquals(listOf("restore_start" to emptyMap(), "restore_success" to mapOf("entitlements" to "pro")), h.events)

        h.billing.available = false
        try {
            h.store.restore()
            fail("expected an error")
        } catch (error: RevflareBillingException) {
            assertEquals("restore_failed", h.events.last().first)
        }
    }

    @Test
    fun entitlementRules() {
        val mapping = EntitlementMapping.of(mapOf("pro" to listOf("pro:monthly", "pro_lifetime"), "extra" to listOf("addon")))
        val purchases = listOf(
            purchase("sub", product = "pro", time = 10),
            purchase("life", product = "pro_lifetime", type = RevflarePurchase.PRODUCT_TYPE_INAPP, time = 5),
            purchase("held", product = "addon", suspended = true),
            purchase("wait", product = "coins", type = RevflarePurchase.PRODUCT_TYPE_INAPP, state = RevflarePurchase.State.PENDING),
        )
        val computed = CustomerEntitlements.compute(purchases, mapping, consumables = setOf("coins"))
        assertEquals(setOf("pro"), computed.active.keys)
        assertEquals("pro_lifetime", computed.active["pro"]!!.productId) // lifetime wins
        assertEquals(setOf("pro", "pro_lifetime"), computed.activeProductIds)
        assertEquals(4, computed.purchases.size)
        val subOnly = CustomerEntitlements.compute(listOf(purchases[0]), mapping)
        assertTrue(subOnly.active["pro"]!!.willRenew)
        assertFalse(subOnly.active["pro"]!!.isLifetime)
    }
}

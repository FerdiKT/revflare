package app.revflare.kit

import android.app.Activity
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.ProductDetails
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference

/**
 * Google Play Billing purchases and entitlements, a small replacement for RevenueCat's `Purchases`.
 *
 * Create **one** store at launch ([Revflare.configurePurchases]) and keep it for the app's lifetime. The store:
 * - listens to Play's purchase updates and **acknowledges** every purchased subscription and non-consumable (Play
 *   refunds purchases not acknowledged within 3 days), **consumes** the products listed as consumables, then refreshes
 *   the entitlements;
 * - hands consumables bought outside a purchase flow (a pending purchase that completed later, also while the app was
 *   closed) to [onConsumablePurchased] so the app grants them, then consumes them;
 * - computes [entitlements] from `queryPurchasesAsync` (active subscriptions, including the billing grace period, and
 *   one-time products; pending and suspended purchases give no access);
 * - handles non-renewing passes (one-time products with a duration in [nonRenewingDurations]): acknowledges them,
 *   keeps a local ledger of the passes bought (Play forgets consumed purchases), stacks repeat purchases and refreshes
 *   when a pass ends. A pass is **only consumed right before the same pass is bought again** (Play can't sell a
 *   one-time product the user still owns), never because it ended: a consumed purchase is gone from Play for good,
 *   so the store never consumes anything on its own;
 * - merges the entitlements and pass durations set in Revflare (sent with the offerings, kept on the device) with the
 *   app's own ([mapping], [nonRenewingDurations]), so a product added in Revflare works without an app update. Server
 *   durations never apply to products the app declares ([declaredProductIds]) unless the app sets a local duration
 *   for them too, so a server configuration can't turn a declared lifetime product or consumable into a pass;
 * - buys with [purchase] (the install id as the obfuscated account id, so Revflare links the purchase to the install)
 *   and restores with [restore];
 * - records the funnel events `purchase_start`, `purchase_success`, `purchase_cancel`, `purchase_pending`,
 *   `purchase_failed`, `restore_start`, `restore_success` and `restore_failed`.
 *
 * **The store owns the app's purchases** (it acknowledges and consumes them): do not use it in an app that also uses
 * RevenueCat or another purchase SDK. Such apps call [Revflare.configure] alone (attribution-only mode), which never
 * acknowledges or consumes anything.
 */
public class RevflareStore internal constructor(
    productIds: List<String>,
    /** The app's entitlement names → product ids. */
    mapping: EntitlementMapping,
    /**
     * Product ids consumed after purchase (coins, credits...); they never grant an entitlement. A product that also has
     * a pass duration ([nonRenewingDurations]) is a pass, not a consumable.
     */
    public val consumables: Set<String>,
    private val backend: BillingBackend,
    private val scope: CoroutineScope,
    private val accountId: () -> String,
    private val linkPurchases: () -> Unit,
    private val trackEvent: (String, Map<String, String>) -> Unit,
    private val offeringsLoader: (suspend (OfferingsFetchPolicy) -> RevflareOfferings)?,
    private val loadsOfferingsAutomatically: Boolean,
    /** The app's pass durations (product id → duration). */
    nonRenewingDurations: Map<String, NonRenewingDuration> = emptyMap(),
    private val storage: KeyValueStore = MemoryKeyValueStore(),
    private val clock: Clock = systemClock,
    private val delayFor: suspend (Long) -> Unit = { delay(it) },
) {
    /** What a purchase came to. */
    public sealed class PurchaseOutcome {
        /** Purchased and acknowledged (or consumed); [entitlements] already includes it. */
        public data class Purchased(val purchase: RevflarePurchase) : PurchaseOutcome()
        /** The user closed the purchase sheet. Nothing changed. */
        public data object UserCancelled : PurchaseOutcome()
        /** Waiting for payment (cash, slow card): the purchase arrives later and the store unlocks it then. */
        public data class Pending(val purchase: RevflarePurchase?) : PurchaseOutcome()

        public val isPurchased: Boolean get() = this is Purchased
    }

    /** The app's own entitlement mapping, as passed to [Revflare.configurePurchases]. */
    public val localMapping: EntitlementMapping = mapping

    /** The app's own pass durations, as passed to [Revflare.configurePurchases]. */
    public val localNonRenewingDurations: Map<String, NonRenewingDuration> = nonRenewingDurations.toMap()

    /**
     * The products the app declares itself (product ids, entitlement map, consumables; without base plan). Durations
     * set in Revflare never apply to them, only the app's own [localNonRenewingDurations] do.
     */
    public val declaredProductIds: Set<String> =
        (productIds + mapping.allProductIds + consumables).map(::productIdOf).toSet()

    /** The server's part, kept on the device: applied before the first entitlement check, offline too. */
    private val serverProducts = MutableStateFlow(ServerProducts.fromJson(storage.string(SERVER_PRODUCTS_KEY)) ?: ServerProducts.EMPTY)

    private val _mapping = MutableStateFlow(ProductConfigRules.mapping(localMapping, serverProducts.value.entitlements))
    /** [mapping] as a flow. */
    public val mappingFlow: StateFlow<EntitlementMapping> = _mapping.asStateFlow()

    /**
     * The effective entitlement mapping: the app's ([localMapping]) united, per entitlement, with the one set in
     * Revflare (sent with the offerings, kept on the device). The app's mapping always applies, also offline.
     */
    public val mapping: EntitlementMapping get() = _mapping.value

    private val _durations = MutableStateFlow(ProductConfigRules.durations(localNonRenewingDurations, serverProducts.value.durations, declaredProductIds))
    /**
     * The effective pass durations: the app's ([localNonRenewingDurations]), plus the ones set in Revflare for products
     * the app does not declare ([declaredProductIds]).
     */
    public val nonRenewingDurations: Map<String, NonRenewingDuration> get() = _durations.value

    private val ledger = PassLedger(storage)

    private val _productIds = MutableStateFlow(merge(productIds.distinct(), serverProducts.value.productIds))
    /** The product ids the store loads (`id` or `id:basePlan`), in this order; offering products are added at the end. */
    public val productIds: StateFlow<List<String>> = _productIds.asStateFlow()

    private val _products = MutableStateFlow<List<ProductDetails>>(emptyList())
    /** The loaded Play products, in the order of [productIds] (unknown ids are left out). */
    public val products: StateFlow<List<ProductDetails>> = _products.asStateFlow()

    private val _productsError = MutableStateFlow<String?>(null)
    public val productsError: StateFlow<String?> = _productsError.asStateFlow()

    private val _entitlements = MutableStateFlow(CustomerEntitlements())
    /** The customer's access. */
    public val entitlements: StateFlow<CustomerEntitlements> = _entitlements.asStateFlow()

    private val _hasLoadedEntitlements = MutableStateFlow(false)
    /** False until the first entitlement check finished (avoid showing a paywall to a subscriber at launch). */
    public val hasLoadedEntitlements: StateFlow<Boolean> = _hasLoadedEntitlements.asStateFlow()

    private val _isPurchasing = MutableStateFlow(false)
    public val isPurchasing: StateFlow<Boolean> = _isPurchasing.asStateFlow()

    private val _offerings = MutableStateFlow<RevflareOfferings?>(null)
    /** The offerings set in Revflare, once loaded ([loadOfferings]). */
    public val offerings: StateFlow<RevflareOfferings?> = _offerings.asStateFlow()

    private val _offeringsError = MutableStateFlow<String?>(null)
    public val offeringsError: StateFlow<String?> = _offeringsError.asStateFlow()

    private val refreshMutex = Mutex()
    private val purchaseMutex = Mutex()

    /** The purchase flow waiting for Play's answer about [productId]. */
    private class Awaiting(val productId: String, val deferred: CompletableDeferred<PurchasesUpdate>)
    private val awaiting = AtomicReference<Awaiting?>(null)

    /** Consumable purchases granted in this process (by a purchase flow, [onConsumablePurchased] or [consume]). */
    private val granted: MutableSet<String> = ConcurrentHashMap.newKeySet()
    /** Consumable purchases being handed to [onConsumablePurchased] (never twice at once). */
    private val granting: MutableSet<String> = ConcurrentHashMap.newKeySet()
    /** Consumable purchases consumed in this process (the handler may have called [consume] itself). */
    private val consumed: MutableSet<String> = ConcurrentHashMap.newKeySet()

    /**
     * Grants a consumable bought outside [purchase]: a pending purchase (cash, slow card) that completed later, while
     * the app was open or closed. Called with each such purchase; when it returns, the store consumes the purchase (a
     * throw leaves it for the next refresh). Purchases bought through [purchase] never come here: grant those from
     * [PurchaseOutcome.Purchased].
     *
     * Without a handler, such purchases stay unconsumed (and block buying the product again) until the app grants them
     * and calls [consume]; setting the handler delivers them at once. Grant idempotently, keyed by
     * [RevflarePurchase.purchaseToken]: a purchase whose consumption failed is offered again after a restart.
     */
    @Volatile
    public var onConsumablePurchased: (suspend (RevflarePurchase) -> Unit)? = null
        set(value) {
            field = value
            if (value != null && started) scope.launch { refresh() }
        }

    @Volatile
    private var started = false

    /** Refreshes when the next pass ends. */
    private var expiryJob: Job? = null

    // Access

    /** Active entitlements by name. */
    public val activeEntitlements: Map<String, EntitlementInfo> get() = _entitlements.value.active

    /** The active entitlement with this name, or null. */
    public fun entitlement(name: String): EntitlementInfo? = _entitlements.value.active[name]

    /** Whether the entitlement with this name is active. */
    public fun isActive(entitlement: String): Boolean = _entitlements.value.active.containsKey(entitlement)

    /** The loaded product with this id. */
    public fun product(id: String): ProductDetails? = _products.value.firstOrNull { it.productId == productIdOf(id) }

    // Offerings

    /** The offering marked current in Revflare. */
    public val currentOffering: RevflareOffering? get() = _offerings.value?.current

    /** The offering to show at a paywall location: the placement's offering, else the current one. */
    public fun offering(placement: String): RevflareOffering? = _offerings.value?.offering(placement)

    /** Loads (or refreshes) [offerings] and adds their products to [products]. Errors land in [offeringsError]. */
    public suspend fun loadOfferings(fetchPolicy: OfferingsFetchPolicy = OfferingsFetchPolicy.CACHED_OR_FETCHED) {
        val loader = offeringsLoader ?: return
        try {
            val loaded = loader(fetchPolicy)
            _offeringsError.value = null
            if (loaded != _offerings.value) _offerings.value = loaded
            addProducts(loaded.ordered.flatMap { it.packages }.map { it.product } + loaded.referencedProducts)
            if (applyServerProducts(loaded)) refresh()
        } catch (error: Exception) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _offeringsError.value = error.message
            Log.debug { "RevflareStore: offerings failed to load: $error" }
        }
    }

    /**
     * Only the server's entitlements and pass durations (and their products), for stores that don't show the
     * offerings ([Revflare.configurePurchases] with `useOfferings = false`). Errors are only logged.
     */
    internal suspend fun syncServerProducts(fetchPolicy: OfferingsFetchPolicy = OfferingsFetchPolicy.CACHED_OR_FETCHED) {
        val loader = offeringsLoader ?: return
        try {
            val loaded = loader(fetchPolicy)
            addProducts(loaded.referencedProducts)
            if (applyServerProducts(loaded)) refresh()
        } catch (error: Exception) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            Log.debug { "RevflareStore: server entitlements failed to load: $error" }
        }
    }

    private fun applyServerProducts(offerings: RevflareOfferings): Boolean =
        applyServerProducts(ServerProducts(offerings.entitlements, offerings.nonRenewingDurations))

    /** Merges the server's mapping and durations, keeps them on the device. Returns true when they changed. */
    internal fun applyServerProducts(server: ServerProducts): Boolean {
        synchronized(serverProducts) {
            if (server == serverProducts.value) return false
            serverProducts.value = server
            storage.set(SERVER_PRODUCTS_KEY, if (server == ServerProducts.EMPTY) null else server.toJson())
            _mapping.value = ProductConfigRules.mapping(localMapping, server.entitlements)
            _durations.value = ProductConfigRules.durations(localNonRenewingDurations, server.durations, declaredProductIds)
            val ids = merge(_productIds.value, server.productIds)
            if (ids != _productIds.value) _productIds.value = ids
        }
        Log.debug { "RevflareStore: server entitlements ${server.entitlements}, pass durations ${server.durations.keys.sorted()}" }
        return true
    }

    private fun addProducts(added: List<ProductDetails>) {
        val ids = merge(_productIds.value, added.map { it.productId })
        val known = _products.value.map { it.productId }.toSet()
        val new = added.filter { it.productId !in known }.distinctBy { it.productId }
        if (ids != _productIds.value) _productIds.value = ids
        if (new.isEmpty()) return
        _products.value = sortProducts(_products.value + new, ids)
    }

    private fun sortProducts(products: List<ProductDetails>, ids: List<String>): List<ProductDetails> {
        val order = ids.map(::productIdOf).distinct().withIndex().associate { it.value to it.index }
        return products.sortedBy { order[it.productId] ?: Int.MAX_VALUE }
    }

    // Loading

    /** Loads (or reloads) [products]. */
    public suspend fun loadProducts() {
        val ids = _productIds.value.map(::productIdOf).toSet()
        val loaded = backend.queryProductDetails(ids)
        if (loaded == null) {
            _productsError.value = "Google Play Billing is not available"
            return
        }
        _productsError.value = null
        _products.value = sortProducts(loaded, _productIds.value)
        val missing = ids - loaded.map { it.productId }.toSet()
        if (missing.isNotEmpty()) Log.error("RevflareStore: unknown product ids ${missing.sorted()}")
    }

    /**
     * Re-reads the purchases from Play (local cache of the Play Store, no prompt), acknowledges any purchase left
     * unacknowledged (a purchase completed while the app was closed), hands unconsumed consumables to
     * [onConsumablePurchased] and consumes them, and updates [entitlements].
     * Returns false when Play Billing could not answer.
     */
    public suspend fun refresh(): Boolean {
        val unconsumed = ArrayList<RevflarePurchase>()
        val answered = refreshMutex.withLock {
            val purchases = backend.queryPurchases() ?: return@withLock false
            val durations = _durations.value
            var changed = false
            for (purchase in purchases) {
                if (purchase.state != RevflarePurchase.State.PURCHASED) continue
                val passProduct = passProductId(purchase, durations)
                if (passProduct != null) {
                    ledger.record(purchase, passProduct)
                    if (!purchase.isAcknowledged && finish(purchase)) changed = true
                } else if (isConsumable(purchase)) {
                    unconsumed.add(purchase)
                } else if (!purchase.isAcknowledged) {
                    if (finish(purchase)) changed = true
                }
            }
            // Play answered: passes it no longer returns were refunded, revoked or cleared, and consumed passes count
            // only while Play still returns a purchase of their product (PassLedger.validate).
            for (revoked in ledger.validate(purchases)) Log.debug { "RevflareStore: pass ${revoked.productId} refunded, revoked or cleared" }
            // Ended passes are NOT consumed here: consuming is irreversible (Play forgets the purchase), and a duration
            // set by mistake on a lifetime product would destroy it. They are consumed only right before the same pass
            // is bought again (consumeOwnedPasses), the one moment Play requires it.
            val now = clock()
            val final = if (changed) backend.queryPurchases() ?: purchases else purchases
            val history = passHistory()
            val computed = CustomerEntitlements.compute(final, _mapping.value, consumables, durations, history, now)
            if (computed != _entitlements.value) _entitlements.value = computed
            _hasLoadedEntitlements.value = true
            scheduleExpiry(PassChains.nextEnd(PassChains.compute(final + history, durations), now))
            true
        }
        // Outside the lock: the app's handler may call the store (consume, refresh). Consumables grant no entitlement.
        for (purchase in unconsumed) grantConsumable(purchase)
        return answered
    }

    /** The passes in the ledger, as purchases (consumed ones included: Play no longer returns them). */
    private fun passHistory(): List<RevflarePurchase> = ledger.entries.map { it.toPurchase() }

    /** The pass product a purchase is for, null when it is no pass (durations win over consumables). */
    private fun passProductId(purchase: RevflarePurchase, durations: Map<String, NonRenewingDuration> = _durations.value): String? =
        if (purchase.isSubscription) null else purchase.productIds.firstOrNull { it in durations }

    private fun isConsumable(purchase: RevflarePurchase): Boolean =
        passProductId(purchase) == null && purchase.productIds.any { it in consumables }

    /** Consumes an owned pass; the ledger keeps counting it. */
    private suspend fun consumePass(purchase: RevflarePurchase, productId: String): Boolean {
        ledger.record(purchase, productId)
        // Marked first: if Play consumed it but the answer was lost, its absence must not look like a refund.
        ledger.markConsumed(purchase.purchaseToken)
        val response = backend.consume(purchase.purchaseToken)
        if (response.isOk) {
            Log.debug { "RevflareStore: consumed pass $productId" }
        } else {
            Log.error("RevflareStore: could not consume pass $productId: ${response.code} ${response.message}")
        }
        return response.isOk
    }

    /**
     * Right before buying a pass again: consumes the purchases of that same pass Play still owns, because Play can't
     * sell a one-time product the user owns (`ITEM_ALREADY_OWNED`). It is the only place the store consumes a pass.
     * An owned pass is consumed whether it ended or not (a still-running one too: the new one stacks on it); the ledger
     * records it first, so it keeps counting on this device. Only products with an effective duration get here, and
     * server durations never apply to products the app declares, so a declared lifetime product is never consumed.
     */
    private suspend fun consumeOwnedPasses(productId: String) {
        refreshMutex.withLock {
            val owned = backend.queryPurchases() ?: return
            for (purchase in owned) {
                if (purchase.state == RevflarePurchase.State.PURCHASED && passProductId(purchase) == productId) consumePass(purchase, productId)
            }
        }
    }

    /** Refreshes at [at] (the next pass end); replaces the previous timer. */
    private fun scheduleExpiry(at: Long?) {
        synchronized(this) {
            expiryJob?.cancel()
            expiryJob = at?.let { target ->
                scope.launch {
                    delayFor((target - clock()).coerceAtLeast(0) + 1)
                    // Its own coroutine: refresh() reschedules, which cancels this timer.
                    scope.launch { refresh() }
                }
            }
        }
    }

    /** Whether a refresh is scheduled for a pass end (tests). */
    internal val hasExpiryTimer: Boolean get() = synchronized(this) { expiryJob?.isActive == true }

    // Purchasing

    /**
     * Buys a package of an offering (its product and default offer: [RevflarePackage.offerToken], or the offer passed).
     *
     * @param placement The paywall location the purchase starts from, sent with the purchase funnel events.
     * @param offerToken A subscription offer of [RevflarePackage.subscriptionOffers] other than the default one.
     * @return [PurchaseOutcome.Purchased] (acknowledged, already in [entitlements]), `UserCancelled` or `Pending`.
     * @throws RevflareBillingException Play Billing errors (network, item unavailable, already owned...).
     */
    public suspend fun purchase(activity: Activity, pkg: RevflarePackage, placement: String? = null, offerToken: String? = null): PurchaseOutcome {
        val context = PurchaseEventContext(
            productId = pkg.productId,
            offering = pkg.offeringIdentifier,
            pkg = pkg.identifier,
            placement = placement,
            basePlan = pkg.basePlanId,
            offer = offerToken?.let { token -> pkg.subscriptionOffers.firstOrNull { it.offerToken == token }?.offerId } ?: pkg.defaultOffer?.offerId,
        )
        val token = offerToken ?: pkg.offerToken
        return purchaseFlow(pkg.productId, context) { backend.launchBillingFlow(activity, pkg.product, token, accountId()) }
    }

    /**
     * Buys a Play product. Subscriptions need an offer token (a base plan or offer of
     * `product.subscriptionOfferDetails`); null picks the first base plan's default offer.
     */
    public suspend fun purchase(activity: Activity, product: ProductDetails, offerToken: String? = null, placement: String? = null): PurchaseOutcome {
        val resolved = ResolvedProduct.resolve(product.productId, product)
        val token = offerToken ?: resolved?.offerToken
        val offer = product.subscriptionOfferDetails?.firstOrNull { it.offerToken == token }
        val context = PurchaseEventContext(product.productId, placement = placement, basePlan = offer?.basePlanId, offer = offer?.offerId)
        return purchaseFlow(product.productId, context) { backend.launchBillingFlow(activity, product, token, accountId()) }
    }

    /** The purchase flow, with the Play call injected (tests). */
    internal suspend fun purchaseFlow(productId: String, context: PurchaseEventContext, launch: suspend () -> BillingResponse): PurchaseOutcome =
        purchaseMutex.withLock {
            val properties = context.properties
            _isPurchasing.value = true
            try {
                Log.debug { "RevflareStore: buying $productId" }
                trackEvent("purchase_start", properties)
                val pass = productIdOf(productId)
                if (pass in _durations.value) consumeOwnedPasses(pass)
                val waiter = Awaiting(productId, CompletableDeferred())
                awaiting.set(waiter)
                val launched = try {
                    launch()
                } catch (error: Exception) {
                    awaiting.compareAndSet(waiter, null)
                    if (error is kotlinx.coroutines.CancellationException) throw error
                    trackEvent("purchase_failed", properties + ("error" to "launch_failed"))
                    throw error
                }
                val update = if (launched.isOk) waiter.deferred.await() else PurchasesUpdate(launched, emptyList()).also { awaiting.compareAndSet(waiter, null) }
                outcome(productId, update, properties)
            } finally {
                _isPurchasing.value = false
            }
        }

    private suspend fun outcome(productId: String, update: PurchasesUpdate, properties: Map<String, String>): PurchaseOutcome {
        val code = update.response.code
        return when (code) {
            BillingClient.BillingResponseCode.OK -> {
                val purchase = update.purchases.firstOrNull { productId in it.productIds } ?: update.purchases.firstOrNull()
                when (purchase?.state) {
                    RevflarePurchase.State.PURCHASED -> {
                        trackEvent("purchase_success", properties)
                        PurchaseOutcome.Purchased(purchase)
                    }
                    RevflarePurchase.State.PENDING -> {
                        trackEvent("purchase_pending", properties)
                        PurchaseOutcome.Pending(purchase)
                    }
                    else -> {
                        trackEvent("purchase_pending", properties)
                        PurchaseOutcome.Pending(purchase)
                    }
                }
            }
            BillingClient.BillingResponseCode.USER_CANCELED -> {
                trackEvent("purchase_cancel", properties)
                PurchaseOutcome.UserCancelled
            }
            else -> {
                if (code == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) refresh()
                trackEvent("purchase_failed", properties + ("error" to BillingErrorCodes.code(code)))
                throw RevflareBillingException(code, update.response.message)
            }
        }
    }

    /**
     * Handles one `onPurchasesUpdated` callback: acknowledges / consumes, refreshes, then answers the waiting flow, but
     * only with an answer about the product it buys (an error, a cancel, or purchases including it): a renewal or a
     * pending purchase completing meanwhile does not end it.
     */
    internal suspend fun handle(update: PurchasesUpdate) {
        val waiter = awaiting.get()
        val wanted = waiter?.let { productIdOf(it.productId) }
        val answersFlow = waiter != null &&
            (!update.response.isOk || update.purchases.isEmpty() || update.purchases.any { wanted in it.productIds })
        if (update.response.isOk) {
            for (purchase in update.purchases) {
                if (purchase.state != RevflarePurchase.State.PURCHASED) continue
                val passProduct = passProductId(purchase)
                if (passProduct != null) {
                    ledger.record(purchase, passProduct)
                    finish(purchase)
                } else if (!isConsumable(purchase)) {
                    finish(purchase)
                } else if (answersFlow && wanted in purchase.productIds) {
                    // The purchase flow's own consumable: the app grants it from PurchaseOutcome.Purchased.
                    granted.add(purchase.purchaseToken)
                    finish(purchase)
                }
                // Other consumables: refresh() hands them to onConsumablePurchased, then consumes them.
            }
            refresh()
            if (update.purchases.any { it.state == RevflarePurchase.State.PURCHASED }) linkPurchases()
        }
        if (answersFlow && awaiting.compareAndSet(waiter, null)) waiter!!.deferred.complete(update)
    }

    /**
     * A purchased consumable found unconsumed: granted through [onConsumablePurchased] (once per process), then
     * consumed. Left alone while a purchase flow buys the same product (the flow grants it) or without a handler.
     */
    private suspend fun grantConsumable(purchase: RevflarePurchase): Boolean {
        val token = purchase.purchaseToken
        if (token !in granted) {
            val flowProduct = awaiting.get()?.let { productIdOf(it.productId) }
            if (flowProduct != null && flowProduct in purchase.productIds) return false
            val handler = onConsumablePurchased ?: run {
                Log.debug { "RevflareStore: ${purchase.productIds} purchased outside a purchase flow; set onConsumablePurchased to grant it" }
                return false
            }
            if (!granting.add(token)) return false
            try {
                handler(purchase)
                granted.add(token)
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                Log.error("RevflareStore: onConsumablePurchased failed for ${purchase.productIds}: $error (retried at the next refresh)")
                return false
            } finally {
                granting.remove(token)
            }
        }
        return token in consumed || finish(purchase)
    }

    /** Acknowledges a subscription / non-consumable, or consumes a consumable. Returns true when Play accepted it. */
    private suspend fun finish(purchase: RevflarePurchase): Boolean {
        val consumable = isConsumable(purchase)
        if (!consumable && purchase.isAcknowledged) return false
        val response = if (consumable) backend.consume(purchase.purchaseToken) else backend.acknowledge(purchase.purchaseToken)
        if (response.isOk) {
            if (consumable) consumed.add(purchase.purchaseToken)
            Log.debug { "RevflareStore: ${if (consumable) "consumed" else "acknowledged"} ${purchase.productIds}" }
        } else {
            // Retried at the next refresh (foreground, launch); Play refunds after 3 days without acknowledgement.
            Log.error("RevflareStore: could not ${if (consumable) "consume" else "acknowledge"} ${purchase.productIds}: ${response.code} ${response.message}")
        }
        return response.isOk
    }

    /**
     * Consumes a purchase of a consumable the app has granted (only needed without [onConsumablePurchased]: purchases
     * found by [refresh] that the store did not consume itself, e.g. a pending consumable that completed while the app
     * was closed).
     */
    public suspend fun consume(purchase: RevflarePurchase): Boolean {
        granted.add(purchase.purchaseToken)
        val response = backend.consume(purchase.purchaseToken)
        if (response.isOk) consumed.add(purchase.purchaseToken)
        refresh()
        return response.isOk
    }

    /**
     * Restores purchases: re-reads them from Play (purchases made on other devices with the same Google account
     * appear) and links them to this install. Only call it from a "Restore Purchases" button; [entitlements] is
     * otherwise always current.
     */
    public suspend fun restore(): CustomerEntitlements {
        trackEvent("restore_start", emptyMap())
        if (!refresh()) {
            trackEvent("restore_failed", mapOf("error" to "billing_unavailable"))
            throw RevflareBillingException(BillingClient.BillingResponseCode.BILLING_UNAVAILABLE, "Google Play Billing is not available")
        }
        linkPurchases()
        val entitlements = _entitlements.value
        trackEvent("restore_success", mapOf("entitlements" to entitlements.active.keys.sorted().joinToString(",")))
        return entitlements
    }

    // Lifecycle

    internal fun start() {
        started = true
        scope.launch { backend.updates.collect { handle(it) } }
        scope.launch {
            refresh()
            loadProducts()
            if (loadsOfferingsAutomatically) loadOfferings() else syncServerProducts()
        }
    }

    /** The app came to the foreground. */
    internal fun foreground() {
        scope.launch {
            refresh()
            // Cheap when fresh (no request under 5 minutes, then a 304 when unchanged).
            if (loadsOfferingsAutomatically || _offerings.value != null) loadOfferings() else syncServerProducts()
        }
    }

    internal companion object {
        /** The server's entitlements and pass durations, kept on the device. */
        const val SERVER_PRODUCTS_KEY = "app.revflare.kit.store.server-products"

        fun merge(existing: List<String>, adding: List<String>): List<String> {
            val known = existing.map(::productIdOf).toMutableSet()
            return existing + adding.filter { known.add(productIdOf(it)) }
        }
    }
}

/** What the purchase funnel events carry. */
internal data class PurchaseEventContext(
    val productId: String,
    val offering: String? = null,
    val pkg: String? = null,
    val placement: String? = null,
    val basePlan: String? = null,
    val offer: String? = null,
) {
    val properties: Map<String, String>
        get() {
            val properties = linkedMapOf("product" to productId)
            offering?.takeIf { it.isNotEmpty() }?.let { properties["offering"] = it }
            pkg?.takeIf { it.isNotEmpty() }?.let { properties["package"] = it }
            placement?.takeIf { it.isNotEmpty() }?.let { properties["placement"] = it }
            basePlan?.takeIf { it.isNotEmpty() }?.let { properties["base_plan"] = it }
            offer?.takeIf { it.isNotEmpty() }?.let { properties["offer"] = it }
            return properties
        }
}

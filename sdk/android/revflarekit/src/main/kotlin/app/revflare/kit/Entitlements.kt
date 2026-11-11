package app.revflare.kit

/** A Google Play purchase, reduced to plain values (from Play Billing's `Purchase`). */
public data class RevflarePurchase(
    /** Play order id (`GPA.…`, renewals add `..N`); null while pending. */
    val orderId: String?,
    val purchaseToken: String,
    val productIds: List<String>,
    /** `subs` or `inapp` (Play's product types). */
    val productType: String,
    val state: State,
    val isAcknowledged: Boolean,
    val isAutoRenewing: Boolean,
    /** A subscription in account hold or paused (only returned when asked for): gives no access. */
    val isSuspended: Boolean = false,
    /** Milliseconds since 1970. */
    val purchaseTime: Long,
    val quantity: Int = 1,
    /** The obfuscated account id set at purchase ([Revflare.installId] with [RevflareStore]). */
    val obfuscatedAccountId: String? = null,
    /** Play's JSON and signature, for apps that verify purchases themselves. */
    val originalJson: String = "",
    val signature: String = "",
) {
    public enum class State { PURCHASED, PENDING, UNSPECIFIED }

    /** The order id without the renewal suffix `..N` (the subscription's first order). */
    val baseOrderId: String? get() = Reporter.baseOrderId(orderId)

    val isSubscription: Boolean get() = productType == PRODUCT_TYPE_SUBS

    public companion object {
        public const val PRODUCT_TYPE_SUBS: String = "subs"
        public const val PRODUCT_TYPE_INAPP: String = "inapp"
    }
}

/** An active entitlement (like RevenueCat's `EntitlementInfo`). */
public data class EntitlementInfo(
    /** The entitlement name from the mapping, e.g. `"pro"`. */
    val identifier: String,
    /**
     * The product that grants it: a lifetime purchase wins, then a subscription, then the non-renewing pass that ends
     * last; between equals, the latest purchase.
     */
    val productId: String,
    val isSubscription: Boolean,
    /** The subscription renews (Play's `isAutoRenewing`); false for one-time products. */
    val willRenew: Boolean,
    val latestPurchaseTime: Long,
    val purchase: RevflarePurchase,
    /**
     * When a non-renewing pass ends (milliseconds since 1970, stacked passes included); null for lifetime purchases
     * and subscriptions (Play gives no expiration date on the device).
     */
    val expirationTime: Long? = null,
) {
    /** A one-time (non-consumable) purchase that never expires; false for subscriptions and non-renewing passes. */
    val isLifetime: Boolean get() = !isSubscription && expirationTime == null

    /** Granted by a non-renewing pass ([expirationTime] is set). */
    val isNonRenewing: Boolean get() = !isSubscription && expirationTime != null
}

/** Which product ids grant which entitlement (like RevenueCat entitlements). A product can grant several. */
public data class EntitlementMapping(
    /** Entitlement name → product ids (Play product ids; a `:basePlan` suffix is ignored). */
    val entitlements: Map<String, Set<String>> = emptyMap(),
) {
    public fun entitlements(productId: String): Set<String> =
        entitlements.filterValues { ids -> ids.any { productIdOf(it) == productId } }.keys

    val allProductIds: Set<String> get() = entitlements.values.flatten().toSet()

    public companion object {
        @JvmStatic
        public fun of(entitlements: Map<String, List<String>>): EntitlementMapping =
            EntitlementMapping(entitlements.mapValues { it.value.toSet() })
    }
}

/** "premium:monthly" → "premium". */
internal fun productIdOf(spec: String): String = spec.substringBefore(':')

/** "premium:monthly" → "monthly", "premium" → null. */
internal fun basePlanIdOf(spec: String): String? = spec.substringAfter(':', "").ifEmpty { null }

/** The customer's access, computed from Play Billing's owned purchases. */
public data class CustomerEntitlements(
    /** Active entitlements by name. */
    val active: Map<String, EntitlementInfo> = emptyMap(),
    /** Product id → the purchase that gives access to it. */
    val activePurchases: Map<String, RevflarePurchase> = emptyMap(),
    /** Every purchase Play returned (also pending ones and unconsumed consumables). */
    val purchases: List<RevflarePurchase> = emptyList(),
    /** Product id → when its non-renewing passes end (active passes only). */
    val expirationTimes: Map<String, Long> = emptyMap(),
) {
    val activeProductIds: Set<String> get() = activePurchases.keys

    public fun isActive(entitlement: String): Boolean = active.containsKey(entitlement)

    public companion object {
        /**
         * Computes access. Pure. Rules: only `PURCHASED` purchases give access (pending ones do not, suspended
         * subscriptions do not); consumables never do; subscriptions Play still returns are active (including the
         * billing grace period, which Play reports as active); one-time products last for ever.
         */
        public fun compute(
            purchases: List<RevflarePurchase>,
            mapping: EntitlementMapping,
            consumables: Set<String> = emptySet(),
        ): CustomerEntitlements = compute(purchases, mapping, consumables, emptyMap())

        /**
         * Computes access with non-renewing passes. Pure. Besides the rules above: one-time products listed in
         * [nonRenewingDurations] are passes (never consumables, even when also listed in [consumables]: durations
         * win). A product's passes ([purchases] and [passHistory], the passes Play no longer returns because they
         * were consumed, deduplicated by purchase token) stack: each ends at `max(purchase time, previous end) +
         * duration`; the product gives access while [now] is before the last end. For an entitlement, a lifetime
         * purchase beats a subscription, which beats a pass; between passes the later end wins.
         */
        public fun compute(
            purchases: List<RevflarePurchase>,
            mapping: EntitlementMapping,
            consumables: Set<String>,
            nonRenewingDurations: Map<String, NonRenewingDuration>,
            passHistory: List<RevflarePurchase> = emptyList(),
            now: Long = System.currentTimeMillis(),
        ): CustomerEntitlements {
            val effectiveConsumables = consumables - nonRenewingDurations.keys
            fun isPass(purchase: RevflarePurchase, productId: String) = !purchase.isSubscription && productId in nonRenewingDurations
            val active = LinkedHashMap<String, RevflarePurchase>()
            val expirations = HashMap<String, Long>()
            fun better(a: RevflarePurchase, b: RevflarePurchase): Boolean = when {
                !a.isSubscription && b.isSubscription -> true
                a.isSubscription && !b.isSubscription -> false
                else -> a.purchaseTime > b.purchaseTime
            }
            for (purchase in purchases) {
                if (purchase.state != RevflarePurchase.State.PURCHASED || purchase.isSuspended) continue
                for (productId in purchase.productIds) {
                    if (productId in effectiveConsumables || isPass(purchase, productId)) continue
                    val existing = active[productId]
                    if (existing == null || better(purchase, existing)) active[productId] = purchase
                }
            }
            for ((productId, chain) in PassChains.compute(purchases + passHistory, nonRenewingDurations)) {
                val last = chain.last()
                if (last.end > now && productId !in active) {
                    active[productId] = last.purchase
                    expirations[productId] = last.end
                }
            }
            /** 2 lifetime, 1 subscription, 0 pass. */
            fun rank(productId: String, purchase: RevflarePurchase) = when {
                productId in expirations -> 0
                purchase.isSubscription -> 1
                else -> 2
            }
            val entitlements = LinkedHashMap<String, EntitlementInfo>()
            for ((name, specs) in mapping.entitlements.toSortedMap()) {
                var best: Pair<String, RevflarePurchase>? = null
                for (productId in specs.map(::productIdOf).distinct().sorted()) {
                    val purchase = active[productId] ?: continue
                    val current = best
                    val wins = current == null || run {
                        val (bestId, bestPurchase) = current
                        val (r, rb) = rank(productId, purchase) to rank(bestId, bestPurchase)
                        when {
                            r != rb -> r > rb
                            r == 0 && expirations.getValue(productId) != expirations.getValue(bestId) ->
                                expirations.getValue(productId) > expirations.getValue(bestId)
                            else -> purchase.purchaseTime > bestPurchase.purchaseTime
                        }
                    }
                    if (wins) best = productId to purchase
                }
                val (productId, purchase) = best ?: continue
                entitlements[name] = EntitlementInfo(
                    identifier = name,
                    productId = productId,
                    isSubscription = purchase.isSubscription,
                    willRenew = purchase.isSubscription && purchase.isAutoRenewing,
                    latestPurchaseTime = purchase.purchaseTime,
                    purchase = purchase,
                    expirationTime = expirations[productId],
                )
            }
            return CustomerEntitlements(entitlements, active, purchases, expirations)
        }
    }
}

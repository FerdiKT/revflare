package app.revflare.kit

import java.util.Calendar
import java.util.GregorianCalendar
import java.util.TimeZone

/**
 * How long a non-renewing pass (a one-time Play product sold as "3 days of Pro", "1 month of Pro"...) grants its
 * entitlements, counted from the purchase (or from the end of the previous pass of the same product: passes stack).
 *
 * Set per product in the app ([Revflare.configurePurchases] `nonRenewingDurations`) or in Revflare (sent with the
 * offerings). A duration set in Revflare never applies to a product the app declares itself (its entitlement map,
 * product ids or consumables) unless the app also sets a local duration for it (then the local one applies): a
 * server configuration can never turn a lifetime product the app shipped with, or a consumable, into an expiring pass.
 * Google Play does not tell lifetime one-time products from passes: never give a duration to a lifetime product.
 */
public data class NonRenewingDuration(val unit: Unit, val count: Int) {
    init {
        require(count >= 1) { "NonRenewingDuration.count must be at least 1 (got $count)" }
    }

    public enum class Unit { DAY, WEEK, MONTH, YEAR }

    /**
     * When a pass bought at [fromMillis] (milliseconds since 1970) ends, in UTC: days and weeks are exact multiples of
     * 24 hours; months and years are calendar steps that clamp to the last day of a shorter month (Jan 31 + 1 month =
     * Feb 28 / 29, Feb 29 + 1 year = Feb 28). Same rules as the iOS SDK and the Revflare server.
     */
    public fun end(fromMillis: Long): Long = when (unit) {
        Unit.DAY -> fromMillis + count * DAY_MS
        Unit.WEEK -> fromMillis + count * 7 * DAY_MS
        // java.util.Calendar rather than java.time: minSdk 24 has no java.time without desugaring.
        Unit.MONTH, Unit.YEAR -> GregorianCalendar(TimeZone.getTimeZone("UTC")).run {
            timeInMillis = fromMillis
            add(if (unit == Unit.MONTH) Calendar.MONTH else Calendar.YEAR, count)
            timeInMillis
        }
    }

    internal val wireUnit: String get() = unit.name.lowercase()

    public companion object {
        private const val DAY_MS = 86_400_000L

        @JvmStatic public fun days(count: Int): NonRenewingDuration = NonRenewingDuration(Unit.DAY, count)
        @JvmStatic public fun weeks(count: Int): NonRenewingDuration = NonRenewingDuration(Unit.WEEK, count)
        @JvmStatic public fun months(count: Int): NonRenewingDuration = NonRenewingDuration(Unit.MONTH, count)
        @JvmStatic public fun years(count: Int): NonRenewingDuration = NonRenewingDuration(Unit.YEAR, count)

        /** `{"unit":"day","count":3}`; null when malformed (unknown unit, count missing / not a whole number ≥ 1). */
        internal fun parse(json: RevflareJson?): NonRenewingDuration? {
            val unit = when (json?.get("unit")?.stringValue?.lowercase()) {
                "day" -> Unit.DAY
                "week" -> Unit.WEEK
                "month" -> Unit.MONTH
                "year" -> Unit.YEAR
                else -> return null
            }
            val count = json["count"]?.intValue?.takeIf { it >= 1 } ?: return null
            return NonRenewingDuration(unit, count)
        }
    }
}

/**
 * The product configuration the server sends with the offerings (`entitlements`, `products[*].duration`), also kept
 * on the device so it applies at launch, offline too.
 */
internal data class ServerProducts(
    /** Entitlement name → product ids (`id` or `id:basePlan`). */
    val entitlements: Map<String, List<String>> = emptyMap(),
    /** Product id → pass duration. */
    val durations: Map<String, NonRenewingDuration> = emptyMap(),
) {
    /** Every product id referenced (entitlement products first), without duplicates. */
    val productIds: List<String> get() = (entitlements.toSortedMap().values.flatten() + durations.keys.sorted()).distinct()

    fun toJson(): String = RevflareJson.obj(
        "entitlements" to RevflareJson.Object(entitlements.mapValues { RevflareJson.strings(it.value) }),
        "products" to RevflareJson.Object(
            durations.mapValues { (_, duration) ->
                RevflareJson.obj(
                    "duration" to RevflareJson.obj(
                        "unit" to RevflareJson.Str(duration.wireUnit),
                        "count" to RevflareJson.num(duration.count.toLong()),
                    ),
                )
            },
        ),
    ).toJsonString()

    companion object {
        val EMPTY = ServerProducts()

        /** Lenient: reads `entitlements` and `products` of an object (the offerings answer or the stored copy). */
        fun parse(json: RevflareJson?): ServerProducts {
            val entitlements = LinkedHashMap<String, List<String>>()
            for ((name, value) in json?.get("entitlements")?.objectValue.orEmpty()) {
                val ids = value.arrayValue?.mapNotNull { it.stringValue?.trim()?.takeIf(String::isNotEmpty) }?.distinct() ?: continue
                if (name.isNotEmpty() && ids.isNotEmpty()) entitlements[name] = ids
            }
            val durations = LinkedHashMap<String, NonRenewingDuration>()
            for ((productId, value) in json?.get("products")?.objectValue.orEmpty()) {
                val duration = NonRenewingDuration.parse(value["duration"]) ?: continue
                if (productId.isNotEmpty()) durations[productId] = duration
            }
            return ServerProducts(entitlements, durations)
        }

        fun fromJson(text: String?): ServerProducts? = text?.let { RevflareJson.parseOrNull(it) }?.let(::parse)
    }
}

/** Merge rules between the app's configuration and the server's. */
internal object ProductConfigRules {
    /** Union per entitlement: the app's products always apply, the server adds its own. */
    fun mapping(local: EntitlementMapping, server: Map<String, List<String>>): EntitlementMapping {
        if (server.isEmpty()) return local
        val merged = LinkedHashMap<String, Set<String>>()
        for ((name, ids) in local.entitlements) merged[name] = ids
        for ((name, ids) in server) merged[name] = (merged[name] ?: emptySet()) + ids
        return EntitlementMapping(merged)
    }

    /**
     * The app's durations plus the server's for products the app does **not** declare ([declared]: its entitlement
     * map, product ids and consumables, as product ids without base plan). A server duration never applies to a
     * product the app shipped with unless the app sets a local duration for it too (the local one then applies).
     */
    fun durations(
        local: Map<String, NonRenewingDuration>,
        server: Map<String, NonRenewingDuration>,
        declared: Set<String> = emptySet(),
    ): Map<String, NonRenewingDuration> =
        if (server.isEmpty()) local else server.filterKeys { productIdOf(it) !in declared } + local
}

/**
 * A non-renewing pass purchase seen by the store. Play never returns a consumed one-time purchase again, so this
 * local record is what keeps a pass (and the passes it stacks on) counted after the store consumed it.
 */
internal data class PassRecord(
    val purchaseToken: String,
    val productId: String,
    val purchaseTime: Long,
    /** The store consumed it (or tried to): Play no longer returning it is expected, not a refund. */
    val consumedByUs: Boolean = false,
    val quantity: Int = 1,
    val orderId: String? = null,
) {
    /** As a purchase, for [CustomerEntitlements.compute]. */
    fun toPurchase(): RevflarePurchase = RevflarePurchase(
        orderId = orderId,
        purchaseToken = purchaseToken,
        productIds = listOf(productId),
        productType = RevflarePurchase.PRODUCT_TYPE_INAPP,
        state = RevflarePurchase.State.PURCHASED,
        isAcknowledged = true,
        isAutoRenewing = false,
        purchaseTime = purchaseTime,
        quantity = quantity,
    )

    fun toJson(): RevflareJson = RevflareJson.obj(
        "token" to RevflareJson.Str(purchaseToken),
        "product" to RevflareJson.Str(productId),
        "time" to RevflareJson.num(purchaseTime),
        "consumed" to RevflareJson.Bool(consumedByUs),
        "quantity" to RevflareJson.num(quantity.toLong()),
        "orderId" to RevflareJson.str(orderId),
    )

    companion object {
        fun parse(json: RevflareJson): PassRecord? = PassRecord(
            purchaseToken = json["token"]?.stringValue ?: return null,
            productId = json["product"]?.stringValue ?: return null,
            purchaseTime = json["time"]?.longValue ?: return null,
            consumedByUs = json["consumed"]?.boolValue ?: false,
            quantity = json["quantity"]?.intValue?.coerceAtLeast(1) ?: 1,
            orderId = json["orderId"]?.stringValue,
        )
    }
}

/** The pass ledger, kept in RevflareKit's key-value store. Thread-safe. */
internal class PassLedger(private val store: KeyValueStore, private val key: String = KEY) {
    companion object {
        const val KEY = "app.revflare.kit.store.passes"
    }

    private var records: List<PassRecord> = load()

    private fun load(): List<PassRecord> =
        store.string(key)?.let { RevflareJson.parseOrNull(it) }?.arrayValue.orEmpty().mapNotNull(PassRecord::parse).distinctBy { it.purchaseToken }

    @get:Synchronized
    val entries: List<PassRecord> get() = records

    @Synchronized
    fun record(purchase: RevflarePurchase, productId: String): Boolean {
        if (records.any { it.purchaseToken == purchase.purchaseToken }) return false
        save(records + PassRecord(purchase.purchaseToken, productId, purchase.purchaseTime, quantity = purchase.quantity.coerceAtLeast(1), orderId = purchase.orderId))
        return true
    }

    /** Marks a pass as consumed by the store (set before asking Play, kept when Play fails: see [PassRecord.consumedByUs]). */
    @Synchronized
    fun markConsumed(purchaseToken: String) {
        if (records.none { it.purchaseToken == purchaseToken && !it.consumedByUs }) return
        save(records.map { if (it.purchaseToken == purchaseToken) it.copy(consumedByUs = true) else it })
    }

    /**
     * Validates the ledger against a **successful** `queryPurchases` answer ([owned]: every purchase Play returned).
     * Never call it when Play could not answer: nothing must be dropped then. Returns the dropped records.
     *
     * - A pass Play no longer returns that the store did not consume was refunded, revoked or cleared (test
     *   purchases): dropped.
     * - Consumed passes (Play never returns them again) count only while their product's chain is anchored: Play
     *   still returns a purchase of that product (the latest pass, bought right after the store consumed the previous
     *   ones). When Play returns none, the product's whole chain is dropped: its latest pass was refunded, revoked or
     *   cleared, so the earlier ones the store consumed can't be checked any more. Tradeoff: refunding the latest pass
     *   also removes the earlier stacked time on this device.
     * - Exception: when the product's latest pass is itself consumed by the store, Play's silence is expected (a
     *   re-buy that was consumed first and then cancelled or failed), so its chain is kept.
     */
    @Synchronized
    fun validate(owned: List<RevflarePurchase>): List<PassRecord> {
        val ownedTokens = owned.map { it.purchaseToken }.toSet()
        val ownedProducts = owned.filter { it.state == RevflarePurchase.State.PURCHASED }.flatMap { it.productIds }.toSet()
        val dropped = LinkedHashSet<PassRecord>()
        for ((productId, chain) in records.groupBy { it.productId }) {
            val latest = chain.maxWith(compareBy<PassRecord> { it.purchaseTime }.thenBy { it.purchaseToken })
            if (productId !in ownedProducts && !latest.consumedByUs) {
                dropped += chain
            } else {
                dropped += chain.filter { !it.consumedByUs && it.purchaseToken !in ownedTokens }
            }
        }
        if (dropped.isNotEmpty()) save(records.filter { it !in dropped })
        return dropped.toList()
    }

    private fun save(updated: List<PassRecord>) {
        records = updated
        store.set(key, RevflareJson.Array(updated.map { it.toJson() }).toJsonString())
    }
}

/** Pass expiry with stacking. Pure. */
internal object PassChains {
    data class Pass(val purchase: RevflarePurchase, val productId: String, val end: Long)

    /**
     * Product id → its passes sorted by purchase time, each with its end: `max(purchaseTime, previous end) + duration`
     * (a repeat purchase extends from the later of its purchase time and the current expiry; a quantity of N counts N
     * times). Only `PURCHASED` one-time purchases of products in [durations]; deduplicated by purchase token (first
     * occurrence wins: pass Play's purchases first).
     */
    fun compute(purchases: List<RevflarePurchase>, durations: Map<String, NonRenewingDuration>): Map<String, List<Pass>> {
        if (durations.isEmpty()) return emptyMap()
        val seen = HashSet<String>()
        val byProduct = LinkedHashMap<String, MutableList<RevflarePurchase>>()
        for (purchase in purchases) {
            if (purchase.state != RevflarePurchase.State.PURCHASED || purchase.isSubscription) continue
            val productId = purchase.productIds.firstOrNull { it in durations } ?: continue
            if (!seen.add(purchase.purchaseToken)) continue
            byProduct.getOrPut(productId) { ArrayList() }.add(purchase)
        }
        return byProduct.mapValues { (productId, list) ->
            val duration = durations.getValue(productId)
            var previousEnd = Long.MIN_VALUE
            list.sortedWith(compareBy<RevflarePurchase> { it.purchaseTime }.thenBy { it.purchaseToken }).map { purchase ->
                var end = maxOf(purchase.purchaseTime, previousEnd)
                repeat(purchase.quantity.coerceAtLeast(1)) { end = duration.end(end) }
                previousEnd = end
                Pass(purchase, productId, end)
            }
        }
    }

    /** The earliest pass end after [now] (when access changes), or null. */
    fun nextEnd(chains: Map<String, List<Pass>>, now: Long): Long? =
        chains.values.flatten().map { it.end }.filter { it > now }.minOrNull()
}

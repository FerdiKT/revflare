package app.revflare.kit

import com.android.billingclient.api.ProductDetails
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

// Public model

/** How [Revflare.offerings] gets the offerings. */
public enum class OfferingsFetchPolicy {
    /**
     * Returns the offerings cached on the device at once when they are fresh (fetched or confirmed by the server in
     * the last 5 minutes); otherwise asks the server. If the server can't be reached, falls back to the cached
     * offerings (however old), else throws.
     */
    CACHED_OR_FETCHED,

    /** Always asks the server (a cheap 304 when nothing changed); falls back to the cached offerings when unreachable. */
    FETCH_CURRENT,
}

/** Well-known package identifiers (any other string works too). */
public object RevflarePackageIdentifier {
    public const val WEEKLY: String = "\$weekly"
    public const val MONTHLY: String = "\$monthly"
    public const val TWO_MONTH: String = "\$two_month"
    public const val THREE_MONTH: String = "\$three_month"
    public const val SIX_MONTH: String = "\$six_month"
    public const val ANNUAL: String = "\$annual"
    public const val LIFETIME: String = "\$lifetime"
}

/** Errors thrown by [Revflare.offerings]. */
public sealed class RevflareOfferingsException(message: String) : Exception(message) {
    /** [Revflare.configure] was not called yet. */
    public class NotConfigured : RevflareOfferingsException("RevflareKit is not configured: call Revflare.configure first.")
    /** The server does not know the SDK key (404). */
    public class UnknownSdkKey : RevflareOfferingsException("The Revflare server does not know this SDK key.")
    /** The server answered with an unexpected HTTP status. */
    public class Server(public val status: Int) : RevflareOfferingsException("The Revflare server answered HTTP $status.")
    /** The server could not be reached. */
    public class Network(detail: String) : RevflareOfferingsException("The Revflare server could not be reached ($detail).")
    /** The server's answer could not be read. */
    public class InvalidResponse(detail: String) : RevflareOfferingsException("The offerings could not be read ($detail).")
    /** Google Play could not load the offerings' products. */
    public class ProductsUnavailable(detail: String) : RevflareOfferingsException("The Play products could not be loaded ($detail).")
}

/** The offerings of the app, as set in Revflare (web → the app → Offerings, or `revflare offerings`). */
public class RevflareOfferings internal constructor(snapshot: OfferingsSnapshot<ResolvedProduct>) {
    /** The configuration's version (the server's ETag): changes whenever an offering or a placement changes. */
    public val version: String = snapshot.version
    /** Every offering, in the server's order. */
    public val ordered: List<RevflareOffering> = snapshot.offerings.map(::RevflareOffering)
    /** Every offering, by identifier. */
    public val all: Map<String, RevflareOffering> = ordered.associateBy { it.identifier }
    /** The offering marked "current" in Revflare (null when none is). */
    public val current: RevflareOffering? = snapshot.currentOfferingId?.let { all[it] }
    /** Placement → offering identifier (null: the current offering). */
    public val placements: Map<String, String?> = snapshot.placements
    /**
     * Entitlement name → product ids, as set in Revflare (empty with older servers). [RevflareStore] merges it with
     * the app's own mapping (union per entitlement).
     */
    public val entitlements: Map<String, List<String>> = snapshot.serverProducts.entitlements
    /**
     * Product id → non-renewing pass duration, as set in Revflare (empty with older servers). [RevflareStore] merges
     * it with the app's own durations (the app's win for the same product).
     */
    public val nonRenewingDurations: Map<String, NonRenewingDuration> = snapshot.serverProducts.durations
    /** The Play products of [entitlements] and [nonRenewingDurations] (also those on no paywall). */
    internal val referencedProducts: List<ProductDetails> = snapshot.referencedProducts.values.map { it.details }.distinctBy { it.productId }

    /** The offering with this identifier. */
    public operator fun get(identifier: String): RevflareOffering? = all[identifier]

    /**
     * The offering to show at a paywall location of the app ("onboarding", "settings"...). An unknown placement, a
     * placement without an offering, or one pointing at an offering that no longer exists gives [current].
     */
    public fun offering(placement: String): RevflareOffering? =
        OfferingRules.offeringId(placement, placements, current?.identifier, all.keys)?.let { all[it] }

    override fun equals(other: Any?): Boolean = other is RevflareOfferings && other.version == version && other.ordered == ordered && other.placements == placements &&
        other.entitlements == entitlements && other.nonRenewingDurations == nonRenewingDurations
    override fun hashCode(): Int = version.hashCode()
}

/** One offering: the packages (products) a paywall shows, in display order, with free-form metadata. */
@ConsistentCopyVisibility
public data class RevflareOffering internal constructor(
    val identifier: String,
    val displayName: String,
    /** Free-form JSON set in Revflare for the paywall (titles, colors, layout keys...). */
    val metadata: Map<String, RevflareJson>,
    /** The packages, in the server's order. Packages whose Play product can't be loaded are left out. */
    val packages: List<RevflarePackage>,
) {
    internal constructor(entry: OfferingEntry<ResolvedProduct>) : this(
        entry.identifier, entry.displayName, entry.metadata, entry.packages.map(::RevflarePackage),
    )

    /** The first package with this identifier. */
    public fun packageWithIdentifier(identifier: String): RevflarePackage? = packages.firstOrNull { it.identifier == identifier }

    /** The package that sells this Play product. */
    public fun packageForProduct(productId: String): RevflarePackage? = packages.firstOrNull { it.productId == productId }

    val weekly: RevflarePackage? get() = packageWithIdentifier(RevflarePackageIdentifier.WEEKLY)
    val monthly: RevflarePackage? get() = packageWithIdentifier(RevflarePackageIdentifier.MONTHLY)
    val twoMonth: RevflarePackage? get() = packageWithIdentifier(RevflarePackageIdentifier.TWO_MONTH)
    val threeMonth: RevflarePackage? get() = packageWithIdentifier(RevflarePackageIdentifier.THREE_MONTH)
    val sixMonth: RevflarePackage? get() = packageWithIdentifier(RevflarePackageIdentifier.SIX_MONTH)
    val annual: RevflarePackage? get() = packageWithIdentifier(RevflarePackageIdentifier.ANNUAL)
    val lifetime: RevflarePackage? get() = packageWithIdentifier(RevflarePackageIdentifier.LIFETIME)
}

/**
 * A product as offered in an offering. Subscriptions sell one base plan: the package's product id in Revflare is
 * `subscriptionId:basePlanId` (or just `subscriptionId`: the first auto-renewing base plan Play returns).
 */
@ConsistentCopyVisibility
public data class RevflarePackage internal constructor(
    /** `$annual`, `$weekly`... or a custom string. */
    val identifier: String,
    /** The Play product id (without the base plan). */
    val productId: String,
    /** The Play product (price: [defaultOffer] pricing phases or `oneTimePurchaseOfferDetails.formattedPrice`). */
    val product: ProductDetails,
    /** The subscription base plan sold, null for one-time products. */
    val basePlanId: String?,
    /**
     * The subscription offer used by default: the eligible offer of the base plan with the longest free trial, else
     * the cheapest first phase, else the base plan itself (offers tagged `revflare-ignore` are skipped). Play only
     * returns offers the user is eligible for.
     */
    val defaultOffer: ProductDetails.SubscriptionOfferDetails?,
    /** Every eligible offer of the base plan (the base plan itself included), as Play returned them. */
    val subscriptionOffers: List<ProductDetails.SubscriptionOfferDetails>,
    /** The offer token [RevflareStore.purchase] uses (the default offer's, or the one-time offer's). */
    val offerToken: String?,
    /** Free-form JSON set in Revflare for this package (badge, highlight...). */
    val metadata: Map<String, RevflareJson>,
    /** The offering the package belongs to. */
    val offeringIdentifier: String,
) {
    internal constructor(entry: PackageEntry<ResolvedProduct>) : this(
        identifier = entry.identifier,
        productId = productIdOf(entry.productId),
        product = entry.product.details,
        basePlanId = entry.product.basePlanId,
        defaultOffer = entry.product.defaultOffer,
        subscriptionOffers = entry.product.offers,
        offerToken = entry.product.offerToken,
        metadata = entry.metadata,
        offeringIdentifier = entry.offeringIdentifier,
    )

    /** `offeringIdentifier/identifier`. */
    val id: String get() = "$offeringIdentifier/$identifier"
}

// Rules (product-independent, tested with fake products)

internal object OfferingRules {
    /** The offering id a placement resolves to: its own offering when set and present, else the current one. */
    fun offeringId(placement: String, placements: Map<String, String?>, current: String?, available: Set<String>): String? {
        val mapped = placements[placement]
        if (mapped != null && mapped in available) return mapped
        if (current != null && current in available) return current
        return null
    }
}

/** One subscription offer (or base plan), reduced to what the default offer choice needs. */
internal data class OfferInfo(
    val basePlanId: String,
    /** Null for the base plan itself. */
    val offerId: String?,
    val offerToken: String,
    val tags: List<String>,
    val phases: List<PhaseInfo>,
)

internal data class PhaseInfo(
    val priceMicros: Long,
    /** ISO 8601 period, e.g. "P1W", "P3D", "P1M". */
    val billingPeriod: String,
    val billingCycleCount: Int,
    /** Play's recurrence mode: 1 infinite, 2 finite, 3 non-recurring. */
    val recurrenceMode: Int,
)

internal object OfferSelection {
    const val IGNORE_TAG = "revflare-ignore"

    /**
     * The base plan to sell: the requested one when the product has it (null when it does not), else the first base
     * plan that has a base offer (auto-renewing first), else the first one.
     */
    fun basePlan(offers: List<OfferInfo>, requested: String?): String? {
        if (requested != null) return requested.takeIf { id -> offers.any { it.basePlanId == id } }
        val bases = offers.filter { it.offerId == null }
        return (bases.firstOrNull { base -> base.phases.lastOrNull()?.recurrenceMode == 1 } ?: bases.firstOrNull() ?: offers.firstOrNull())?.basePlanId
    }

    /** The default offer of a base plan: longest free trial, else cheapest first phase, else the base plan. */
    fun defaultOffer(offers: List<OfferInfo>, basePlanId: String): OfferInfo? {
        val plan = offers.filter { it.basePlanId == basePlanId }
        val base = plan.firstOrNull { it.offerId == null }
        val candidates = plan.filter { it.offerId != null && IGNORE_TAG !in it.tags }
        val withTrial = candidates.mapNotNull { offer -> freeTrialDays(offer).takeIf { it > 0 }?.let { offer to it } }
        if (withTrial.isNotEmpty()) return withTrial.maxByOrNull { it.second }!!.first
        val basePrice = base?.phases?.lastOrNull()?.priceMicros
        val discounted = candidates.filter { offer ->
            val first = offer.phases.firstOrNull()?.priceMicros ?: return@filter false
            basePrice == null || first < basePrice
        }
        if (discounted.isNotEmpty()) return discounted.minByOrNull { it.phases.first().priceMicros }
        return base ?: candidates.firstOrNull()
    }

    /** Days of free phases at the start of the offer. */
    fun freeTrialDays(offer: OfferInfo): Int =
        offer.phases.filter { it.priceMicros == 0L }.sumOf { periodDays(it.billingPeriod) * maxOf(it.billingCycleCount, 1) }

    /** "P1W" → 7, "P3D" → 3, "P1M" → 30, "P1Y" → 365 (approximate, for comparing). */
    fun periodDays(period: String): Int {
        val match = Regex("^P(?:(\\d+)Y)?(?:(\\d+)M)?(?:(\\d+)W)?(?:(\\d+)D)?$").find(period) ?: return 0
        val (years, months, weeks, days) = match.destructured
        return (years.toIntOrNull() ?: 0) * 365 + (months.toIntOrNull() ?: 0) * 30 +
            (weeks.toIntOrNull() ?: 0) * 7 + (days.toIntOrNull() ?: 0)
    }
}

/** A Play product resolved for one package. */
internal data class ResolvedProduct(
    val details: ProductDetails,
    val basePlanId: String?,
    val defaultOffer: ProductDetails.SubscriptionOfferDetails?,
    val offers: List<ProductDetails.SubscriptionOfferDetails>,
    val offerToken: String?,
) {
    companion object {
        /** Resolves `subscriptionId[:basePlanId]` against the product; null when the base plan does not exist. */
        fun resolve(spec: String, details: ProductDetails): ResolvedProduct? {
            val subscriptionOffers = details.subscriptionOfferDetails
            if (details.productType == RevflarePurchase.PRODUCT_TYPE_SUBS && subscriptionOffers != null) {
                val infos = subscriptionOffers.map { it.toInfo() }
                val basePlan = OfferSelection.basePlan(infos, basePlanIdOf(spec)) ?: return null
                val chosen = OfferSelection.defaultOffer(infos, basePlan)
                val planOffers = subscriptionOffers.filter { it.basePlanId == basePlan }
                val default = chosen?.let { info -> planOffers.firstOrNull { it.offerToken == info.offerToken } }
                return ResolvedProduct(details, basePlan, default, planOffers, default?.offerToken)
            }
            val oneTime = details.oneTimePurchaseOfferDetailsList?.firstOrNull() ?: details.oneTimePurchaseOfferDetails
            return ResolvedProduct(details, null, null, emptyList(), oneTime?.offerToken)
        }

        private fun ProductDetails.SubscriptionOfferDetails.toInfo() = OfferInfo(
            basePlanId = basePlanId,
            offerId = offerId,
            offerToken = offerToken,
            tags = offerTags,
            phases = pricingPhases.pricingPhaseList.map {
                PhaseInfo(it.priceAmountMicros, it.billingPeriod, it.billingCycleCount, it.recurrenceMode)
            },
        )
    }
}

/** The offerings with each package's product resolved (Play products in the app, anything in tests). */
internal class OfferingsSnapshot<P : Any>(response: OfferingsResponse, products: Map<String, P>) {
    val version: String = response.version
    val currentOfferingId: String? = response.currentOfferingId
    val placements: Map<String, String?> = response.placements
    val serverProducts: ServerProducts = response.serverProducts
    /** The loaded products of the ids referenced by [serverProducts] (by spec). */
    val referencedProducts: Map<String, P> = response.serverProducts.productIds.mapNotNull { id -> products[id]?.let { id to it } }.toMap()
    /** Product ids of packages left out because no product was available, in server order (no duplicates). */
    val droppedProductIds: List<String>
    val offerings: List<OfferingEntry<P>>

    init {
        val dropped = ArrayList<String>()
        offerings = response.offerings.map { offering ->
            val packages = offering.packages.mapNotNull { pkg ->
                val product = products[pkg.productId]
                if (product == null) {
                    if (pkg.productId !in dropped) dropped.add(pkg.productId)
                    null
                } else {
                    PackageEntry(pkg.identifier, pkg.productId, pkg.metadata, offering.identifier, product)
                }
            }
            OfferingEntry(offering.identifier, offering.displayName, offering.metadata, packages)
        }
        droppedProductIds = dropped
    }

    val current: OfferingEntry<P>? get() = currentOfferingId?.let(::offering)

    fun offering(identifier: String): OfferingEntry<P>? = offerings.firstOrNull { it.identifier == identifier }

    fun offeringForPlacement(placement: String): OfferingEntry<P>? =
        OfferingRules.offeringId(placement, placements, currentOfferingId, offerings.map { it.identifier }.toSet())?.let(::offering)
}

internal data class OfferingEntry<P : Any>(
    val identifier: String,
    val displayName: String,
    val metadata: Map<String, RevflareJson>,
    val packages: List<PackageEntry<P>>,
)

internal data class PackageEntry<P : Any>(
    val identifier: String,
    /** As set in Revflare (`subscriptionId[:basePlanId]`). */
    val productId: String,
    val metadata: Map<String, RevflareJson>,
    val offeringIdentifier: String,
    val product: P,
)

// Wire format (`GET /sdk/v1/offerings`)

internal data class OfferingsResponse(
    val version: String,
    val currentOfferingId: String?,
    val offerings: List<OfferingPayload>,
    /** Placement → offering id; null means the current offering. */
    val placements: Map<String, String?>,
    /** `entitlements` and `products[*].duration` (empty with older servers). */
    val serverProducts: ServerProducts = ServerProducts.EMPTY,
) {
    /** Every product id of every package, in server order, without duplicates. */
    val productIds: List<String> get() = offerings.flatMap { it.packages }.map { it.productId }.distinct()

    /** [productIds] and the products the server entitlements and durations reference, without duplicates. */
    val allProductIds: List<String> get() = (productIds + serverProducts.productIds).distinct()

    companion object {
        /** Lenient: one malformed offering or package does not hide the others. Throws when the body isn't an object. */
        fun parse(body: String): OfferingsResponse {
            val json = RevflareJson.parse(body) as? RevflareJson.Object ?: throw IllegalArgumentException("not an object")
            val offerings = json["offerings"]?.arrayValue.orEmpty().mapNotNull { OfferingPayload.parse(it) }
            val placements = json["placements"]?.objectValue.orEmpty().mapNotNull { (key, value) ->
                when (value) {
                    is RevflareJson.Str -> key to value.value
                    RevflareJson.Null -> key to null
                    else -> null
                }
            }.toMap()
            return OfferingsResponse(
                version = json["version"]?.stringValue ?: "",
                currentOfferingId = json["currentOfferingId"]?.stringValue,
                offerings = offerings,
                placements = placements,
                serverProducts = ServerProducts.parse(json),
            )
        }
    }
}

internal data class OfferingPayload(
    val identifier: String,
    val displayName: String,
    val metadata: Map<String, RevflareJson>,
    val packages: List<PackagePayload>,
) {
    companion object {
        fun parse(json: RevflareJson): OfferingPayload? {
            val identifier = json["identifier"]?.stringValue ?: return null
            return OfferingPayload(
                identifier = identifier,
                displayName = json["displayName"]?.stringValue ?: identifier,
                metadata = json["metadata"]?.objectValue.orEmpty(),
                packages = json["packages"]?.arrayValue.orEmpty().mapNotNull { PackagePayload.parse(it) },
            )
        }
    }
}

internal data class PackagePayload(val identifier: String, val productId: String, val metadata: Map<String, RevflareJson>) {
    companion object {
        fun parse(json: RevflareJson): PackagePayload? {
            val identifier = json["identifier"]?.stringValue ?: return null
            val productId = json["productId"]?.stringValue ?: return null
            return PackagePayload(identifier, productId, json["metadata"]?.objectValue.orEmpty())
        }
    }
}

// Fetching and caching

/** The last good answer, kept on the device (one SharedPreferences entry per server + SDK key). */
internal data class CachedOfferings(val etag: String?, val fetchedAt: Long, val appVersion: String?, val body: String) {
    fun toJson(): String = RevflareJson.obj(
        "etag" to RevflareJson.str(etag),
        "fetchedAt" to RevflareJson.num(fetchedAt),
        "appVersion" to RevflareJson.str(appVersion),
        "body" to RevflareJson.Str(body),
    ).toJsonString()

    companion object {
        fun fromJson(text: String?): CachedOfferings? {
            val json = text?.let { RevflareJson.parseOrNull(it) } ?: return null
            return CachedOfferings(
                etag = json["etag"]?.stringValue,
                fetchedAt = json["fetchedAt"]?.longValue ?: return null,
                appVersion = json["appVersion"]?.stringValue,
                body = json["body"]?.stringValue ?: return null,
            )
        }
    }
}

/** Fetches the offerings configuration, keeps the last good answer on disk and revalidates it with its ETag. */
internal class OfferingsFetcher(
    private val client: RevflareClient,
    private val store: KeyValueStore,
    private val appVersion: String?,
    private val clock: Clock,
) {
    companion object {
        /** A cached answer younger than this is used without asking the server. */
        const val MAX_AGE_MS = 5 * 60_000L

        fun cacheKey(server: String, sdkKey: String): String =
            "app.revflare.kit.offerings." + sha256Hex("$server\n$sdkKey").take(24)
    }

    val cacheKey: String = cacheKey(client.server, client.sdkKey)
    private val mutex = Mutex()
    private var cache: Pair<CachedOfferings, OfferingsResponse>? = null
    private var loadedFromDisk = false
    private var inFlight: CompletableDeferred<Result<OfferingsResponse>>? = null

    val cachedEntry: CachedOfferings? get() = loadCache()?.first

    suspend fun offerings(policy: OfferingsFetchPolicy): OfferingsResponse {
        val (deferred, owner) = mutex.withLock {
            if (policy == OfferingsFetchPolicy.CACHED_OR_FETCHED) {
                val cached = loadCache()
                if (cached != null && isFresh(cached.first)) return cached.second
            }
            inFlight?.let { return@withLock it to false }
            val created = CompletableDeferred<Result<OfferingsResponse>>()
            inFlight = created
            created to true
        }
        if (owner) {
            val result = runCatching { fetchOrFallBack() }
            mutex.withLock { inFlight = null }
            deferred.complete(result)
        }
        return deferred.await().getOrThrow()
    }

    private fun isFresh(entry: CachedOfferings): Boolean {
        val age = clock() - entry.fetchedAt
        return age in 0 until MAX_AGE_MS && entry.appVersion == appVersion
    }

    private suspend fun fetchOrFallBack(): OfferingsResponse {
        val cached = synchronized(this) { loadCache() }
        return try {
            fetch(cached)
        } catch (error: RevflareOfferingsException) {
            if (cached == null) throw error
            Log.debug { "Offerings: ${error.message} Using the cached offerings (version ${cached.second.version})." }
            cached.second
        }
    }

    private suspend fun fetch(cached: Pair<CachedOfferings, OfferingsResponse>?): OfferingsResponse {
        val query = appVersion?.takeIf { it.isNotEmpty() }?.let { listOf("appVersion" to it) } ?: emptyList()
        val request = client.getRequest(client.url(RevflareClient.Path.OFFERINGS, query), cached?.first?.etag)
        val response = try {
            client.transport.send(request)
        } catch (error: Exception) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            throw RevflareOfferingsException.Network(error.toString())
        }
        return when (response.status) {
            in 200..299 -> {
                val decoded = try {
                    OfferingsResponse.parse(response.body)
                } catch (error: IllegalArgumentException) {
                    throw RevflareOfferingsException.InvalidResponse(error.message ?: "invalid JSON")
                }
                val etag = response.header("ETag") ?: decoded.version.takeIf { it.isNotEmpty() }?.let { "\"$it\"" }
                save(CachedOfferings(etag, clock(), appVersion, response.body), decoded)
                Log.debug { "Offerings: version ${decoded.version}, ${decoded.offerings.size} offering(s)" }
                decoded
            }
            304 -> {
                cached ?: throw RevflareOfferingsException.InvalidResponse("304 without a cached answer")
                save(cached.first.copy(fetchedAt = clock(), appVersion = appVersion), cached.second)
                Log.debug { "Offerings: unchanged (version ${cached.second.version})" }
                cached.second
            }
            404 -> {
                Log.error("Offerings: the Revflare server does not know this SDK key (404). Check Revflare.configure(sdkKey).")
                throw RevflareOfferingsException.UnknownSdkKey()
            }
            else -> throw RevflareOfferingsException.Server(response.status)
        }
    }

    @Synchronized
    private fun loadCache(): Pair<CachedOfferings, OfferingsResponse>? {
        if (!loadedFromDisk) {
            loadedFromDisk = true
            if (cache == null) {
                val entry = CachedOfferings.fromJson(store.string(cacheKey))
                val response = entry?.let { runCatching { OfferingsResponse.parse(it.body) }.getOrNull() }
                if (entry != null && response != null) cache = entry to response
            }
        }
        return cache
    }

    @Synchronized
    private fun save(entry: CachedOfferings, response: OfferingsResponse) {
        cache = entry to response
        loadedFromDisk = true
        store.set(cacheKey, entry.toJson())
    }
}

/** Loads Play products by package product id (`id` or `id:basePlan`); unknown ones are left out. */
internal interface ProductCatalog<P : Any> {
    suspend fun products(specs: Set<String>): Map<String, P>
}

/** Fetches the offerings and resolves their products; loaded products are kept in memory. */
internal class OfferingsService<P : Any>(val fetcher: OfferingsFetcher, private val catalog: ProductCatalog<P>) {
    private val mutex = Mutex()
    private val products = HashMap<String, P>()
    private val reportedMissing = HashSet<String>()

    suspend fun offerings(policy: OfferingsFetchPolicy): OfferingsSnapshot<P> {
        val response = fetcher.offerings(policy)
        return mutex.withLock {
            val needed = response.allProductIds.toSet()
            val missing = needed - products.keys
            if (missing.isNotEmpty()) {
                try {
                    products.putAll(catalog.products(missing))
                } catch (error: Exception) {
                    if (error is kotlinx.coroutines.CancellationException) throw error
                    if (needed.none { it in products }) throw RevflareOfferingsException.ProductsUnavailable(error.toString())
                    Log.debug { "Offerings: some products failed to load: $error" }
                }
            }
            val snapshot = OfferingsSnapshot(response, products)
            val newlyMissing = snapshot.droppedProductIds.filter { it !in reportedMissing }
            if (newlyMissing.isNotEmpty()) {
                reportedMissing.addAll(newlyMissing)
                Log.error(
                    "Offerings: packages left out, Google Play has no product $newlyMissing (check the product ids and " +
                        "base plans in Revflare and the Play Console, and that the app is installed from a Play test track)",
                )
            }
            snapshot
        }
    }
}

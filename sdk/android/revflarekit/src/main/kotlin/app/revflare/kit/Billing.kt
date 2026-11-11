package app.revflare.kit

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ConsumeParams
import com.android.billingclient.api.GetBillingConfigParams
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/** A Play Billing response code and its debug message. */
internal data class BillingResponse(val code: Int, val message: String = "") {
    val isOk: Boolean get() = code == BillingClient.BillingResponseCode.OK

    companion object {
        val OK = BillingResponse(BillingClient.BillingResponseCode.OK)
        fun of(result: BillingResult) = BillingResponse(result.responseCode, result.debugMessage)
    }
}

/** One `onPurchasesUpdated` callback. */
internal data class PurchasesUpdate(val response: BillingResponse, val purchases: List<RevflarePurchase>)

/** Play Billing, reduced to what RevflareKit uses (Play in the app, a fake in tests). */
internal interface BillingBackend : PurchaseSource {
    /** Every `onPurchasesUpdated` callback (purchases made in the app, renewals, pending purchases completing). */
    val updates: SharedFlow<PurchasesUpdate>

    /** Owned purchases (subscriptions and in-app products); null when Play Billing can't answer. Read only. */
    suspend fun queryPurchases(): List<RevflarePurchase>?

    override suspend fun ownedPurchases(): List<RevflarePurchase>? = queryPurchases()

    /** Play products for these product ids (both types); null when Play Billing can't answer. */
    suspend fun queryProductDetails(productIds: Set<String>): List<ProductDetails>?

    suspend fun acknowledge(purchaseToken: String): BillingResponse
    suspend fun consume(purchaseToken: String): BillingResponse

    /** Opens Play's purchase sheet (on the main thread). The result arrives through [updates]. */
    suspend fun launchBillingFlow(activity: Activity, product: ProductDetails, offerToken: String?, accountId: String): BillingResponse

    /** The user's Play billing country (ISO alpha-2), null when unknown. */
    suspend fun billingCountry(): String?
}

/**
 * Play Billing Library 9 client. One per process. Never acknowledges or consumes by itself: only [RevflareStore]
 * calls [acknowledge] / [consume] (attribution-only apps never create a store).
 */
internal class PlayBillingBackend(context: Context) : BillingBackend {
    private val _updates = MutableSharedFlow<PurchasesUpdate>(extraBufferCapacity = 64)
    override val updates: SharedFlow<PurchasesUpdate> = _updates.asSharedFlow()

    private val client: BillingClient = BillingClient.newBuilder(context.applicationContext)
        .setListener { result, purchases ->
            val update = PurchasesUpdate(BillingResponse.of(result), purchases.orEmpty().map { it.toRevflare(null) })
            if (!_updates.tryEmit(update)) Log.debug { "Billing: purchase update dropped (buffer full)" }
        }
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().enablePrepaidPlans().build())
        .enableAutoServiceReconnection()
        .build()

    private val connectMutex = Mutex()

    /** Connects when needed; false when Play Billing is not available. */
    private suspend fun connect(): Boolean = connectMutex.withLock {
        if (client.isReady) return true
        val result = withTimeoutOrNull(15_000) {
            suspendCancellableCoroutine { continuation ->
                client.startConnection(object : BillingClientStateListener {
                    override fun onBillingSetupFinished(result: BillingResult) {
                        if (continuation.isActive) continuation.resume(BillingResponse.of(result))
                    }

                    override fun onBillingServiceDisconnected() {
                        if (continuation.isActive) continuation.resume(BillingResponse(BillingClient.BillingResponseCode.SERVICE_DISCONNECTED))
                    }
                })
            }
        }
        if (result?.isOk != true) Log.debug { "Billing: not connected (${result?.code ?: "timeout"} ${result?.message ?: ""})" }
        result?.isOk == true
    }

    override suspend fun queryPurchases(): List<RevflarePurchase>? {
        if (!connect()) return null
        val all = ArrayList<RevflarePurchase>()
        for (type in listOf(BillingClient.ProductType.SUBS, BillingClient.ProductType.INAPP)) {
            val params = QueryPurchasesParams.newBuilder().setProductType(type).build()
            val (response, purchases) = suspendCancellableCoroutine { continuation ->
                client.queryPurchasesAsync(params) { result, list ->
                    if (continuation.isActive) continuation.resume(BillingResponse.of(result) to list)
                }
            }
            if (!response.isOk) {
                Log.debug { "Billing: queryPurchases($type) failed: ${response.code} ${response.message}" }
                return null
            }
            purchases.mapTo(all) { it.toRevflare(type) }
        }
        return all
    }

    override suspend fun queryProductDetails(productIds: Set<String>): List<ProductDetails>? {
        if (productIds.isEmpty()) return emptyList()
        if (!connect()) return null
        val all = ArrayList<ProductDetails>()
        var answered = false
        for (type in listOf(BillingClient.ProductType.SUBS, BillingClient.ProductType.INAPP)) {
            val params = QueryProductDetailsParams.newBuilder()
                .setProductList(productIds.sorted().map { QueryProductDetailsParams.Product.newBuilder().setProductId(it).setProductType(type).build() })
                .build()
            val (response, details) = suspendCancellableCoroutine { continuation ->
                client.queryProductDetailsAsync(params) { result, queried ->
                    if (continuation.isActive) continuation.resume(BillingResponse.of(result) to queried.productDetailsList)
                }
            }
            if (response.isOk) {
                answered = true
                all.addAll(details)
            } else {
                Log.debug { "Billing: queryProductDetails($type) failed: ${response.code} ${response.message}" }
            }
        }
        return if (answered) all.distinctBy { it.productId } else null
    }

    override suspend fun acknowledge(purchaseToken: String): BillingResponse {
        if (!connect()) return BillingResponse(BillingClient.BillingResponseCode.SERVICE_DISCONNECTED)
        val params = AcknowledgePurchaseParams.newBuilder().setPurchaseToken(purchaseToken).build()
        return suspendCancellableCoroutine { continuation ->
            client.acknowledgePurchase(params) { result -> if (continuation.isActive) continuation.resume(BillingResponse.of(result)) }
        }
    }

    override suspend fun consume(purchaseToken: String): BillingResponse {
        if (!connect()) return BillingResponse(BillingClient.BillingResponseCode.SERVICE_DISCONNECTED)
        val params = ConsumeParams.newBuilder().setPurchaseToken(purchaseToken).build()
        return suspendCancellableCoroutine { continuation ->
            client.consumeAsync(params) { result, _ -> if (continuation.isActive) continuation.resume(BillingResponse.of(result)) }
        }
    }

    override suspend fun launchBillingFlow(activity: Activity, product: ProductDetails, offerToken: String?, accountId: String): BillingResponse {
        if (!connect()) return BillingResponse(BillingClient.BillingResponseCode.SERVICE_DISCONNECTED, "Play Billing is not connected")
        val productParams = BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(product)
        if (offerToken != null) productParams.setOfferToken(offerToken)
        val params = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(productParams.build()))
            .setObfuscatedAccountId(accountId)
            .build()
        return withContext(Dispatchers.Main) { BillingResponse.of(client.launchBillingFlow(activity, params)) }
    }

    override suspend fun billingCountry(): String? {
        if (!connect()) return null
        val result = CompletableDeferred<String?>()
        client.getBillingConfigAsync(GetBillingConfigParams.newBuilder().build()) { response, config ->
            result.complete(if (response.responseCode == BillingClient.BillingResponseCode.OK) config?.countryCode else null)
        }
        return result.await()
    }
}

internal fun Purchase.toRevflare(type: String?): RevflarePurchase {
    val json = RevflareJson.parseOrNull(originalJson)
    // Purchases from onPurchasesUpdated carry no type: subscriptions have "autoRenewing" in their JSON.
    val productType = type ?: if (json?.get("autoRenewing") != null) RevflarePurchase.PRODUCT_TYPE_SUBS else RevflarePurchase.PRODUCT_TYPE_INAPP
    return RevflarePurchase(
        orderId = orderId?.ifEmpty { null },
        purchaseToken = purchaseToken,
        productIds = products,
        productType = productType,
        state = when (purchaseState) {
            Purchase.PurchaseState.PURCHASED -> RevflarePurchase.State.PURCHASED
            Purchase.PurchaseState.PENDING -> RevflarePurchase.State.PENDING
            else -> RevflarePurchase.State.UNSPECIFIED
        },
        isAcknowledged = isAcknowledged,
        isAutoRenewing = isAutoRenewing,
        isSuspended = isSuspended,
        purchaseTime = purchaseTime,
        quantity = quantity,
        obfuscatedAccountId = accountIdentifiers?.obfuscatedAccountId,
        originalJson = originalJson,
        signature = signature,
    )
}

/** Stable error codes for `purchase_failed` / `restore_failed`. */
internal object BillingErrorCodes {
    fun code(responseCode: Int): String = when (responseCode) {
        BillingClient.BillingResponseCode.USER_CANCELED -> "user_cancelled"
        BillingClient.BillingResponseCode.NETWORK_ERROR -> "network_error"
        BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE -> "service_unavailable"
        BillingClient.BillingResponseCode.SERVICE_DISCONNECTED -> "service_disconnected"
        BillingClient.BillingResponseCode.BILLING_UNAVAILABLE -> "billing_unavailable"
        BillingClient.BillingResponseCode.ITEM_UNAVAILABLE -> "item_unavailable"
        BillingClient.BillingResponseCode.DEVELOPER_ERROR -> "developer_error"
        BillingClient.BillingResponseCode.ERROR -> "error"
        BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> "item_already_owned"
        BillingClient.BillingResponseCode.ITEM_NOT_OWNED -> "item_not_owned"
        BillingClient.BillingResponseCode.FEATURE_NOT_SUPPORTED -> "feature_not_supported"
        else -> "billing_$responseCode"
    }
}

/** A Play Billing error from [RevflareStore]. */
public class RevflareBillingException internal constructor(
    /** Play's `BillingResponseCode`. */
    public val responseCode: Int,
    public val debugMessage: String,
) : Exception("Google Play Billing error ${BillingErrorCodes.code(responseCode)} ($responseCode): $debugMessage") {
    /** Stable code (`network_error`, `item_already_owned`...), as sent in `purchase_failed` events. */
    public val code: String get() = BillingErrorCodes.code(responseCode)
}

package app.revflare.kit

import android.app.Activity
import com.android.billingclient.api.ProductDetails
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import java.io.IOException

internal const val INSTALL_ID = "0b6c1f7e-3a52-4c0e-9d4a-1f2e3d4c5b6a"
internal const val SERVER = "https://revflare.example.com"
internal const val SDK_KEY = "rfp_test"

/** Records requests and answers with [handler]. */
internal class FakeTransport(var handler: (HttpRequest) -> HttpResponse = { HttpResponse(200, body = "{\"ok\":true}") }) : Transport {
    val requests = mutableListOf<HttpRequest>()

    override suspend fun send(request: HttpRequest): HttpResponse {
        synchronized(requests) { requests.add(request) }
        return handler(request)
    }

    fun posts(path: String) = synchronized(requests) { requests.filter { it.method == "POST" && it.url.endsWith("/sdk/v1/$path") } }
    fun gets(path: String) = synchronized(requests) { requests.filter { it.method == "GET" && it.url.substringBefore('?').endsWith("/sdk/v1/$path") } }
}

internal fun ok(body: String = "{\"ok\":true}", headers: Map<String, String> = emptyMap()) = HttpResponse(200, headers.mapKeys { it.key.lowercase() }, body)
internal fun status(code: Int, body: String = "", headers: Map<String, String> = emptyMap()) = HttpResponse(code, headers.mapKeys { it.key.lowercase() }, body)
internal fun networkError(): Nothing = throw IOException("offline")

internal class FakeReferrer(var result: ReferrerResult = ReferrerResult.Found(InstallReferrerData("utm_source=google&gclid=abc", 1_700_000_000, 1_700_000_100))) : InstallReferrerSource {
    var reads = 0
    override suspend fun read(): ReferrerResult {
        reads++
        return result
    }
}

internal class FakeDeviceIdentifiers(var value: DeviceIdentifiers = sampleDevice()) : DeviceIdentifierProvider {
    override suspend fun deviceIdentifiers(): DeviceIdentifiers = value
}

internal fun sampleDevice(gaid: String? = "38400000-8cf0-11bd-b23e-10b96e40000d") = DeviceIdentifiers(
    gaid = gaid,
    attStatus = if (gaid == null) TrackingStatus.DENIED else TrackingStatus.AUTHORIZED,
    bundleId = "com.example.app",
    appVersion = "1.2.0",
    appBuild = "42",
    osVersion = "15",
    deviceModel = "Pixel 9",
    locale = "en_US",
    timeZone = "Europe/Istanbul",
    extinfo = MetaExtinfo.build("com.example.app", "42", "1.2.0", "15", "Pixel 9", "en_US", "GMT+03:00", "", 1080, 2400, 2.625, 8, 128, 64, "Europe/Istanbul"),
)

internal fun purchase(
    token: String,
    product: String = "pro_monthly",
    orderId: String? = "GPA.1111-2222-3333-$token",
    type: String = RevflarePurchase.PRODUCT_TYPE_SUBS,
    state: RevflarePurchase.State = RevflarePurchase.State.PURCHASED,
    acknowledged: Boolean = true,
    time: Long = 1_000,
    suspended: Boolean = false,
) = RevflarePurchase(
    orderId = orderId,
    purchaseToken = token,
    productIds = listOf(product),
    productType = type,
    state = state,
    isAcknowledged = acknowledged,
    isAutoRenewing = type == RevflarePurchase.PRODUCT_TYPE_SUBS,
    isSuspended = suspended,
    purchaseTime = time,
)

/** Play Billing in memory: owned purchases, acknowledge / consume calls, and purchase updates. */
internal class FakeBilling : BillingBackend {
    val owned = mutableListOf<RevflarePurchase>()
    val acknowledged = mutableListOf<String>()
    val consumed = mutableListOf<String>()
    var available = true
    var queries = 0
    val flow = MutableSharedFlow<PurchasesUpdate>(extraBufferCapacity = 16)
    override val updates: SharedFlow<PurchasesUpdate> = flow

    override suspend fun queryPurchases(): List<RevflarePurchase>? {
        queries++
        return if (available) synchronized(owned) { owned.toList() } else null
    }

    override suspend fun queryProductDetails(productIds: Set<String>): List<ProductDetails>? = emptyList()

    override suspend fun acknowledge(purchaseToken: String): BillingResponse {
        acknowledged.add(purchaseToken)
        synchronized(owned) {
            owned.replaceAll { if (it.purchaseToken == purchaseToken) it.copy(isAcknowledged = true) else it }
        }
        return BillingResponse.OK
    }

    override suspend fun consume(purchaseToken: String): BillingResponse {
        consumed.add(purchaseToken)
        synchronized(owned) { owned.removeAll { it.purchaseToken == purchaseToken } }
        return BillingResponse.OK
    }

    override suspend fun launchBillingFlow(activity: Activity, product: ProductDetails, offerToken: String?, accountId: String): BillingResponse =
        BillingResponse.OK

    override suspend fun billingCountry(): String? = "TR"
}

internal fun memoryIdentity(store: KeyValueStore = MemoryKeyValueStore()) = InstallIdentity(store, MemoryNoBackupMarker(), makeId = { INSTALL_ID })

internal fun client(transport: Transport, environment: String? = "production") = RevflareClient(SERVER, SDK_KEY, transport) { environment }

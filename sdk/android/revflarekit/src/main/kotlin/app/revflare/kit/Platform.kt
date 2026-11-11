package app.revflare.kit

// Interfaces between the logic (tested on the JVM with fakes) and Android / Google Play.

/** The Play Install Referrer, as RevflareKit reports it (`installReferrer`). Timestamps in seconds, as Play gives them. */
internal data class InstallReferrerData(
    val referrer: String,
    val clickTs: Long,
    val installTs: Long,
) {
    fun toJson(): RevflareJson.Object = RevflareJson.obj(
        "referrer" to RevflareJson.Str(referrer),
        "clickTs" to RevflareJson.num(clickTs),
        "installTs" to RevflareJson.num(installTs),
    )

    companion object {
        fun fromJson(json: RevflareJson?): InstallReferrerData? {
            val referrer = json?.get("referrer")?.stringValue ?: return null
            return InstallReferrerData(referrer, json["clickTs"]?.longValue ?: 0, json["installTs"]?.longValue ?: 0)
        }
    }
}

/** What reading the install referrer gave. */
internal sealed class ReferrerResult {
    data class Found(val data: InstallReferrerData) : ReferrerResult()
    /** The Play Store on this device has no Install Referrer API (or not installed from Play): there never will be one. */
    data object Unavailable : ReferrerResult()
    /** A transient error (service unavailable, disconnected): try again later. */
    data class Error(val message: String) : ReferrerResult()
}

internal interface InstallReferrerSource {
    suspend fun read(): ReferrerResult
}

/**
 * The purchases this install owns (Play Billing `queryPurchasesAsync`, subscriptions and in-app products), read only.
 * Null when Play Billing can't answer right now.
 */
internal interface PurchaseSource {
    suspend fun ownedPurchases(): List<RevflarePurchase>?
}

/** Limit ad tracking state, sent as `attStatus` (the iOS field name; values shared with iOS). */
internal enum class TrackingStatus(val wireValue: String) {
    /** The advertising id is available and the user did not limit ad tracking. */
    AUTHORIZED("authorized"),
    /** The user limited ad tracking / deleted the advertising id. */
    DENIED("denied"),
    /** The app does not include play-services-ads-identifier, or it failed. */
    UNAVAILABLE("unavailable"),
}

/** What this device reports to `POST /sdk/v1/identifiers`, apart from the install id and the Facebook anonymous id. */
internal data class DeviceIdentifiers(
    /** Google advertising id (lowercase UUID), only when available and ad tracking is not limited. */
    val gaid: String?,
    val attStatus: TrackingStatus,
    /** Package name. */
    val bundleId: String,
    /** versionName. */
    val appVersion: String,
    /** versionCode. */
    val appBuild: String,
    val osVersion: String,
    val deviceModel: String,
    /** "en_US". */
    val locale: String,
    val timeZone: String,
    /** Meta's Android extinfo (16 strings, "a2" first). */
    val extinfo: List<String>,
)

internal interface DeviceIdentifierProvider {
    suspend fun deviceIdentifiers(): DeviceIdentifiers
}

/** App and device facts sent with events and config requests. */
internal data class AppContext(
    val appVersion: String,
    val appBuild: String,
    val osVersion: String,
    /** Underscore form, e.g. "en_US". */
    val locale: String,
)

internal object Locales {
    /** "en-US", "en_US@rg=gbzzzz", "zh_CN_#Hans" → "en_US" / "zh_CN". */
    fun identifier(raw: String): String {
        val base = raw.substringBefore('@').replace('-', '_')
        return base.split('_').filter { it.isNotEmpty() && !it.startsWith("#") }.take(2).joinToString("_")
    }

    fun identifier(locale: java.util.Locale): String {
        val language = locale.language.ifEmpty { return "" }
        return if (locale.country.isNullOrEmpty()) language else "${language}_${locale.country}"
    }
}

/** Meta's app events extinfo array for Android ("a2"). */
internal object MetaExtinfo {
    fun build(
        packageName: String,
        versionCode: String,
        versionName: String,
        osVersion: String,
        model: String,
        locale: String,
        timeZoneAbbreviation: String,
        carrier: String,
        screenWidth: Int,
        screenHeight: Int,
        density: Double,
        cpuCores: Int,
        totalDiskGB: Long,
        freeDiskGB: Long,
        timeZoneId: String,
    ): List<String> = listOf(
        "a2",
        packageName,
        versionCode,
        versionName,
        osVersion,
        model,
        locale,
        timeZoneAbbreviation,
        carrier,
        screenWidth.toString(),
        screenHeight.toString(),
        String.format(java.util.Locale.US, "%.2f", density),
        cpuCores.toString(),
        totalDiskGB.toString(),
        freeDiskGB.toString(),
        timeZoneId,
    )
}

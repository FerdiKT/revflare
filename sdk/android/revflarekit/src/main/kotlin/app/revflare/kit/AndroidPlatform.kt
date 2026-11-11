package app.revflare.kit

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.telephony.TelephonyManager
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale
import java.util.TimeZone
import kotlin.coroutines.resume

/** Reads the app's version and the device (no identifiers). */
internal class AndroidAppInfo(private val context: Context) {
    private val packageInfo: PackageInfo? by lazy {
        runCatching {
            if (Build.VERSION.SDK_INT >= 33) {
                context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(context.packageName, 0)
            }
        }.getOrNull()
    }

    val packageName: String get() = context.packageName

    /** versionName. */
    val appVersion: String get() = packageInfo?.versionName ?: ""

    /** versionCode (long version code). */
    val appBuild: String
        get() = packageInfo?.let {
            if (Build.VERSION.SDK_INT >= 28) it.longVersionCode.toString() else @Suppress("DEPRECATION") it.versionCode.toString()
        } ?: ""

    val osVersion: String get() = Build.VERSION.RELEASE ?: ""

    val locale: String get() = Locales.identifier(Locale.getDefault())

    fun appContext(): AppContext = AppContext(appVersion, appBuild, osVersion, locale)
}

/** Play Install Referrer API (one connection, closed after reading). */
internal class PlayInstallReferrerSource(private val context: Context) : InstallReferrerSource {
    override suspend fun read(): ReferrerResult = withContext(Dispatchers.IO) {
        val client = InstallReferrerClient.newBuilder(context.applicationContext).build()
        try {
            val code = withTimeoutOrNull(10_000) {
                suspendCancellableCoroutine<Int> { continuation ->
                    client.startConnection(object : InstallReferrerStateListener {
                        override fun onInstallReferrerSetupFinished(responseCode: Int) {
                            if (continuation.isActive) continuation.resume(responseCode)
                        }

                        override fun onInstallReferrerServiceDisconnected() {
                            if (continuation.isActive) continuation.resume(InstallReferrerClient.InstallReferrerResponse.SERVICE_DISCONNECTED)
                        }
                    })
                }
            } ?: return@withContext ReferrerResult.Error("timeout")
            when (code) {
                InstallReferrerClient.InstallReferrerResponse.OK -> {
                    val details = client.installReferrer
                    ReferrerResult.Found(
                        InstallReferrerData(
                            referrer = details.installReferrer ?: "",
                            clickTs = details.referrerClickTimestampSeconds,
                            installTs = details.installBeginTimestampSeconds,
                        ),
                    )
                }
                InstallReferrerClient.InstallReferrerResponse.FEATURE_NOT_SUPPORTED,
                InstallReferrerClient.InstallReferrerResponse.DEVELOPER_ERROR,
                InstallReferrerClient.InstallReferrerResponse.PERMISSION_ERROR,
                -> ReferrerResult.Unavailable
                else -> ReferrerResult.Error("response $code")
            }
        } catch (error: Exception) {
            ReferrerResult.Error(error.toString())
        } finally {
            runCatching { client.endConnection() }
        }
    }
}

/**
 * Reads the device for Meta matching, only after the app opted in. The Google advertising id needs the app to include
 * `com.google.android.gms:play-services-ads-identifier` (looked up at runtime; RevflareKit does not depend on it).
 */
internal class AndroidDeviceIdentifierProvider(private val context: Context, private val app: AndroidAppInfo) : DeviceIdentifierProvider {
    override suspend fun deviceIdentifiers(): DeviceIdentifiers = withContext(Dispatchers.IO) {
        val (gaid, status) = advertisingId()
        val metrics = context.resources.displayMetrics
        val timeZone = TimeZone.getDefault()
        val (total, free) = diskSpaceGB()
        val locale = app.locale
        DeviceIdentifiers(
            gaid = gaid,
            attStatus = status,
            bundleId = app.packageName,
            appVersion = app.appVersion,
            appBuild = app.appBuild,
            osVersion = app.osVersion,
            deviceModel = Build.MODEL ?: "",
            locale = locale,
            timeZone = timeZone.id,
            extinfo = MetaExtinfo.build(
                packageName = app.packageName,
                versionCode = app.appBuild,
                versionName = app.appVersion,
                osVersion = app.osVersion,
                model = Build.MODEL ?: "",
                locale = locale,
                timeZoneAbbreviation = timeZone.getDisplayName(timeZone.inDaylightTime(java.util.Date()), TimeZone.SHORT, Locale.US),
                carrier = carrier(),
                screenWidth = metrics.widthPixels,
                screenHeight = metrics.heightPixels,
                density = metrics.density.toDouble(),
                cpuCores = Runtime.getRuntime().availableProcessors(),
                totalDiskGB = total,
                freeDiskGB = free,
                timeZoneId = timeZone.id,
            ),
        )
    }

    private fun advertisingId(): Pair<String?, TrackingStatus> {
        val available = runCatching { Class.forName("com.google.android.gms.ads.identifier.AdvertisingIdClient") }.isSuccess
        if (!available) return null to TrackingStatus.UNAVAILABLE
        return try {
            val info = com.google.android.gms.ads.identifier.AdvertisingIdClient.getAdvertisingIdInfo(context)
            val id = info.id?.lowercase()
            if (info.isLimitAdTrackingEnabled || id.isNullOrEmpty() || id == "00000000-0000-0000-0000-000000000000") {
                null to TrackingStatus.DENIED
            } else {
                id to TrackingStatus.AUTHORIZED
            }
        } catch (error: Throwable) {
            Log.debug { "Advertising id unavailable: $error" }
            null to TrackingStatus.UNAVAILABLE
        }
    }

    private fun carrier(): String = runCatching {
        (context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager)?.networkOperatorName ?: ""
    }.getOrDefault("")

    private fun diskSpaceGB(): Pair<Long, Long> = runCatching {
        val stat = StatFs(Environment.getDataDirectory().path)
        val gb = 1024L * 1024 * 1024
        (stat.totalBytes / gb) to (stat.availableBytes / gb)
    }.getOrDefault(0L to 0L)
}

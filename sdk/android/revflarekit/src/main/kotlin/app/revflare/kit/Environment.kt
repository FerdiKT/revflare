package app.revflare.kit

import android.content.Context
import android.content.pm.ApplicationInfo

/**
 * Where this build runs, sent with every RevflareKit request (`environment`) so Revflare can keep test data apart.
 *
 * Revflare excludes `sandbox` and `debug` data from its analytics by default (the web panel's "Include test data"
 * toggle shows it). Test purchases (license testers) are also flagged on the server from Google Play's data.
 */
public enum class RevflareEnvironment(public val wireValue: String) {
    /** Detect it on the device (the default): a debuggable build → [DEBUG], else [PRODUCTION]. */
    AUTOMATIC("automatic"),
    /** A Play Store build used by real customers. */
    PRODUCTION("production"),
    /** Internal / closed testing builds, license testers: pass it explicitly for such builds. */
    SANDBOX("sandbox"),
    /** A debuggable build (run from Android Studio). */
    DEBUG("debug"),
}

internal object EnvironmentDetector {
    fun detect(debuggable: Boolean): RevflareEnvironment =
        if (debuggable) RevflareEnvironment.DEBUG else RevflareEnvironment.PRODUCTION

    /** The override when set, else the detected value. Never [RevflareEnvironment.AUTOMATIC]. */
    fun resolve(override: RevflareEnvironment, debuggable: Boolean): RevflareEnvironment =
        if (override == RevflareEnvironment.AUTOMATIC) detect(debuggable) else override

    fun isDebuggable(context: Context): Boolean =
        (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
}

package app.revflare.kit

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

// Wire format (`GET /sdk/v1/config`)

/** A running A/B experiment this device is enrolled in (set up in Revflare web → the app → Experiments). */
public data class RevflareExperiment(
    /** The experiment's id, e.g. `exp_paywall1`. */
    val id: String,
    /** The variant this device was assigned, e.g. `a`, `b`. */
    val variant: String,
    /** The remote config parameters the experiment changes. */
    val keys: List<String>,
)

/** The values the server resolved for this device. */
internal data class RemoteConfigResponse(
    val version: String,
    val values: Map<String, RevflareJson>,
    val conditions: List<String> = emptyList(),
    val country: String? = null,
    val experiments: List<RevflareExperiment> = emptyList(),
) {
    companion object {
        fun parse(body: String): RemoteConfigResponse {
            val json = RevflareJson.parse(body) as? RevflareJson.Object ?: throw IllegalArgumentException("not an object")
            val values = json["values"]
            if (values != null && values !is RevflareJson.Object && values != RevflareJson.Null) {
                throw IllegalArgumentException("values is not an object")
            }
            return RemoteConfigResponse(
                version = json["version"]?.stringValue ?: "",
                values = values?.objectValue.orEmpty(),
                conditions = json["conditions"]?.arrayValue?.mapNotNull { it.stringValue }.orEmpty(),
                country = json["country"]?.stringValue?.ifEmpty { null },
                // Lenient: a malformed entry is skipped.
                experiments = json["experiments"]?.arrayValue.orEmpty().mapNotNull { entry ->
                    val id = entry["id"]?.stringValue?.ifEmpty { null } ?: return@mapNotNull null
                    val variant = entry["variant"]?.stringValue?.ifEmpty { null } ?: return@mapNotNull null
                    RevflareExperiment(id, variant, entry["keys"]?.arrayValue?.mapNotNull { it.stringValue }.orEmpty())
                },
            )
        }

        fun parseOrNull(body: String): RemoteConfigResponse? = try {
            parse(body)
        } catch (_: IllegalArgumentException) {
            null
        }
    }
}

/** What a config request says about the device (no identifiers apart from the random install id). */
internal data class RemoteConfigContext(
    val installId: String,
    val appVersion: String,
    val appBuild: String,
    val osVersion: String,
    /** Underscore form, e.g. "zh_CN". */
    val locale: String,
    /** Google Play billing country, ISO alpha-2 ("CN"), null when unknown. */
    val storefront: String? = null,
    val attribution: RevflareAttribution = RevflareAttribution.UNKNOWN,
    /** [Revflare.environment]; null leaves it out (tests). */
    val environment: String? = null,
) {
    /** Identifies what the server may target (not the install id): when it changes, cached values may be stale. */
    val fingerprint: String
        get() = sha256Hex(
            listOf(
                appVersion, appBuild, osVersion, locale, storefront ?: "", attribution.rawSource,
                attribution.campaignId ?: "", attribution.adGroupId ?: "", attribution.keywordId ?: "", environment ?: "",
            ).joinToString("\u001F"),
        ).take(32)

    /** The query of `GET /sdk/v1/config`, in a stable order. */
    val queryItems: List<Pair<String, String>>
        get() {
            val items = mutableListOf(
                "installId" to installId,
                "appVersion" to appVersion,
                "appBuild" to appBuild,
                "osVersion" to osVersion,
                "locale" to locale,
            )
            storefront?.takeIf { it.isNotEmpty() }?.let { items.add("storefront" to it) }
            items.add("source" to attribution.rawSource)
            attribution.campaignId?.let { items.add("campaign" to it) }
            attribution.adGroupId?.let { items.add("adGroup" to it) }
            attribution.keywordId?.let { items.add("keyword" to it) }
            environment?.let { items.add("environment" to it) }
            items.add("sdk" to Revflare.VERSION)
            return items
        }
}

internal interface RemoteConfigContextProvider {
    suspend fun context(): RemoteConfigContext
}

/**
 * Lets the first remote config fetch of a new install wait for the first attribution report (at most 3 s), so a
 * known source can already pick the values. Existing installs never wait.
 */
internal class AttributionGate(open: Boolean) {
    companion object {
        const val DEFAULT_TIMEOUT_MS = 3000L
    }

    private val opened = CompletableDeferred<Unit>().also { if (open) it.complete(Unit) }

    val isOpen: Boolean get() = opened.isCompleted

    fun open() {
        opened.complete(Unit)
    }

    /** Returns once open, or after the timeout (then the gate opens: later fetches don't wait again). */
    suspend fun await(timeoutMs: Long = DEFAULT_TIMEOUT_MS) {
        if (isOpen) return
        if (withTimeoutOrNull(timeoutMs) { opened.await() } == null) {
            Log.debug { "Remote config: no attribution answer within ${timeoutMs / 1000} s; fetching with source=unknown" }
            open()
        }
    }
}

/** Reads the app, the OS, the locale, Play's billing country, the attribution and the environment. */
internal class SystemRemoteConfigContextProvider(
    private val identity: InstallIdentity,
    private val appContext: () -> AppContext,
    private val gate: AttributionGate?,
    private val storefront: suspend () -> String?,
    private val attribution: () -> RevflareAttribution,
    private val environment: () -> String?,
) : RemoteConfigContextProvider {
    companion object {
        const val STOREFRONT_TIMEOUT_MS = 1500L
    }

    override suspend fun context(): RemoteConfigContext {
        gate?.await()
        val country = withTimeoutOrNull(STOREFRONT_TIMEOUT_MS) { runCatching { storefront() }.getOrNull() }
        val app = appContext()
        return RemoteConfigContext(
            installId = identity.resolve(),
            appVersion = app.appVersion,
            appBuild = app.appBuild,
            osVersion = app.osVersion,
            locale = app.locale,
            storefront = country?.trim()?.uppercase()?.takeIf { it.length == 2 && it.all { c -> c in 'A'..'Z' } },
            attribution = attribution(),
            environment = environment(),
        )
    }
}

// Cache

/** One answer of the server, as kept on the device. */
internal data class CachedRemoteConfig(
    val etag: String?,
    /** When the server last sent or confirmed (304) this answer. */
    val fetchedAt: Long,
    /** [RemoteConfigContext.fingerprint] of the request. */
    val context: String,
    /** The raw JSON body. */
    val body: String,
) {
    fun toJson(): RevflareJson.Object = RevflareJson.obj(
        "etag" to RevflareJson.str(etag),
        "fetchedAt" to RevflareJson.num(fetchedAt),
        "context" to RevflareJson.Str(context),
        "body" to RevflareJson.Str(body),
    )

    companion object {
        fun fromJson(json: RevflareJson?): CachedRemoteConfig? {
            json ?: return null
            return CachedRemoteConfig(
                etag = json["etag"]?.stringValue,
                fetchedAt = json["fetchedAt"]?.longValue ?: return null,
                context = json["context"]?.stringValue ?: return null,
                body = json["body"]?.stringValue ?: return null,
            )
        }
    }
}

/** The active values and, after a fetch without activate, the fetched ones. */
internal data class RemoteConfigState(val active: CachedRemoteConfig? = null, val pending: CachedRemoteConfig? = null) {
    /** The newest answer (the one to revalidate). */
    val newest: CachedRemoteConfig? get() = pending ?: active
}

internal class RemoteConfigStorage(private val store: KeyValueStore) {
    companion object {
        /** The cache key of the last configure, so the values are available on first access. */
        const val SCOPE_KEY = "app.revflare.kit.remoteConfig.scope"

        fun cacheKey(server: String, sdkKey: String): String =
            "app.revflare.kit.remoteConfig." + sha256Hex("$server\n$sdkKey").take(24)
    }

    val lastScope: String? get() = store.string(SCOPE_KEY)

    fun rememberScope(key: String) {
        if (store.string(SCOPE_KEY) != key) store.set(SCOPE_KEY, key)
    }

    fun load(key: String): RemoteConfigState {
        val json = store.string(key)?.let { RevflareJson.parseOrNull(it) } ?: return RemoteConfigState()
        return RemoteConfigState(CachedRemoteConfig.fromJson(json["active"]), CachedRemoteConfig.fromJson(json["pending"]))
    }

    fun save(state: RemoteConfigState, key: String) {
        store.set(key, RevflareJson.obj("active" to state.active?.toJson(), "pending" to state.pending?.toJson()).toJsonString())
    }
}

// Fetching

internal sealed class RemoteConfigFetchOutcome {
    /** 200: new values (not active yet). */
    data class Fetched(val entry: CachedRemoteConfig, val response: RemoteConfigResponse) : RemoteConfigFetchOutcome()
    /** 304: the cached answer is still current. */
    data object NotModified : RemoteConfigFetchOutcome()
    /** 429: the server asks to slow down. */
    data object Throttled : RemoteConfigFetchOutcome()
    /** Network error, 5xx, 404 (unknown SDK key), unreadable answer. */
    data class Failed(val message: String) : RemoteConfigFetchOutcome()
}

/** Sends `GET /sdk/v1/config`. */
internal class RemoteConfigFetcher(
    val client: RevflareClient,
    private val contextProvider: RemoteConfigContextProvider,
    private val clock: Clock,
) {
    val cacheKey: String get() = RemoteConfigStorage.cacheKey(client.server, client.sdkKey)

    suspend fun context(): RemoteConfigContext = contextProvider.context()

    suspend fun fetch(context: RemoteConfigContext, etag: String?): RemoteConfigFetchOutcome {
        val request = client.getRequest(client.url(RevflareClient.Path.CONFIG, context.queryItems), etag)
        val response = try {
            client.transport.send(request)
        } catch (error: Exception) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            return RemoteConfigFetchOutcome.Failed("network: $error")
        }
        return when (response.status) {
            in 200..299 -> {
                val decoded = try {
                    RemoteConfigResponse.parse(response.body)
                } catch (error: IllegalArgumentException) {
                    return RemoteConfigFetchOutcome.Failed("unreadable answer: ${error.message}")
                }
                val newEtag = response.header("ETag") ?: decoded.version.takeIf { it.isNotEmpty() }?.let { "\"$it\"" }
                RemoteConfigFetchOutcome.Fetched(CachedRemoteConfig(newEtag, clock(), context.fingerprint, response.body), decoded)
            }
            304 -> if (etag == null) RemoteConfigFetchOutcome.Failed("304 without a cached answer") else RemoteConfigFetchOutcome.NotModified
            429 -> RemoteConfigFetchOutcome.Throttled
            404 -> {
                Log.error("Remote config: the Revflare server does not know this SDK key (404). Check Revflare.configure(sdkKey).")
                RemoteConfigFetchOutcome.Failed("HTTP 404")
            }
            else -> RemoteConfigFetchOutcome.Failed("HTTP ${response.status}")
        }
    }
}

/** Remembers which (experiment, variant) exposures this install already recorded, so each is tracked once. */
internal class ExperimentExposureStore(private val store: KeyValueStore) {
    companion object {
        const val KEY = "app.revflare.kit.experiments.exposed"
        const val MAX_ENTRIES = 500

        fun entry(experiment: String, variant: String) = "$experiment\u001F$variant"
    }

    private val entries: ArrayList<String> =
        ArrayList(store.string(KEY)?.let { RevflareJson.parseOrNull(it) }?.arrayValue?.mapNotNull { it.stringValue }.orEmpty())
    private val lookup = HashSet(entries)

    @Synchronized
    fun contains(experiment: String, variant: String): Boolean = entry(experiment, variant) in lookup

    /** Records the exposure; false when it was already recorded. */
    @Synchronized
    fun insert(experiment: String, variant: String): Boolean {
        val entry = entry(experiment, variant)
        if (!lookup.add(entry)) return false
        entries.add(entry)
        while (entries.size > MAX_ENTRIES) lookup.remove(entries.removeAt(0))
        store.set(KEY, RevflareJson.strings(entries).toJsonString())
        return true
    }
}

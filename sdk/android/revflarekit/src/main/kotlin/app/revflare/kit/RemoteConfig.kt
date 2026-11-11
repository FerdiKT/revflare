package app.revflare.kit

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withTimeoutOrNull

/** What came of the last fetch in this run of the app. */
public enum class RemoteConfigFetchStatus {
    /** No fetch finished yet in this run. */
    NEVER,
    /** The server answered (new values, or 304: unchanged). */
    SUCCESS,
    /** The server could not be reached or answered with an error; cached values or defaults stay in use. */
    FAILURE,
    /** The server asked to slow down (HTTP 429); cached values or defaults stay in use. */
    THROTTLED,
}

/** Where a value comes from. */
public enum class RemoteConfigValueSource {
    /** The server (active values). */
    REMOTE,
    /** [RevflareRemoteConfig.setDefaults]. */
    DEFAULT,
    /** Neither: the getter's `default` argument. */
    STATIC,
}

/** Observable state of the remote config ([RevflareRemoteConfig.info]). */
public data class RemoteConfigInfo(
    /** True once values can be relied on for this launch: cached values were applied, or the first fetch finished. */
    val isLoaded: Boolean = false,
    val lastFetchStatus: RemoteConfigFetchStatus = RemoteConfigFetchStatus.NEVER,
    /** When the server last sent or confirmed the values (ms, kept across launches). */
    val lastFetchTime: Long? = null,
    /** The version of the active values, null when none are active. */
    val version: String? = null,
    /** Names of the conditions that matched for the active values. */
    val conditions: List<String> = emptyList(),
    /** The country the server resolved the active values for (ISO alpha-2), null when unknown. */
    val country: String? = null,
    /** The running A/B experiments this device is enrolled in. */
    val experiments: List<RevflareExperiment> = emptyList(),
    /** The install's acquisition source as RevflareKit knows it now, sent with config requests. */
    val attribution: RevflareAttribution = RevflareAttribution.UNKNOWN,
)

/**
 * Remote config: parameters set in Revflare (web → the app → Remote config), with values the server picks for this
 * device by ordered conditions (country, app version, language, percentage rollout, acquisition source...). Replaces
 * Firebase Remote Config. Use the one instance, [Revflare.remoteConfig]:
 *
 * ```kotlin
 * Revflare.remoteConfig.setDefaults(mapOf("onboarding_version" to "v1", "max_free_accounts" to 1))
 * Revflare.configure(context, sdkKey = "rfp_…", server = "https://revflare.example.com")
 * Revflare.remoteConfig.string("onboarding_version")   // "v2" when a condition matched, else the default
 * ```
 *
 * - The last activated values are kept on the device and applied at once on the next launch (before any request).
 * - [Revflare.configure] fetches and activates in the background ([autoFetch]); the app refetches when it comes to the
 *   foreground and the values are older than [minimumFetchIntervalMs].
 * - Getters never fail: remote value → [setDefaults] value → the `default` argument. Thread-safe.
 * - When the acquisition source becomes known later, RevflareKit refetches into the fetched-not-active slot: values in
 *   use never change by themselves; they apply on the next [activate] / [fetchAndActivate], foreground or launch.
 */
public class RevflareRemoteConfig internal constructor(
    private val clock: Clock = systemClock,
    private val analyticsEnabled: () -> Boolean = { Revflare.analyticsEnabled },
    private val trackEvent: (String, Map<String, String>) -> Unit = { name, props -> Revflare.track(name, props) },
) {
    internal companion object {
        const val EXPOSURE_EVENT = "experiment_exposure"
    }

    /**
     * Fetch and activate automatically: at [Revflare.configure] and on foreground (when older than
     * [minimumFetchIntervalMs]). Default true. Set it to false **before** `configure` to fetch and activate only when
     * the app calls [fetch] / [activate] / [fetchAndActivate].
     */
    @Volatile
    public var autoFetch: Boolean = true

    /** Foreground refetches happen only when the values are older than this (default 1 hour). */
    @Volatile
    public var minimumFetchIntervalMs: Long = 3600_000L

    private val lock = Any()
    private val _info = MutableStateFlow(RemoteConfigInfo())

    /** Observable state: loaded flag, last fetch, version, conditions, experiments, attribution. */
    public val info: StateFlow<RemoteConfigInfo> = _info.asStateFlow()

    private var remoteValues: Map<String, RevflareJson> = emptyMap()
    private var defaultValues: Map<String, RevflareJson> = emptyMap()
    private var experimentsByKey: Map<String, List<RevflareExperiment>> = emptyMap()
    private var storage: RemoteConfigStorage? = null
    private var exposures: ExperimentExposureStore? = null
    private var scope: String? = null
    private var state = RemoteConfigState()
    private var fetcher: RemoteConfigFetcher? = null
    private var coroutineScope: CoroutineScope? = null
    private var inFlight: Deferred<RemoteConfigFetchStatus>? = null

    // Defaults

    /**
     * In-app default values, used for parameters the server did not send (or before any fetch). Replaces the previous
     * defaults. Values: `String`, numbers, `Boolean`, `Map<String, *>`, `List<*>`, [RevflareJson]; others are ignored.
     */
    public fun setDefaults(defaults: Map<String, Any?>) {
        val values = LinkedHashMap<String, RevflareJson>()
        for ((key, value) in defaults) {
            val json = RevflareJson.from(value)
            if (json != null) values[key] = json else Log.error("Remote config: default for \"$key\" ignored (unsupported type ${value?.javaClass?.name})")
        }
        synchronized(lock) { defaultValues = values }
    }

    // Values

    /** The value as a string: strings as they are, numbers ("1", "2.5"), booleans, JSON values as compact JSON text. */
    public fun string(key: String, default: String = ""): String = resolve(key, RemoteConfigValue::string) ?: default

    /** The value as a boolean: booleans; numbers (non-zero = true); "true"/"yes"/"on"/"1" and "false"/"no"/"off"/"0". */
    public fun bool(key: String, default: Boolean = false): Boolean = resolve(key, RemoteConfigValue::bool) ?: default

    /** The value as a long (numbers are truncated; numeric strings are parsed; booleans give 1 / 0). */
    public fun long(key: String, default: Long = 0): Long = resolve(key, RemoteConfigValue::long) ?: default

    /** The value as an int (see [long]). */
    public fun int(key: String, default: Int = 0): Int =
        resolve(key) { RemoteConfigValue.long(it)?.takeIf { v -> v in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt() } ?: default

    /** The value as a double (numeric strings are parsed; booleans give 1 / 0). */
    public fun double(key: String, default: Double = 0.0): Double = resolve(key, RemoteConfigValue::double) ?: default

    /** The raw JSON value (remote, else the default; a string holding JSON is parsed), null when neither exists. */
    public fun json(key: String): RevflareJson? = resolve(key, RemoteConfigValue::json)

    /** The raw JSON value: `Revflare.remoteConfig["paywall"]?.get("title")?.stringValue`. */
    public operator fun get(key: String): RevflareJson? = resolve(key) { it }

    /** Where the value of `key` comes from. */
    public fun source(key: String): RemoteConfigValueSource = synchronized(lock) {
        when {
            remoteValues[key]?.isNull == false -> RemoteConfigValueSource.REMOTE
            defaultValues[key]?.isNull == false -> RemoteConfigValueSource.DEFAULT
            else -> RemoteConfigValueSource.STATIC
        }
    }

    /** Every key that has a remote or default value, sorted. */
    public val allKeys: List<String> get() = synchronized(lock) { (remoteValues.keys + defaultValues.keys).sorted() }

    // Experiments

    /** The enrolled experiments (also in [info]). */
    public val experiments: List<RevflareExperiment> get() = _info.value.experiments

    /** The enrolled experiment with this id, null when the device is not in it. */
    public fun experiment(id: String): RevflareExperiment? = experiments.firstOrNull { it.id == id }

    /** This device's variant in the experiment; reading it records no exposure (see [trackExposure]). */
    public fun variant(experimentId: String): String? = experiment(experimentId)?.variant

    /**
     * Records that the user saw the experiment's variant (`experiment_exposure`, once per install, experiment and
     * variant), for apps that branch on [variant]. Reading a parameter of the experiment does this already.
     * Returns false when the device is not enrolled.
     */
    public fun trackExposure(experimentId: String): Boolean {
        val experiment = experiment(experimentId) ?: run {
            Log.debug { "Remote config: not enrolled in experiment $experimentId, no exposure" }
            return false
        }
        expose(experiment)
        return true
    }

    private fun expose(experiment: RevflareExperiment) {
        val store = exposures
        if (store != null && store.contains(experiment.id, experiment.variant)) return
        // Not remembered while analytics is off, so it is recorded once the user opts in.
        if (!analyticsEnabled()) return
        if (store != null && !store.insert(experiment.id, experiment.variant)) return
        trackEvent(EXPOSURE_EVENT, mapOf("experiment" to experiment.id, "variant" to "${experiment.id}:${experiment.variant}"))
        Log.debug { "Remote config: exposure to ${experiment.id}, variant ${experiment.variant}" }
    }

    /** The remote value when it converts, else the default; reading an experiment's key is an exposure (any source). */
    private fun <T> resolve(key: String, convert: (RevflareJson) -> T?): T? {
        val (remote, fallback, enrolled) = synchronized(lock) { Triple(remoteValues[key], defaultValues[key], experimentsByKey[key]) }
        enrolled?.forEach(::expose)
        if (remote != null && !remote.isNull) convert(remote)?.let { return it }
        if (fallback != null && !fallback.isNull) convert(fallback)?.let { return it }
        return null
    }

    // Fetching

    /**
     * Fetches the values for this device and activates them. Never throws: on failure the cached values or defaults
     * stay in use. Joins a fetch already running. When the server answers after `timeoutMs`, the values are still
     * activated when they arrive (observe [info]).
     *
     * @return true when the server answered in time and its values are active (also when unchanged).
     */
    public suspend fun fetchAndActivate(timeoutMs: Long = 3000): Boolean {
        val deferred = startFetch(activating = true, context = null) ?: return false
        val status = withTimeoutOrNull(timeoutMs) { deferred.await() }
        if (status == null) {
            Log.debug { "Remote config: no answer within $timeoutMs ms; using the cached values or defaults" }
            return false
        }
        return status == RemoteConfigFetchStatus.SUCCESS
    }

    /** Fetches the values without applying them: call [activate] when the app is ready for them. */
    public suspend fun fetch(): RemoteConfigFetchStatus =
        startFetch(activating = false, context = null)?.await() ?: RemoteConfigFetchStatus.FAILURE

    /** Applies the values fetched by [fetch] (also in an earlier run). Returns true when new values were applied. */
    public fun activate(): Boolean = synchronized(lock) {
        val pending = state.pending ?: return false
        state = state.copy(pending = null)
        val response = RemoteConfigResponse.parseOrNull(pending.body)
        if (response == null) {
            save()
            return false
        }
        state = state.copy(active = pending)
        save()
        apply(response)
        _info.update { it.copy(isLoaded = true) }
        Log.debug { "Remote config: activated version ${response.version}, conditions ${response.conditions}" }
        true
    }

    // Internal

    /** Loads the last configured server's cached values (before configure finishes). */
    internal fun attach(store: KeyValueStore) {
        synchronized(lock) {
            if (storage != null) return
            val created = RemoteConfigStorage(store)
            storage = created
            exposures = ExperimentExposureStore(store)
            ReporterState.load(store)?.let { saved -> _info.update { it.copy(attribution = saved.publicAttribution) } }
            created.lastScope?.let { load(it) }
        }
    }

    /** Called by [Revflare.configure]. */
    internal fun start(fetcher: RemoteConfigFetcher, scope: CoroutineScope) {
        synchronized(lock) {
            if (this.fetcher != null) return
            this.fetcher = fetcher
            coroutineScope = scope
            if (this.scope != fetcher.cacheKey) load(fetcher.cacheKey)
            storage?.rememberScope(fetcher.cacheKey)
        }
        if (autoFetch) startFetch(activating = true, context = null)
    }

    /** Refetches (and activates) when the values are older than [minimumFetchIntervalMs] or the context changed. */
    internal suspend fun foregroundRefresh() {
        val fetcher = synchronized(lock) { if (!autoFetch || inFlight != null) null else fetcher } ?: return
        val context = fetcher.context()
        if (!isDue(context)) {
            // Values fetched in the background (e.g. after the attribution resolved) apply now, between screens.
            if (synchronized(lock) { state.pending?.context == context.fingerprint }) activate()
            return
        }
        startFetch(activating = true, context = context)?.await()
    }

    /** Refetches for the new attribution into the pending slot (values in use stay until activated). */
    internal suspend fun attributionChanged(attribution: RevflareAttribution) {
        _info.update { it.copy(attribution = attribution) }
        val fetcher = synchronized(lock) { fetcher } ?: return
        synchronized(lock) { inFlight }?.await()
        val context = fetcher.context()
        if (synchronized(lock) { state.newest?.context } == context.fingerprint) return
        Log.debug { "Remote config: attribution is now ${attribution.rawSource}; fetching for it" }
        startFetch(activating = false, context = context)?.await()
    }

    internal fun isDue(context: RemoteConfigContext): Boolean = synchronized(lock) {
        val newest = state.newest ?: return true
        if (newest.context != context.fingerprint) return true
        clock() - newest.fetchedAt >= minimumFetchIntervalMs
    }

    internal val storedState: RemoteConfigState get() = synchronized(lock) { state }

    /** Starts a fetch, or joins the running one (activating its result when asked). Null before configure. */
    private fun startFetch(activating: Boolean, context: RemoteConfigContext?): Deferred<RemoteConfigFetchStatus>? {
        val deferred: Deferred<RemoteConfigFetchStatus>
        synchronized(lock) {
            if (fetcher == null) {
                Log.error("Remote config: call Revflare.configure before fetching")
                return null
            }
            val scope = coroutineScope!!
            inFlight?.let { running ->
                if (!activating) return running
                return scope.async {
                    val status = running.await()
                    activate()
                    status
                }
            }
            // Lazy: started once registered as the running fetch (its end clears it).
            deferred = scope.async(start = kotlinx.coroutines.CoroutineStart.LAZY) { performFetch(activating, context) }
            inFlight = deferred
        }
        deferred.start()
        return deferred
    }

    private suspend fun performFetch(activating: Boolean, known: RemoteConfigContext?): RemoteConfigFetchStatus {
        try {
            val fetcher = synchronized(lock) { fetcher } ?: return RemoteConfigFetchStatus.FAILURE
            val context = known ?: fetcher.context()
            val newest = synchronized(lock) { state.newest }
            // A different context may resolve to other values: don't let a 304 confirm the old ones.
            val etag = if (newest?.context == context.fingerprint) newest.etag else null
            val outcome = fetcher.fetch(context, etag)
            val status: RemoteConfigFetchStatus
            synchronized(lock) {
                when (outcome) {
                    is RemoteConfigFetchOutcome.Fetched -> {
                        state = state.copy(pending = outcome.entry)
                        save()
                        _info.update { it.copy(lastFetchTime = outcome.entry.fetchedAt) }
                        status = RemoteConfigFetchStatus.SUCCESS
                        Log.debug { "Remote config: fetched version ${outcome.response.version} (${outcome.response.values.size} value(s))" }
                    }
                    RemoteConfigFetchOutcome.NotModified -> {
                        val now = clock()
                        state = if (state.pending != null) {
                            state.copy(pending = state.pending?.copy(fetchedAt = now))
                        } else {
                            state.copy(active = state.active?.copy(fetchedAt = now))
                        }
                        save()
                        _info.update { it.copy(lastFetchTime = now) }
                        status = RemoteConfigFetchStatus.SUCCESS
                        Log.debug { "Remote config: unchanged" }
                    }
                    RemoteConfigFetchOutcome.Throttled -> {
                        status = RemoteConfigFetchStatus.THROTTLED
                        Log.debug { "Remote config: throttled by the server (429); keeping the current values" }
                    }
                    is RemoteConfigFetchOutcome.Failed -> {
                        status = RemoteConfigFetchStatus.FAILURE
                        Log.debug { "Remote config: fetch failed (${outcome.message}); keeping the current values" }
                    }
                }
            }
            if (activating) activate()
            _info.update { it.copy(lastFetchStatus = status, isLoaded = true) }
            return status
        } finally {
            synchronized(lock) { inFlight = null }
        }
    }

    /** Call with the lock held. */
    private fun load(key: String) {
        scope = key
        state = storage?.load(key) ?: RemoteConfigState()
        val response = state.active?.let { RemoteConfigResponse.parseOrNull(it.body) }
        if (response != null) {
            apply(response)
            _info.update { it.copy(isLoaded = true) }
        } else {
            state = state.copy(active = null)
            apply(null)
            _info.update { it.copy(isLoaded = false) }
        }
        _info.update { it.copy(lastFetchTime = state.newest?.fetchedAt) }
    }

    /** Call with the lock held. */
    private fun apply(response: RemoteConfigResponse?) {
        remoteValues = response?.values.orEmpty()
        val enrolled = response?.experiments.orEmpty()
        val byKey = HashMap<String, MutableList<RevflareExperiment>>()
        for (experiment in enrolled) for (key in experiment.keys.toSet()) byKey.getOrPut(key) { ArrayList() }.add(experiment)
        experimentsByKey = byKey
        _info.update {
            it.copy(version = response?.version, conditions = response?.conditions.orEmpty(), country = response?.country, experiments = enrolled)
        }
    }

    private fun save() {
        val key = scope ?: return
        storage?.save(state, key)
    }

}

/** Converts values between the types apps ask for. */
internal object RemoteConfigValue {
    fun string(value: RevflareJson): String? = when (value) {
        RevflareJson.Null -> null
        is RevflareJson.Str -> value.value
        is RevflareJson.Bool -> if (value.value) "true" else "false"
        is RevflareJson.Number -> formatNumber(value.value)
        is RevflareJson.Array, is RevflareJson.Object -> value.toJsonString()
    }

    fun bool(value: RevflareJson): Boolean? = when (value) {
        is RevflareJson.Bool -> value.value
        is RevflareJson.Number -> value.value != 0.0
        is RevflareJson.Str -> when (value.value.trim().lowercase()) {
            "true", "yes", "on", "1", "y" -> true
            "false", "no", "off", "0", "n", "" -> false
            else -> null
        }
        else -> null
    }

    fun double(value: RevflareJson): Double? = when (value) {
        is RevflareJson.Number -> value.value
        is RevflareJson.Bool -> if (value.value) 1.0 else 0.0
        is RevflareJson.Str -> value.value.trim().toDoubleOrNull()?.takeIf { it.isFinite() }
        else -> null
    }

    fun long(value: RevflareJson): Long? {
        if (value is RevflareJson.Str) value.value.trim().toLongOrNull()?.let { return it }
        val number = double(value) ?: return null
        if (!number.isFinite() || Math.abs(number) >= 9.0e18) return null
        return number.toLong()
    }

    /** The value, or the JSON a string holds (Firebase JSON parameters, string defaults). */
    fun json(value: RevflareJson): RevflareJson? {
        if (value is RevflareJson.Str) {
            val parsed = RevflareJson.parseOrNull(value.value)
            if (parsed is RevflareJson.Object || parsed is RevflareJson.Array) return parsed
        }
        return value
    }
}

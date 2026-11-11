package app.revflare.kit

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Everything the reporter remembers between launches (one JSON blob in SharedPreferences). */
internal data class ReporterState(
    /** The server the state belongs to: pointing an app at another server starts over. */
    val server: String? = null,
    /** The server accepted a first report for this install. */
    val registered: Boolean = false,
    /** First attempt: the first launch with RevflareKit (sent as `installedAt`, ms). */
    val firstAttemptAt: Long? = null,
    val failures: Int = 0,
    val nextAttemptAt: Long? = null,
    /** `waiting` (not read yet), `read`, `unavailable`. */
    val referrerStatus: String = REFERRER_WAITING,
    val referrer: InstallReferrerData? = null,
    /** The server accepted a report carrying [referrer]. */
    val referrerAccepted: Boolean = false,
    val referrerFailures: Int = 0,
    val referrerNextAttemptAt: Long? = null,
    /** Purchase tokens the server has accepted for this install. */
    val reportedTokens: Set<String> = emptySet(),
    /** Fingerprint of the last device identifiers the server accepted. */
    val identifiersFingerprint: String? = null,
    /** The server's `attribution` field (`pending`, `resolved`...). */
    val attribution: String? = null,
    /** What the server resolved: `google_ads`, `referral`, `organic`, `unknown`... */
    val source: String? = null,
    val campaignId: String? = null,
    val adGroupId: String? = null,
    val keywordId: String? = null,
    val pollCount: Int = 0,
    /** When to ask the server again; null when there is nothing more to learn. */
    val nextPollAt: Long? = null,
) {
    val publicAttribution: RevflareAttribution
        get() = RevflareAttribution.of(source, campaignId, adGroupId, keywordId)

    fun toJson(): RevflareJson.Object = RevflareJson.obj(
        "server" to RevflareJson.str(server),
        "registered" to RevflareJson.Bool(registered),
        "firstAttemptAt" to RevflareJson.num(firstAttemptAt),
        "failures" to RevflareJson.num(failures.toLong()),
        "nextAttemptAt" to RevflareJson.num(nextAttemptAt),
        "referrerStatus" to RevflareJson.Str(referrerStatus),
        "referrer" to referrer?.toJson(),
        "referrerAccepted" to RevflareJson.Bool(referrerAccepted),
        "referrerFailures" to RevflareJson.num(referrerFailures.toLong()),
        "referrerNextAttemptAt" to RevflareJson.num(referrerNextAttemptAt),
        "reportedTokens" to RevflareJson.strings(reportedTokens.sorted()),
        "identifiersFingerprint" to RevflareJson.str(identifiersFingerprint),
        "attribution" to RevflareJson.str(attribution),
        "source" to RevflareJson.str(source),
        "campaignId" to RevflareJson.str(campaignId),
        "adGroupId" to RevflareJson.str(adGroupId),
        "keywordId" to RevflareJson.str(keywordId),
        "pollCount" to RevflareJson.num(pollCount.toLong()),
        "nextPollAt" to RevflareJson.num(nextPollAt),
    )

    companion object {
        const val REFERRER_WAITING = "waiting"
        const val REFERRER_READ = "read"
        const val REFERRER_UNAVAILABLE = "unavailable"

        fun fromJson(text: String?): ReporterState? {
            val json = text?.let { RevflareJson.parseOrNull(it) } as? RevflareJson.Object ?: return null
            return ReporterState(
                server = json["server"]?.stringValue,
                registered = json["registered"]?.boolValue ?: false,
                firstAttemptAt = json["firstAttemptAt"]?.longValue,
                failures = json["failures"]?.intValue ?: 0,
                nextAttemptAt = json["nextAttemptAt"]?.longValue,
                referrerStatus = json["referrerStatus"]?.stringValue ?: REFERRER_WAITING,
                referrer = InstallReferrerData.fromJson(json["referrer"]),
                referrerAccepted = json["referrerAccepted"]?.boolValue ?: false,
                referrerFailures = json["referrerFailures"]?.intValue ?: 0,
                referrerNextAttemptAt = json["referrerNextAttemptAt"]?.longValue,
                reportedTokens = json["reportedTokens"]?.arrayValue?.mapNotNull { it.stringValue }?.toSet() ?: emptySet(),
                identifiersFingerprint = json["identifiersFingerprint"]?.stringValue,
                attribution = json["attribution"]?.stringValue,
                source = json["source"]?.stringValue,
                campaignId = json["campaignId"]?.stringValue,
                adGroupId = json["adGroupId"]?.stringValue,
                keywordId = json["keywordId"]?.stringValue,
                pollCount = json["pollCount"]?.intValue ?: 0,
                nextPollAt = json["nextPollAt"]?.longValue,
            )
        }

        fun load(store: KeyValueStore): ReporterState? = fromJson(store.string(Reporter.STATE_KEY))
    }
}

/** Why a sync runs. */
internal enum class SyncTrigger { LAUNCH, FOREGROUND, PURCHASE_UPDATE, MANUAL, RETRY, IDENTIFIERS }

/** Injected dependencies (real ones in the app, fakes in tests). */
internal class ReporterEnvironment(
    val referrer: InstallReferrerSource,
    val purchases: PurchaseSource,
    val store: KeyValueStore,
    val identity: InstallIdentity,
    val appVersion: String?,
    val deviceIdentifiers: DeviceIdentifierProvider,
    val clock: Clock,
    /** Serializes the reporter's work (one thread at a time, like an actor). */
    val serial: CoroutineDispatcher,
    /** Runs in-process retries. */
    val scope: CoroutineScope,
    /** Called when what [Revflare.attribution] returns changes. */
    val onAttributionChange: (RevflareAttribution) -> Unit = {},
    /** Called once per process, after the first report step of the first pass (whatever its outcome). */
    val onFirstReport: () -> Unit = {},
    /** Schedules a retry inside the running process after a failure (off in tests). */
    val retryInSession: Boolean = true,
)

/**
 * The state machine: reads the Play Install Referrer once and registers the install with it, polls the server until
 * the source is known, links the purchases this install owns (order ids and purchase tokens, in batches of 90), and
 * (only after the app opted in) reports the device identifiers for Meta matching whenever they change. The paths keep
 * their own backoff: a failure in one never holds back the others. Overlapping triggers coalesce into one more pass.
 */
internal class Reporter(private val client: RevflareClient, private val env: ReporterEnvironment) {
    companion object {
        const val STATE_KEY = "app.revflare.kit.state"
        const val META_ANONYMOUS_ID_KEY = "app.revflare.kit.metaAnonymousId"
        const val COLLECT_IDENTIFIERS_KEY = "app.revflare.kit.collectIdentifiers"
        const val MAX_PURCHASES_PER_REPORT = 90
        /** The referrer is retried for this long after the first attempt; then the install registers without it. */
        const val REFERRER_LIFETIME_MS = 24 * 3600 * 1000L
        /** Polling for the source stops this long after the first attempt. */
        const val POLL_LIFETIME_MS = 24 * 3600 * 1000L
        const val FOREGROUND_DEBOUNCE_MS = 60_000L
        const val REJECTED_BACKOFF_MS = 3600_000L
        const val MAX_IN_SESSION_RETRY_MS = 15 * 60_000L

        fun optIn(store: KeyValueStore, metaAnonymousId: String?) {
            if (metaAnonymousId != null) store.set(META_ANONYMOUS_ID_KEY, metaAnonymousId)
            store.set(COLLECT_IDENTIFIERS_KEY, "1")
        }

        fun isOptedIn(store: KeyValueStore): Boolean =
            store.string(COLLECT_IDENTIFIERS_KEY) == "1" || !store.string(META_ANONYMOUS_ID_KEY).isNullOrEmpty()

        /** Backoff after `failures` consecutive failures: 1, 2, 4... minutes, at most 6 hours. */
        fun backoff(failures: Int): Long {
            val exponent = (failures - 1).coerceIn(0, 16)
            return minOf(60_000L * (1L shl exponent), 6 * 3600_000L)
        }

        /** Delay before the next poll while the source is unknown, after `polls` of them: 1, 5, 15, 60 min, then 3 h. */
        fun pollDelay(polls: Int): Long {
            val schedule = longArrayOf(60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000)
            return if (polls < schedule.size) schedule[polls.coerceAtLeast(0)] else 3 * 3600_000L
        }

        /** "GPA.1234-5678-9012-34567..5" → "GPA.1234-5678-9012-34567". */
        fun baseOrderId(orderId: String?): String? {
            val trimmed = orderId?.trim()?.ifEmpty { null } ?: return null
            val index = trimmed.indexOf("..")
            return if (index > 0) trimmed.substring(0, index) else trimmed
        }
    }

    @Volatile
    var state: ReporterState
        private set

    private var running = false
    private var rerun = false
    private var lastPassAt: Long? = null
    private var linkFailures = 0
    private var linkNextAttemptAt: Long? = null
    private var retryJob: Job? = null
    private var identifiersFailures = 0
    private var identifiersNextAttemptAt: Long? = null
    private var identifiersRejected = false
    private var identifiersForced = false
    private var firstReportDone = false

    init {
        val loaded = ReporterState.load(env.store)
        state = if (loaded?.server == client.server) loaded else ReporterState(server = client.server)
    }

    val attribution: RevflareAttribution get() = state.publicAttribution

    /** Runs a pass now. If one is already running, returns at once and the running pass goes round once more. */
    suspend fun sync(trigger: SyncTrigger): Unit = withContext(env.serial) {
        if (trigger == SyncTrigger.IDENTIFIERS) identifiersForced = true
        val last = lastPassAt
        if (trigger == SyncTrigger.FOREGROUND && last != null && env.clock() - last < FOREGROUND_DEBOUNCE_MS) {
            Log.debug { "Foreground sync skipped (debounced)" }
            return@withContext
        }
        if (running) {
            rerun = true
            return@withContext
        }
        running = true
        try {
            do {
                rerun = false
                pass(trigger)
            } while (rerun)
        } finally {
            running = false
            lastPassAt = env.clock()
        }
    }

    private suspend fun pass(trigger: SyncTrigger) {
        val installId = env.identity.resolve()
        Log.debug { "Sync ($trigger) for install $installId" }
        val before = state.publicAttribution
        if (state.registered) poll(installId) else register(installId)
        val after = state.publicAttribution
        if (after != before) {
            Log.debug { "Attribution: ${after.rawSource}" }
            env.onAttributionChange(after)
        }
        if (!firstReportDone) {
            firstReportDone = true
            env.onFirstReport()
        }
        linkPurchases(installId)
        reportIdentifiers(installId)
    }

    private fun baseBody(installId: String, includeReferrer: Boolean): MutableMap<String, RevflareJson> {
        val body = linkedMapOf<String, RevflareJson>(
            "installId" to RevflareJson.Str(installId),
            "platform" to RevflareJson.Str("android"),
        )
        env.appVersion?.takeIf { it.isNotEmpty() }?.let { body["appVersion"] = RevflareJson.Str(it) }
        state.firstAttemptAt?.let { body["installedAt"] = RevflareJson.Number(it.toDouble()) }
        val referrer = state.referrer
        if (includeReferrer && referrer != null && !state.referrerAccepted) body["installReferrer"] = referrer.toJson()
        return body
    }

    // Registration (install referrer)

    private suspend fun register(installId: String) {
        val now = env.clock()
        if (state.firstAttemptAt == null) update { it.copy(firstAttemptAt = now) }
        state.nextAttemptAt?.let { if (it > now) return }
        if (state.referrerStatus == ReporterState.REFERRER_WAITING && !readReferrer(now)) return

        val body = baseBody(installId, includeReferrer = true)
        val sentReferrer = body.containsKey("installReferrer")
        when (val outcome = client.send(RevflareClient.Path.REPORT, RevflareJson.Object(body))) {
            is ReportOutcome.Accepted -> {
                val response = outcome.response
                update {
                    it.copy(
                        registered = true,
                        failures = 0,
                        nextAttemptAt = null,
                        referrerAccepted = it.referrerAccepted || sentReferrer,
                        attribution = response.attribution,
                        pollCount = 0,
                    )
                }
                Log.debug { "Install registered: ${response.attribution ?: "?"}, source ${response.source ?: "?"}" }
                applyResolution(response)
            }
            is ReportOutcome.Rejected -> {
                Log.error("Revflare refused the install report (HTTP ${outcome.status}): ${outcome.message}. Check the SDK key.")
                recordFailure(REJECTED_BACKOFF_MS)
            }
            is ReportOutcome.Retryable -> {
                Log.debug { "Install report failed: ${outcome.message}" }
                recordFailure(null)
            }
        }
    }

    /** Reads the referrer when due. Returns true when it is settled (read or unavailable). */
    private suspend fun readReferrer(now: Long): Boolean {
        state.referrerNextAttemptAt?.let { if (it > now) return false }
        when (val result = env.referrer.read()) {
            is ReferrerResult.Found -> {
                update { it.copy(referrerStatus = ReporterState.REFERRER_READ, referrer = result.data, referrerNextAttemptAt = null) }
                Log.debug { "Install referrer read" }
                return true
            }
            ReferrerResult.Unavailable -> {
                update { it.copy(referrerStatus = ReporterState.REFERRER_UNAVAILABLE, referrerNextAttemptAt = null) }
                Log.debug { "Install referrer not available on this device" }
                return true
            }
            is ReferrerResult.Error -> {
                val first = state.firstAttemptAt ?: now
                if (now - first >= REFERRER_LIFETIME_MS) {
                    Log.debug { "Install referrer: still failing after 24 hours (${result.message}); registering without it" }
                    update { it.copy(referrerStatus = ReporterState.REFERRER_UNAVAILABLE, referrerNextAttemptAt = null) }
                    return true
                }
                val failures = state.referrerFailures + 1
                val delay = backoff(failures)
                update { it.copy(referrerFailures = failures, referrerNextAttemptAt = now + delay) }
                Log.debug { "Install referrer unavailable for now (${result.message}), retrying in ${delay / 1000} s" }
                scheduleRetry(delay)
                return false
            }
        }
    }

    private fun recordFailure(fixed: Long?) {
        val failures = state.failures + 1
        val delay = fixed ?: backoff(failures)
        update { it.copy(failures = failures, nextAttemptAt = env.clock() + delay) }
        scheduleRetry(delay)
    }

    // Resolution

    private fun applyResolution(response: ReportResponse) {
        val source = response.source
        if (source != null) {
            val attributed = source != RevflareAttribution.Source.ORGANIC.wireValue && source != RevflareAttribution.Source.UNKNOWN.wireValue
            update {
                it.copy(
                    source = source,
                    campaignId = if (attributed) response.campaignId else null,
                    adGroupId = if (attributed) response.adGroupId else null,
                    keywordId = if (attributed) response.keywordId else null,
                )
            }
        }
        val known = state.source
        val learnMore = when {
            known != null && known != RevflareAttribution.Source.UNKNOWN.wireValue -> false
            response.source == RevflareAttribution.Source.UNKNOWN.wireValue -> true
            else -> response.source == null && response.attribution == "pending"
        }
        val next = if (learnMore) env.clock() + pollDelay(state.pollCount) else null
        update { it.copy(nextPollAt = next) }
        if (next != null) scheduleRetry(next - env.clock())
    }

    /** While the source is unknown, asks again with a report holding only the install, on the [pollDelay] schedule. */
    private suspend fun poll(installId: String) {
        val now = env.clock()
        val next = state.nextPollAt ?: return
        val first = state.firstAttemptAt
        if (first != null && now - first >= POLL_LIFETIME_MS) {
            Log.debug { "Attribution: 24 hours passed without a resolution, no more polling" }
            update { it.copy(nextPollAt = null) }
            return
        }
        if (next > now) return
        val body = baseBody(installId, includeReferrer = true)
        val sentReferrer = body.containsKey("installReferrer")
        when (val outcome = client.send(RevflareClient.Path.REPORT, RevflareJson.Object(body))) {
            is ReportOutcome.Accepted -> {
                val polls = state.pollCount + 1
                update {
                    it.copy(
                        pollCount = polls,
                        failures = 0,
                        attribution = outcome.response.attribution ?: it.attribution,
                        referrerAccepted = it.referrerAccepted || sentReferrer,
                    )
                }
                Log.debug { "Attribution poll $polls: source ${outcome.response.source ?: "?"}" }
                applyResolution(outcome.response)
            }
            is ReportOutcome.Rejected -> {
                Log.error("Revflare refused the attribution report (HTTP ${outcome.status}): ${outcome.message}. Check the SDK key.")
                update { it.copy(nextPollAt = now + REJECTED_BACKOFF_MS) }
            }
            is ReportOutcome.Retryable -> {
                Log.debug { "Attribution poll failed: ${outcome.message}" }
                val failures = state.failures + 1
                val delay = backoff(failures)
                update { it.copy(failures = failures, nextPollAt = now + delay) }
                scheduleRetry(delay)
            }
        }
    }

    // Purchase links

    private suspend fun linkPurchases(installId: String) {
        // The first report carries the referrer: purchases wait until it is settled.
        if (state.referrerStatus == ReporterState.REFERRER_WAITING) return
        val now = env.clock()
        linkNextAttemptAt?.let { if (it > now) return }
        val owned = env.purchases.ownedPurchases() ?: return
        val unreported = owned
            .filter { it.state == RevflarePurchase.State.PURCHASED && it.purchaseToken.isNotEmpty() && it.purchaseToken !in state.reportedTokens }
            .distinctBy { it.purchaseToken }
            .sortedWith(compareBy({ it.purchaseTime }, { it.purchaseToken }))
        if (unreported.isEmpty()) return
        Log.debug { "Linking ${unreported.size} purchase(s)" }
        for (batch in unreported.chunked(MAX_PURCHASES_PER_REPORT)) {
            val body = baseBody(installId, includeReferrer = true)
            val sentReferrer = body.containsKey("installReferrer")
            val orderIds = batch.mapNotNull { baseOrderId(it.orderId) }.distinct()
            if (orderIds.isNotEmpty()) body["orderIds"] = RevflareJson.strings(orderIds)
            body["purchaseTokens"] = RevflareJson.strings(batch.map { it.purchaseToken })
            when (val outcome = client.send(RevflareClient.Path.REPORT, RevflareJson.Object(body))) {
                is ReportOutcome.Accepted -> {
                    update {
                        it.copy(
                            reportedTokens = it.reportedTokens + batch.map { purchase -> purchase.purchaseToken },
                            referrerAccepted = it.referrerAccepted || sentReferrer,
                        )
                    }
                    linkFailures = 0
                    linkNextAttemptAt = null
                }
                is ReportOutcome.Rejected -> {
                    Log.error("Revflare refused the purchase report (HTTP ${outcome.status}): ${outcome.message}. Check the SDK key.")
                    linkFailures += 1
                    linkNextAttemptAt = env.clock() + REJECTED_BACKOFF_MS
                    return
                }
                is ReportOutcome.Retryable -> {
                    Log.debug { "Purchase report failed: ${outcome.message}" }
                    linkFailures += 1
                    val delay = backoff(linkFailures)
                    linkNextAttemptAt = env.clock() + delay
                    scheduleRetry(delay)
                    return
                }
            }
        }
    }

    // Device identifiers (Meta)

    private suspend fun reportIdentifiers(installId: String) {
        val forced = identifiersForced
        identifiersForced = false
        if (!isOptedIn(env.store)) return
        if (forced && !identifiersRejected) identifiersNextAttemptAt = null
        identifiersNextAttemptAt?.let { if (it > env.clock()) return }

        val anonId = env.store.string(META_ANONYMOUS_ID_KEY)?.ifEmpty { null }
        val device = env.deviceIdentifiers.deviceIdentifiers()
        val body = identifiersBody(installId, anonId, device)
        val fingerprint = identifiersFingerprint(installId, anonId, device)
        if (fingerprint == state.identifiersFingerprint) return

        Log.debug {
            "Reporting device identifiers (fbAnonId: ${if (anonId == null) "none" else "set"}, " +
                "GAID: ${if (device.gaid == null) "none" else "set"}, status: ${device.attStatus.wireValue})"
        }
        when (val outcome = client.send(RevflareClient.Path.IDENTIFIERS, body)) {
            is ReportOutcome.Accepted -> {
                update { it.copy(identifiersFingerprint = fingerprint) }
                identifiersFailures = 0
                identifiersNextAttemptAt = null
                identifiersRejected = false
                Log.debug { "Device identifiers accepted" }
            }
            is ReportOutcome.Rejected -> {
                Log.error("Revflare refused the device identifiers (HTTP ${outcome.status}): ${outcome.message}")
                identifiersFailures += 1
                identifiersRejected = true
                identifiersNextAttemptAt = env.clock() + REJECTED_BACKOFF_MS
            }
            is ReportOutcome.Retryable -> {
                Log.debug { "Device identifiers report failed: ${outcome.message}" }
                identifiersFailures += 1
                identifiersRejected = false
                val delay = backoff(identifiersFailures)
                identifiersNextAttemptAt = env.clock() + delay
                scheduleRetry(delay)
            }
        }
    }

    // Persistence and retries

    private fun update(change: (ReporterState) -> ReporterState) {
        state = change(state)
        env.store.set(STATE_KEY, state.toJson().toJsonString())
    }

    private fun scheduleRetry(delayMs: Long) {
        if (!env.retryInSession || delayMs > MAX_IN_SESSION_RETRY_MS || retryJob?.isActive == true) return
        retryJob = env.scope.launch {
            delay(delayMs + 1000)
            retryJob = null
            sync(SyncTrigger.RETRY)
        }
    }
}

/** Body of `POST /sdk/v1/identifiers` (absent values sent as null, like iOS). */
internal fun identifiersBody(installId: String, fbAnonId: String?, device: DeviceIdentifiers): RevflareJson.Object =
    RevflareJson.Object(
        mapOf(
            "installId" to RevflareJson.Str(installId),
            "platform" to RevflareJson.Str("android"),
            "fbAnonId" to RevflareJson.strOrNull(fbAnonId),
            "gaid" to RevflareJson.strOrNull(device.gaid),
            "attStatus" to RevflareJson.Str(device.attStatus.wireValue),
            "bundleId" to RevflareJson.Str(device.bundleId),
            "appVersion" to RevflareJson.Str(device.appVersion),
            "appBuild" to RevflareJson.Str(device.appBuild),
            "osVersion" to RevflareJson.Str(device.osVersion),
            "deviceModel" to RevflareJson.Str(device.deviceModel),
            "locale" to RevflareJson.Str(device.locale),
            "timeZone" to RevflareJson.Str(device.timeZone),
            "extinfo" to RevflareJson.strings(device.extinfo),
        ),
    )

/** The fields that matter for matching (not free disk space or the rest of extinfo), hashed. */
internal fun identifiersFingerprint(installId: String, fbAnonId: String?, device: DeviceIdentifiers): String =
    sha256Hex(
        listOf(
            installId, fbAnonId ?: "", device.gaid ?: "", device.attStatus.wireValue, device.appVersion,
            device.appBuild, device.osVersion, device.locale,
        ).joinToString("\u001F"),
    )

package app.revflare.kit

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** What the app tells the tracker, in order. */
internal sealed class EventCommand {
    data class Track(val event: TrackedEvent) : EventCommand()
    /** `configure` ran. `existingInstall`: RevflareKit ran here before (no `first_open` then). */
    data class Launch(val at: Long, val existingInstall: Boolean) : EventCommand()
    data class Foreground(val at: Long) : EventCommand()
    /** The app went to the background; `done` is called once the flush that follows has finished. */
    data class Background(val at: Long, val done: (() -> Unit)? = null) : EventCommand()
    data class SetEnabled(val enabled: Boolean) : EventCommand()
}

/**
 * Carries commands from any thread to the tracker, in order, without blocking the caller. Commands sent before
 * [Revflare.configure] wait in the buffer (the newest 1,000 are kept).
 */
internal class EventPipe(capacity: Int = EventTracker.MAX_QUEUE) {
    val channel: Channel<EventCommand> = Channel(capacity, BufferOverflow.DROP_OLDEST)
    fun send(command: EventCommand) {
        channel.trySend(command)
    }
}

/** Injected dependencies (real ones in the app, fakes in tests). */
internal class EventsEnvironment(
    val storage: EventStorage,
    val store: KeyValueStore,
    val identity: InstallIdentity,
    val context: () -> AppContext,
    val clock: Clock,
    /** Serializes the tracker's work (one thread at a time, like an actor). */
    val serial: CoroutineDispatcher,
    /** Runs flushes and timers. */
    val scope: CoroutineScope,
    val makeId: () -> String = ::newId,
)

/**
 * The event queue: sessions, automatic events, persistence and delivery to `POST /sdk/v1/events`.
 *
 * Events are kept in a file until the server answers 2xx (at most 1,000, the oldest dropped first). Flushes run at
 * launch, every 30 seconds while events are pending, when 50 are queued and when the app goes to the background; each
 * request carries at most 200 events. 429 / 5xx / network errors back off (5 s doubling to 10 min, or the server's
 * `Retry-After`); any other 4xx drops the batch.
 */
internal class EventTracker(private val client: RevflareClient, private val env: EventsEnvironment) {
    companion object {
        const val MAX_QUEUE = 1000
        const val MAX_BATCH = 200
        const val FLUSH_THRESHOLD = 50
        const val FLUSH_INTERVAL_MS = 30_000L
        /** A foreground after at least this long in the background starts a new session. */
        const val SESSION_TIMEOUT_MS = 30 * 60_000L
        const val MAX_RETRY_AFTER_MS = 3600_000L

        /** "0" when the app turned analytics off. */
        const val ENABLED_KEY = "app.revflare.kit.analyticsEnabled"
        /** "1" once `first_open` was queued for this install. */
        const val FIRST_OPEN_KEY = "app.revflare.kit.firstOpen"

        fun isEnabled(store: KeyValueStore): Boolean = store.string(ENABLED_KEY) != "0"

        /** Backoff after `failures` consecutive failed flushes: 5, 10, 20... seconds, at most 10 minutes. */
        fun backoff(failures: Int): Long {
            val exponent = (failures - 1).coerceIn(0, 16)
            return minOf(5_000L * (1L shl exponent), 600_000L)
        }
    }

    private val queue = ArrayList<QueuedEvent>()
    private var enabled = isEnabled(env.store)
    var sessionId: String = env.makeId()
        private set
    private var backgroundedAt: Long? = null

    private var failures = 0
    private var nextAttemptAt: Long? = null
    private var flushJob: Job? = null
    private var flushAgain = false
    private var timer: Job? = null
    private var rejectionLogged = false

    init {
        if (enabled) queue.addAll(env.storage.load()) else env.storage.clear()
    }

    /** The queued events (tests and diagnostics). */
    suspend fun pending(): List<QueuedEvent> = withContext(env.serial) { queue.toList() }
    val isEnabled: Boolean get() = enabled
    val retryAt: Long? get() = nextAttemptAt

    suspend fun handle(command: EventCommand): Unit = withContext(env.serial) {
        when (command) {
            is EventCommand.Track -> enqueue(command.event)
            is EventCommand.Launch -> {
                if (!enabled) return@withContext
                if (env.store.string(FIRST_OPEN_KEY) != "1") {
                    if (!command.existingInstall) enqueue(automatic("first_open", command.at))
                    env.store.set(FIRST_OPEN_KEY, "1")
                }
                enqueue(automatic("app_open", command.at))
                enqueue(automatic("session_start", command.at))
                requestFlush()
            }
            is EventCommand.Foreground -> {
                val since = backgroundedAt
                if (since != null && command.at - since >= SESSION_TIMEOUT_MS) {
                    sessionId = env.makeId()
                    if (enabled) enqueue(automatic("session_start", command.at))
                }
                backgroundedAt = null
                scheduleIfPending()
            }
            is EventCommand.Background -> {
                backgroundedAt = command.at
                if (enabled) enqueue(automatic("app_background", command.at))
                requestFlush()
                command.done?.let { done ->
                    env.scope.launch {
                        waitForFlush()
                        done()
                    }
                }
            }
            is EventCommand.SetEnabled -> {
                if (command.enabled == enabled) return@withContext
                enabled = command.enabled
                if (!command.enabled) {
                    queue.clear()
                    env.storage.clear()
                    timer?.cancel()
                    timer = null
                    failures = 0
                    nextAttemptAt = null
                    Log.debug { "Events: analytics off, queue dropped" }
                }
            }
        }
    }

    /** Waits until no flush is running. */
    suspend fun waitForFlush() {
        while (true) {
            val job = withContext(env.serial) { flushJob } ?: return
            job.join()
        }
    }

    /** Starts a flush now unless one is running (then it goes round once more). Call on [EventsEnvironment.serial]. */
    private fun requestFlush() {
        if (!enabled || queue.isEmpty()) return
        if (flushJob != null) {
            flushAgain = true
            return
        }
        flushJob = env.scope.launch(env.serial) { runFlushes() }
    }

    // Queue

    private fun automatic(name: String, at: Long) = TrackedEvent(env.makeId(), name, at, emptyMap())

    private fun enqueue(event: TrackedEvent) {
        if (!enabled) return
        val queued = QueuedEvent(event.id, event.name, event.ts, sessionId, event.props)
        queue.add(queued)
        if (queue.size > MAX_QUEUE) {
            repeat(queue.size - MAX_QUEUE) { queue.removeAt(0) }
            env.storage.replace(queue.toList())
        } else {
            env.storage.append(listOf(queued))
        }
        if (queue.size >= FLUSH_THRESHOLD) requestFlush() else scheduleIfPending()
    }

    private fun remove(ids: Set<String>) {
        queue.removeAll { it.id in ids }
        env.storage.replace(queue.toList())
    }

    // Delivery

    private suspend fun runFlushes() {
        try {
            do {
                flushAgain = false
                flushOnce()
            } while (flushAgain && enabled && queue.isNotEmpty() && !isBackingOff)
        } finally {
            flushJob = null
        }
        scheduleIfPending()
    }

    private val isBackingOff: Boolean
        get() = nextAttemptAt?.let { it > env.clock() } ?: false

    private suspend fun flushOnce() {
        if (!enabled || queue.isEmpty() || isBackingOff) return
        val installId = env.identity.resolve()
        val context = env.context()
        while (enabled && queue.isNotEmpty()) {
            val batch = queue.take(MAX_BATCH)
            val ids = batch.map { it.id }.toSet()
            when (val outcome = client.sendEvents(eventsBody(installId, context, batch))) {
                is EventsOutcome.Accepted -> {
                    failures = 0
                    nextAttemptAt = null
                    remove(ids)
                    Log.debug { "Events: sent ${batch.size} (accepted ${outcome.accepted ?: "?"}, dropped ${outcome.dropped ?: "?"})" }
                }
                is EventsOutcome.Rejected -> {
                    remove(ids)
                    if (!rejectionLogged) {
                        rejectionLogged = true
                        Log.error("Revflare refused ${batch.size} event(s) (HTTP ${outcome.status}): ${outcome.message}. They were dropped. Check the SDK key.")
                    }
                }
                is EventsOutcome.Retry -> {
                    failures += 1
                    val delay = outcome.afterMs?.coerceIn(1000, MAX_RETRY_AFTER_MS) ?: backoff(failures)
                    nextAttemptAt = env.clock() + delay
                    Log.debug { "Events: sending failed (${outcome.message}), retrying in ${delay / 1000} s" }
                    schedule(delay, replacing = true)
                    return
                }
            }
        }
    }

    // Timer

    /** While events are pending, makes sure a flush is scheduled (30 s, or when the backoff ends). */
    private fun scheduleIfPending() {
        if (!enabled || queue.isEmpty() || timer != null || flushJob != null) return
        val next = nextAttemptAt
        val now = env.clock()
        schedule(if (next != null && next > now) next - now else FLUSH_INTERVAL_MS, replacing = false)
    }

    private fun schedule(delayMs: Long, replacing: Boolean) {
        if (timer != null) {
            if (!replacing) return
            timer?.cancel()
        }
        timer = env.scope.launch(env.serial) {
            delay(delayMs)
            timer = null
            timerFired()
        }
    }

    private fun timerFired() {
        if (!enabled || queue.isEmpty()) return
        if (isBackingOff) scheduleIfPending() else requestFlush()
    }
}

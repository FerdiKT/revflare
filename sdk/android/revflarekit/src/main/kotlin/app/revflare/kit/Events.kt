package app.revflare.kit

import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// Wire format (`POST /sdk/v1/events`)

/** One event as queued on the device and sent to the server. */
internal data class QueuedEvent(
    /** Client event id (lowercase UUID), so the server can drop duplicates. */
    val id: String,
    val name: String,
    /** Milliseconds since 1970, device clock. */
    val ts: Long,
    /** Lowercase UUID of the session the event happened in. */
    val sessionId: String,
    val props: Map<String, String>,
) {
    fun toJson(): RevflareJson.Object = RevflareJson.Object(
        mapOf(
            "id" to RevflareJson.Str(id),
            "name" to RevflareJson.Str(name),
            "ts" to RevflareJson.Number(ts.toDouble()),
            "sessionId" to RevflareJson.Str(sessionId),
            "props" to RevflareJson.Object(props.mapValues { RevflareJson.Str(it.value) }),
        ),
    )

    companion object {
        fun fromJson(json: RevflareJson?): QueuedEvent? {
            json ?: return null
            return QueuedEvent(
                id = json["id"]?.stringValue ?: return null,
                name = json["name"]?.stringValue ?: return null,
                ts = json["ts"]?.longValue ?: return null,
                sessionId = json["sessionId"]?.stringValue ?: return null,
                props = json["props"]?.objectValue.orEmpty().mapNotNull { (k, v) -> v.stringValue?.let { k to it } }.toMap(),
            )
        }
    }
}

/** Body of `POST /sdk/v1/events`. */
internal fun eventsBody(installId: String, context: AppContext, events: List<QueuedEvent>): RevflareJson.Object =
    RevflareJson.Object(
        mapOf(
            "installId" to RevflareJson.Str(installId),
            "appVersion" to RevflareJson.Str(context.appVersion),
            "appBuild" to RevflareJson.Str(context.appBuild),
            "osVersion" to RevflareJson.Str(context.osVersion),
            "locale" to RevflareJson.Str(context.locale),
            "events" to RevflareJson.Array(events.map { it.toJson() }),
        ),
    )

/** What came of one events request. */
internal sealed class EventsOutcome {
    /** 2xx: the server took the batch (invalid events in it were dropped, not retried). */
    data class Accepted(val accepted: Int?, val dropped: Int?) : EventsOutcome()
    /** 4xx other than 429: the batch is refused for good. Dropped. */
    data class Rejected(val status: Int, val message: String) : EventsOutcome()
    /** 429, 5xx, network error: kept and retried. `afterMs` is the server's `Retry-After`. */
    data class Retry(val afterMs: Long?, val message: String) : EventsOutcome()
}

internal suspend fun RevflareClient.sendEvents(body: RevflareJson.Object): EventsOutcome {
    val request = postRequest(RevflareClient.Path.EVENTS, body)
    return try {
        val response = transport.send(request)
        when {
            response.status in 200..299 -> {
                val json = RevflareJson.parseOrNull(response.body)
                EventsOutcome.Accepted(json?.get("accepted")?.intValue, json?.get("dropped")?.intValue)
            }
            response.status == 429 || response.status >= 500 ->
                EventsOutcome.Retry(response.header("Retry-After")?.let(::retryAfterMs), "HTTP ${response.status}")
            else -> EventsOutcome.Rejected(response.status, response.body.take(300))
        }
    } catch (error: Exception) {
        if (error is kotlinx.coroutines.CancellationException) throw error
        EventsOutcome.Retry(null, error.toString())
    }
}

/** `Retry-After` in milliseconds (the HTTP-date form is not used by Revflare and is ignored). */
internal fun retryAfterMs(value: String): Long? {
    val seconds = value.trim().toDoubleOrNull() ?: return null
    if (!seconds.isFinite() || seconds < 0) return null
    return (seconds * 1000).toLong()
}

// Sanitizing

/** An event as tracked, before the tracker gives it a session. */
internal data class TrackedEvent(val id: String, val name: String, val ts: Long, val props: Map<String, String>)

/** Applies the server's limits on the device, so a batch never carries an event the server would drop. */
internal object EventSanitizer {
    const val MAX_NAME_LENGTH = 64
    const val MAX_PROPS = 10
    const val MAX_KEY_LENGTH = 40
    const val MAX_VALUE_LENGTH = 100

    private val nameRegex = Regex("^[A-Za-z0-9_.:-]{1,64}$")
    private val keyRegex = Regex("^[A-Za-z0-9_.-]{1,40}$")

    fun isValidName(name: String): Boolean = nameRegex.matches(name)
    fun isValidKey(key: String): Boolean = keyRegex.matches(key)

    /** The event, or null (with a debug log) when its name is invalid. */
    fun event(name: String, properties: Map<String, Any?>, at: Long, id: String = newId()): TrackedEvent? {
        if (!isValidName(name)) {
            Log.debug { "Event \"${name.take(80)}\" dropped: names are 1-64 characters of A-Z a-z 0-9 _ . : -" }
            return null
        }
        return TrackedEvent(id, name, at, props(properties, name))
    }

    /**
     * Valid keys with string values: numbers and booleans become strings, strings are cut to 100 characters,
     * unsupported values and invalid keys are dropped; at most 10 properties (the first 10 keys in sorted order).
     */
    fun props(properties: Map<String, Any?>, event: String = ""): Map<String, String> {
        val result = LinkedHashMap<String, String>()
        for (key in properties.keys.sorted()) {
            if (!isValidKey(key)) {
                Log.debug { "Event $event: property \"${key.take(60)}\" dropped (keys are 1-40 characters of A-Z a-z 0-9 _ . -)" }
                continue
            }
            val value = string(properties[key])
            if (value == null) {
                Log.debug { "Event $event: property $key dropped (use strings, numbers or booleans)" }
                continue
            }
            if (result.size >= MAX_PROPS) {
                Log.debug { "Event $event: more than $MAX_PROPS properties, $key and later keys dropped" }
                break
            }
            result[key] = truncate(value)
        }
        return result
    }

    /** At most 100 UTF-16 code units (the server measures JavaScript string length), never splitting a surrogate pair. */
    fun truncate(value: String): String {
        if (value.length <= MAX_VALUE_LENGTH) return value
        var end = MAX_VALUE_LENGTH
        if (Character.isHighSurrogate(value[end - 1])) end -= 1
        return value.substring(0, end)
    }

    /** A property value as a string, or null when the type is not supported. */
    fun string(value: Any?): String? = when (value) {
        null -> null
        is String -> value
        is CharSequence -> value.toString()
        is Boolean -> if (value) "true" else "false"
        is Int, is Long, is Short, is Byte -> value.toString()
        is Double -> format(value)
        is Float -> format(value.toDouble())
        is java.math.BigDecimal -> value.toPlainString()
        is java.math.BigInteger -> value.toString()
        is java.util.UUID -> value.toString().lowercase()
        is java.net.URI -> value.toString()
        is java.net.URL -> value.toString()
        is Date -> iso8601(value)
        is Enum<*> -> value.name
        else -> null
    }

    /** Whole numbers without a decimal point ("2", not "2.0"); NaN and infinities are not sent. */
    fun format(number: Double): String? = if (number.isFinite()) formatNumber(number) else null

    private fun iso8601(date: Date): String {
        val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
        format.timeZone = TimeZone.getTimeZone("UTC")
        return format.format(date)
    }
}

// Storage

/** Where the queue survives app kills (a file in the app, memory in tests). */
internal interface EventStorage {
    fun load(): List<QueuedEvent>
    fun append(events: List<QueuedEvent>)
    fun replace(events: List<QueuedEvent>)
    fun clear()
}

/**
 * JSON lines in `noBackupFilesDir/app.revflare.kit/events.jsonl` (never backed up): adding an event appends one line;
 * removing events rewrites the file atomically. A line cut short by a kill is skipped at the next load.
 */
internal class FileEventStorage(private val file: File) : EventStorage {
    @Synchronized
    override fun load(): List<QueuedEvent> {
        val text = runCatching { if (file.exists()) file.readText() else "" }.getOrDefault("")
        if (text.isEmpty()) return emptyList()
        var malformed = false
        val events = text.split('\n').filter { it.isNotEmpty() }.mapNotNull { line ->
            QueuedEvent.fromJson(RevflareJson.parseOrNull(line)).also { if (it == null) malformed = true }
        }.takeLast(EventTracker.MAX_QUEUE)
        if (malformed || !text.endsWith("\n")) write(events)
        return events
    }

    @Synchronized
    override fun append(events: List<QueuedEvent>) {
        if (events.isEmpty()) return
        runCatching {
            file.parentFile?.mkdirs()
            file.appendText(encode(events))
        }.onFailure { Log.debug { "Events: could not append to the queue file: $it" } }
    }

    @Synchronized
    override fun replace(events: List<QueuedEvent>) = write(events)

    @Synchronized
    override fun clear() {
        file.delete()
    }

    private fun write(events: List<QueuedEvent>) {
        if (events.isEmpty()) {
            file.delete()
            return
        }
        runCatching {
            file.parentFile?.mkdirs()
            val temp = File(file.parentFile, file.name + ".tmp")
            temp.writeText(encode(events))
            if (!temp.renameTo(file)) {
                file.writeText(encode(events))
                temp.delete()
            }
        }.onFailure { Log.debug { "Events: could not write the queue file: $it" } }
    }

    private fun encode(events: List<QueuedEvent>): String = events.joinToString("") { it.toJson().toJsonString() + "\n" }
}

/** Keeps the queue in memory only (tests, or when no file can be used). */
internal class MemoryEventStorage : EventStorage {
    private val events = ArrayList<QueuedEvent>()
    @Synchronized override fun load(): List<QueuedEvent> = events.toList()
    @Synchronized override fun append(events: List<QueuedEvent>) {
        this.events.addAll(events)
    }
    @Synchronized override fun replace(events: List<QueuedEvent>) {
        this.events.clear()
        this.events.addAll(events)
    }
    @Synchronized override fun clear() = events.clear()
}

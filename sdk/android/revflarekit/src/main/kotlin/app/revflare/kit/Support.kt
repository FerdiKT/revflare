package app.revflare.kit

import android.content.SharedPreferences
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/**
 * Logging through `android.util.Log` (tag `RevflareKit`). Debug messages only appear with [Revflare.debugLogging];
 * configuration errors (unknown SDK key, rejected request) are always logged.
 */
internal object Log {
    @Volatile
    var enabled: Boolean = false

    /** Replaced in tests (android.util.Log is a stub on the JVM). */
    @Volatile
    var sink: (level: Int, message: String) -> Unit = { level, message ->
        if (level >= android.util.Log.ERROR) {
            android.util.Log.e("RevflareKit", message)
        } else {
            android.util.Log.d("RevflareKit", message)
        }
    }

    fun debug(message: () -> String) {
        if (!enabled) return
        runCatching { sink(android.util.Log.DEBUG, message()) }
    }

    fun error(message: String) {
        runCatching { sink(android.util.Log.ERROR, message) }
    }
}

/** Persistent key/value storage (SharedPreferences in the app, in memory in tests). Thread-safe. */
internal interface KeyValueStore {
    fun string(key: String): String?
    fun set(key: String, value: String?)
    /** Removes every key (backup restore onto another device). */
    fun clear()
}

internal class SharedPreferencesStore(private val prefs: SharedPreferences) : KeyValueStore {
    override fun string(key: String): String? = prefs.getString(key, null)

    override fun set(key: String, value: String?) {
        val editor = prefs.edit()
        if (value == null) editor.remove(key) else editor.putString(key, value)
        editor.apply()
    }

    override fun clear() {
        prefs.edit().clear().apply()
    }
}

internal class MemoryKeyValueStore : KeyValueStore {
    private val values = ConcurrentHashMap<String, String>()
    override fun string(key: String): String? = values[key]
    override fun set(key: String, value: String?) {
        if (value == null) values.remove(key) else values[key] = value
    }
    override fun clear() = values.clear()
    val keys: Set<String> get() = values.keys
}

internal fun sha256Hex(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

/** A lowercase UUID string. */
internal fun newId(): String = java.util.UUID.randomUUID().toString().lowercase()

/** Milliseconds since 1970. */
internal typealias Clock = () -> Long

internal val systemClock: Clock = { System.currentTimeMillis() }

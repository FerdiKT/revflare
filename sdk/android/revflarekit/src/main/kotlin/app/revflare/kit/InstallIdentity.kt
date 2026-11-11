package app.revflare.kit

import java.io.File

/** A file that is never backed up (in `Context.noBackupFilesDir`), holding the install id. */
internal interface NoBackupMarker {
    fun read(): String?
    fun write(id: String)
}

internal class FileNoBackupMarker(private val file: File) : NoBackupMarker {
    override fun read(): String? = runCatching { file.takeIf { it.exists() }?.readText()?.trim()?.ifEmpty { null } }.getOrNull()

    override fun write(id: String) {
        runCatching {
            file.parentFile?.mkdirs()
            val temp = File(file.parentFile, file.name + ".tmp")
            temp.writeText(id)
            if (!temp.renameTo(file)) {
                file.writeText(id)
                temp.delete()
            }
        }.onFailure { Log.debug { "Install id marker not written: $it" } }
    }
}

internal class MemoryNoBackupMarker(var value: String? = null) : NoBackupMarker {
    override fun read(): String? = value
    override fun write(id: String) {
        value = id
    }
}

/**
 * The install id: a random UUID created once, kept in RevflareKit's SharedPreferences, with a copy in a file of
 * `noBackupFilesDir`. SharedPreferences may be restored by Auto Backup onto another device; the file never is. So
 * preferences without the matching file are a restore: RevflareKit then starts over as a new install (new id, no
 * state), which keeps one install id per device.
 */
internal class InstallIdentity(
    private val store: KeyValueStore,
    private val marker: NoBackupMarker,
    private val makeId: () -> String = ::newId,
) {
    companion object {
        const val KEY = "app.revflare.kit.installId"
    }

    @Volatile
    private var cached: String? = null

    /** True when this process found RevflareKit data restored from another device (and cleared it). */
    @Volatile
    var restoredFromBackup: Boolean = false
        private set

    /** The install id (lowercase UUID). */
    fun resolve(): String {
        cached?.let { return it }
        synchronized(this) {
            cached?.let { return it }
            val stored = store.string(KEY)?.takeIf { isUuid(it) }?.lowercase()
            val mark = marker.read()?.takeIf { isUuid(it) }?.lowercase()
            val id = when {
                stored != null && stored == mark -> stored
                stored == null && mark != null -> {
                    store.set(KEY, mark)
                    mark
                }
                stored != null -> {
                    // Preferences came back from a backup (another device or a reinstall): start over.
                    Log.debug { "RevflareKit data restored from a backup: starting as a new install" }
                    restoredFromBackup = true
                    store.clear()
                    val fresh = makeId()
                    store.set(KEY, fresh)
                    marker.write(fresh)
                    fresh
                }
                else -> {
                    val fresh = makeId()
                    store.set(KEY, fresh)
                    marker.write(fresh)
                    fresh
                }
            }
            cached = id
            return id
        }
    }

    private fun isUuid(value: String): Boolean = runCatching { java.util.UUID.fromString(value) }.isSuccess && value.length == 36
}

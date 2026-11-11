package app.revflare.kit

import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.UUID

class EventsTest {
    private val base = 1_760_000_000_000L
    private val appContext = AppContext("1.2.0", "42", "15", "en_US")

    private fun TestScope.tracker(
        transport: FakeTransport,
        store: MemoryKeyValueStore = MemoryKeyValueStore(),
        storage: EventStorage = MemoryEventStorage(),
    ): EventTracker {
        var counter = 0
        return EventTracker(
            client(transport),
            EventsEnvironment(
                storage = storage,
                store = store,
                identity = memoryIdentity(store),
                context = { appContext },
                clock = { base + testScheduler.currentTime },
                serial = StandardTestDispatcher(testScheduler),
                scope = backgroundScope,
                makeId = { UUID(0, (++counter).toLong()).toString() },
            ),
        )
    }

    private fun names(request: HttpRequest): List<String> =
        RevflareJson.parse(request.body!!)["events"]!!.arrayValue!!.map { it["name"]!!.stringValue!! }

    @Test
    fun launchQueuesFirstOpenAndFlushesWithTheExactBody() = runTest {
        val transport = FakeTransport()
        val tracker = tracker(transport)
        tracker.handle(EventCommand.Launch(base, existingInstall = false))
        runCurrent()
        val sent = transport.posts("events").single()
        val session = tracker.sessionId
        assertEquals(
            "{\"appBuild\":\"42\",\"appVersion\":\"1.2.0\",\"environment\":\"production\",\"events\":[" +
                "{\"id\":\"00000000-0000-0000-0000-000000000002\",\"name\":\"first_open\",\"props\":{},\"sessionId\":\"$session\",\"ts\":$base}," +
                "{\"id\":\"00000000-0000-0000-0000-000000000003\",\"name\":\"app_open\",\"props\":{},\"sessionId\":\"$session\",\"ts\":$base}," +
                "{\"id\":\"00000000-0000-0000-0000-000000000004\",\"name\":\"session_start\",\"props\":{},\"sessionId\":\"$session\",\"ts\":$base}]," +
                "\"installId\":\"$INSTALL_ID\",\"locale\":\"en_US\",\"osVersion\":\"15\"}",
            sent.body,
        )
        assertTrue(tracker.pending().isEmpty())
    }

    @Test
    fun firstOpenOnlyOnceAndNotForExistingInstalls() = runTest {
        val transport = FakeTransport()
        val store = MemoryKeyValueStore()
        tracker(transport, store).handle(EventCommand.Launch(base, existingInstall = false))
        runCurrent()
        tracker(transport, store).handle(EventCommand.Launch(base, existingInstall = false))
        runCurrent()
        val upgrader = tracker(transport, MemoryKeyValueStore())
        upgrader.handle(EventCommand.Launch(base, existingInstall = true))
        runCurrent()
        val all = transport.posts("events").flatMap(::names)
        assertEquals(1, all.count { it == "first_open" })
        assertEquals(3, all.count { it == "app_open" })
    }

    @Test
    fun customEventsWaitForTheTimerOrThreshold() = runTest {
        val transport = FakeTransport()
        val tracker = tracker(transport)
        tracker.handle(EventCommand.Track(EventSanitizer.event("onboarding_step", mapOf("step" to 2), base)!!))
        runCurrent()
        assertTrue(transport.posts("events").isEmpty())
        testScheduler.advanceTimeBy(EventTracker.FLUSH_INTERVAL_MS + 1)
        runCurrent()
        assertEquals(listOf("onboarding_step"), names(transport.posts("events").single()))

        repeat(EventTracker.FLUSH_THRESHOLD) { tracker.handle(EventCommand.Track(EventSanitizer.event("tap", emptyMap(), base)!!)) }
        runCurrent()
        assertEquals(2, transport.posts("events").size)
        assertEquals(50, names(transport.posts("events")[1]).size)
    }

    @Test
    fun batchesHoldAtMost200Events() = runTest {
        val transport = FakeTransport()
        val storage = MemoryEventStorage()
        storage.append((1..450).map { QueuedEvent("id-$it", "e", base, "s", emptyMap()) })
        val tracker = tracker(transport, storage = storage)
        tracker.handle(EventCommand.Background(base))
        runCurrent()
        assertEquals(listOf(200, 200, 51), transport.posts("events").map { names(it).size })
        assertTrue(storage.load().isEmpty())
    }

    @Test
    fun serverErrorsBackOffAndKeepTheQueue() = runTest {
        val transport = FakeTransport { status(503) }
        val tracker = tracker(transport)
        tracker.handle(EventCommand.Launch(base, existingInstall = true))
        runCurrent()
        assertEquals(1, transport.posts("events").size)
        assertEquals(2, tracker.pending().size)
        assertEquals(base + 5_000, tracker.retryAt)
        testScheduler.advanceTimeBy(4_000)
        runCurrent()
        assertEquals(1, transport.posts("events").size)
        transport.handler = { ok() }
        testScheduler.advanceTimeBy(1_500)
        runCurrent()
        assertEquals(2, transport.posts("events").size)
        assertTrue(tracker.pending().isEmpty())
    }

    @Test
    fun retryAfterIsHonoured() = runTest {
        val transport = FakeTransport { status(429, headers = mapOf("Retry-After" to "120")) }
        val tracker = tracker(transport)
        tracker.handle(EventCommand.Launch(base, existingInstall = true))
        runCurrent()
        assertEquals(base + 120_000, tracker.retryAt)
    }

    @Test
    fun clientErrorsDropTheBatch() = runTest {
        val transport = FakeTransport { status(400, "bad") }
        val tracker = tracker(transport)
        tracker.handle(EventCommand.Launch(base, existingInstall = true))
        runCurrent()
        assertTrue(tracker.pending().isEmpty())
        assertNull(tracker.retryAt)
    }

    @Test
    fun networkErrorsAreRetried() = runTest {
        val transport = FakeTransport { networkError() }
        val tracker = tracker(transport)
        tracker.handle(EventCommand.Launch(base, existingInstall = true))
        runCurrent()
        assertEquals(2, tracker.pending().size)
    }

    @Test
    fun analyticsOffDropsTheQueueAndRecordsNothing() = runTest {
        val transport = FakeTransport { status(503) }
        val store = MemoryKeyValueStore()
        val tracker = tracker(transport, store)
        tracker.handle(EventCommand.Launch(base, existingInstall = true))
        runCurrent()
        tracker.handle(EventCommand.SetEnabled(false))
        assertTrue(tracker.pending().isEmpty())
        tracker.handle(EventCommand.Track(EventSanitizer.event("tap", emptyMap(), base)!!))
        assertTrue(tracker.pending().isEmpty())
        // Stored "0": a new tracker starts disabled.
        store.set(EventTracker.ENABLED_KEY, "0")
        assertFalse(tracker(transport, store).isEnabled)
    }

    @Test
    fun longBackgroundStartsANewSession() = runTest {
        val transport = FakeTransport()
        val tracker = tracker(transport)
        tracker.handle(EventCommand.Launch(base, existingInstall = true))
        val first = tracker.sessionId
        tracker.handle(EventCommand.Background(base + 1000))
        tracker.handle(EventCommand.Foreground(base + 5 * 60_000))
        assertEquals(first, tracker.sessionId)
        tracker.handle(EventCommand.Background(base + 6 * 60_000))
        tracker.handle(EventCommand.Foreground(base + 40 * 60_000))
        runCurrent()
        assertTrue(first != tracker.sessionId)
        assertTrue(tracker.pending().any { it.name == "session_start" && it.sessionId == tracker.sessionId })
    }

    @Test
    fun backgroundCallsDoneAfterTheFlush() = runTest {
        val transport = FakeTransport()
        val tracker = tracker(transport)
        var done = false
        tracker.handle(EventCommand.Background(base) { done = true })
        runCurrent()
        assertTrue(done)
        assertEquals(listOf("app_background"), names(transport.posts("events").single()))
    }

    @Test
    fun sanitizerAppliesTheServerLimits() {
        assertNull(EventSanitizer.event("bad name", emptyMap(), 0))
        assertNull(EventSanitizer.event("x".repeat(65), emptyMap(), 0))
        val props = EventSanitizer.props(
            mapOf(
                "step" to 2, "ratio" to 2.5, "whole" to 3.0, "on" to true, "text" to "é".repeat(150), "bad key" to "x",
                "list" to listOf(1), "nan" to Double.NaN, "id" to UUID(0, 1), "nil" to null,
            ),
        )
        assertEquals(mapOf("id" to "00000000-0000-0000-0000-000000000001", "on" to "true", "ratio" to "2.5", "step" to "2", "text" to "é".repeat(100), "whole" to "3"), props)
        val many = EventSanitizer.props((1..12).associate { "k%02d".format(it) to it })
        assertEquals((1..10).map { "k%02d".format(it) }, many.keys.toList())
        // Never splits a surrogate pair.
        assertEquals(99, EventSanitizer.truncate("a".repeat(99) + "😀").length)
    }

    @Test
    fun fileStorageSurvivesACutLine() {
        val file = File.createTempFile("events", ".jsonl")
        file.writeText(QueuedEvent("a", "e", 1, "s", mapOf("k" to "v")).toJson().toJsonString() + "\n{\"id\":\"b\",\"na")
        val storage = FileEventStorage(file)
        val loaded = storage.load()
        assertEquals(listOf("a"), loaded.map { it.id })
        assertTrue(file.readText().endsWith("\n"))
        storage.append(listOf(QueuedEvent("c", "e", 2, "s", emptyMap())))
        assertEquals(listOf("a", "c"), FileEventStorage(file).load().map { it.id })
        file.delete()
    }
}

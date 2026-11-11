package app.revflare.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SupportTest {
    @Test
    fun environmentDetection() {
        assertEquals(RevflareEnvironment.DEBUG, EnvironmentDetector.resolve(RevflareEnvironment.AUTOMATIC, debuggable = true))
        assertEquals(RevflareEnvironment.PRODUCTION, EnvironmentDetector.resolve(RevflareEnvironment.AUTOMATIC, debuggable = false))
        assertEquals(RevflareEnvironment.SANDBOX, EnvironmentDetector.resolve(RevflareEnvironment.SANDBOX, debuggable = true))
        assertEquals("debug", RevflareEnvironment.DEBUG.wireValue)
    }

    @Test
    fun environmentIsAddedToEveryBody() {
        val request = client(FakeTransport(), "debug").postRequest(RevflareClient.Path.REPORT, RevflareJson.obj("installId" to RevflareJson.Str("x")))
        assertEquals("{\"environment\":\"debug\",\"installId\":\"x\"}", request.body)
        assertEquals("application/json", request.headers["Content-Type"])
        assertEquals("RevflareKit/${Revflare.VERSION} (Android)", request.headers["User-Agent"])
        val none = client(FakeTransport(), null).postRequest(RevflareClient.Path.REPORT, RevflareJson.obj("installId" to RevflareJson.Str("x")))
        assertEquals("{\"installId\":\"x\"}", none.body)
    }

    @Test
    fun jsonRoundTripSortedAndEscaped() {
        val text = "{\"b\":[1,2.5,true,null,\"a/b\"],\"a\":{\"z\":\"line\\nbreak \\\"q\\\" \\u00e9 \\u0001\"}}"
        val parsed = RevflareJson.parse(text)
        assertEquals("{\"a\":{\"z\":\"line\\nbreak \\\"q\\\" é \\u0001\"},\"b\":[1,2.5,true,null,\"a/b\"]}", parsed.toJsonString())
        assertNull(RevflareJson.parseOrNull("{\"a\":}"))
        assertNull(RevflareJson.parseOrNull("[1,2] x"))
        assertEquals(3, RevflareJson.parse("3").intValue)
        assertNull(RevflareJson.Number(2.5).intValue)
        assertEquals(RevflareJson.Object(mapOf("k" to RevflareJson.Array(listOf(RevflareJson.Number(1.0))))), RevflareJson.from(mapOf("k" to listOf(1))))
        assertNull(RevflareJson.from(Any()))
    }

    @Test
    fun reportResponseIsLenient() {
        val response = ReportResponse.parse("{\"ok\":true,\"attribution\":\"resolved\",\"source\":\"google_ads\",\"campaignId\":12,\"adGroupId\":\"\"}")
        assertEquals("12", response.campaignId)
        assertNull(response.adGroupId)
        assertEquals(ReportResponse(), ReportResponse.parse("not json"))
    }

    @Test
    fun attributionSources() {
        assertEquals(RevflareAttribution.Source.UNKNOWN, RevflareAttribution.of("meta_ads", null, null, null).source)
        assertEquals("meta_ads", RevflareAttribution.of("meta_ads", "1", null, null).rawSource)
        assertNull(RevflareAttribution.of("organic", "1", null, null).campaignId)
        assertFalse(RevflareAttribution.UNKNOWN.isResolved)
        assertTrue(RevflareAttribution.of("referral", null, null, null).isResolved)
    }

    @Test
    fun installIdIsStableAndStartsOverAfterABackupRestore() {
        val store = MemoryKeyValueStore()
        val marker = MemoryNoBackupMarker()
        var next = 0
        val ids = listOf("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222")
        val first = InstallIdentity(store, marker) { ids[next++] }.resolve()
        assertEquals(ids[0], first)
        assertEquals(first, InstallIdentity(store, marker) { ids[next++] }.resolve())

        // Preferences restored onto another device: the no-backup file is missing.
        store.set(Reporter.STATE_KEY, "{\"registered\":true}")
        val restored = InstallIdentity(store, MemoryNoBackupMarker()) { ids[next++] }
        val second = restored.resolve()
        assertNotEquals(first, second)
        assertTrue(restored.restoredFromBackup)
        assertNull(store.string(Reporter.STATE_KEY))
    }

    @Test
    fun localesAndExtinfo() {
        assertEquals("en_US", Locales.identifier("en-US"))
        assertEquals("en_US", Locales.identifier("en_US@rg=gbzzzz"))
        assertEquals("zh_CN", Locales.identifier("zh_CN_#Hans"))
        assertEquals("pt_BR", Locales.identifier(java.util.Locale("pt", "BR")))
        val extinfo = sampleDevice().extinfo
        assertEquals(16, extinfo.size)
        assertEquals("a2", extinfo[0])
        assertEquals("42", extinfo[2])
        assertEquals("1.2.0", extinfo[3])
    }
}

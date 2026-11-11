package app.revflare.kit

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** One HTTP request. */
internal data class HttpRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String>,
    val body: String? = null,
)

/** One HTTP answer (header names lowercased). */
internal data class HttpResponse(
    val status: Int,
    val headers: Map<String, String> = emptyMap(),
    val body: String = "",
) {
    fun header(name: String): String? = headers[name.lowercase()]
}

/** Sends HTTP requests (HttpURLConnection in the app, a fake in tests). Throws [IOException] on network errors. */
internal interface Transport {
    suspend fun send(request: HttpRequest): HttpResponse
}

internal class UrlConnectionTransport(
    private val connectTimeoutMs: Int = 20_000,
    private val readTimeoutMs: Int = 20_000,
) : Transport {
    override suspend fun send(request: HttpRequest): HttpResponse = withContext(Dispatchers.IO) {
        val connection = URL(request.url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = request.method
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            connection.useCaches = false
            connection.instanceFollowRedirects = true
            request.headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
            if (request.body != null) {
                val bytes = request.body.toByteArray(Charsets.UTF_8)
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            val headers = connection.headerFields
                .filterKeys { it != null }
                .mapKeys { it.key.lowercase() }
                .mapValues { it.value.joinToString(",") }
            HttpResponse(status, headers, body)
        } finally {
            connection.disconnect()
        }
    }
}

/** Answer of `POST /sdk/v1/report` and `POST /sdk/v1/identifiers`. */
internal data class ReportResponse(
    val ok: Boolean? = null,
    val attribution: String? = null,
    val source: String? = null,
    val campaignId: String? = null,
    val adGroupId: String? = null,
    val keywordId: String? = null,
) {
    companion object {
        fun parse(body: String): ReportResponse {
            val json = RevflareJson.parseOrNull(body) as? RevflareJson.Object ?: return ReportResponse()
            return ReportResponse(
                ok = json["ok"]?.boolValue,
                attribution = text(json["attribution"]),
                source = text(json["source"]),
                campaignId = text(json["campaignId"]),
                adGroupId = text(json["adGroupId"]),
                keywordId = text(json["keywordId"]),
            )
        }

        /** A string, or a whole number written as one (lenient about ids); empty → null. */
        fun text(value: RevflareJson?): String? = when (value) {
            is RevflareJson.Str -> value.value.ifEmpty { null }
            is RevflareJson.Number -> value.longValue?.toString()
            else -> null
        }
    }
}

/** What came of one report. */
internal sealed class ReportOutcome {
    /** 2xx: the server stored the report (an unreadable body decodes as an empty response). */
    data class Accepted(val response: ReportResponse) : ReportOutcome()
    /** 4xx: the server refused it (unknown SDK key, bad input). Retried later with a long backoff. */
    data class Rejected(val status: Int, val message: String) : ReportOutcome()
    /** Network error, timeout, 5xx, 429: retried with backoff. */
    data class Retryable(val message: String) : ReportOutcome()
}

/** Builds and sends requests to one Revflare server. */
internal class RevflareClient(
    server: String,
    val sdkKey: String,
    val transport: Transport,
    /** The resolved environment, added as `"environment"` to every JSON body and config query; null leaves it out. */
    val environment: () -> String? = { null },
) {
    val server: String = server.trimEnd('/')

    enum class Path(val value: String) {
        REPORT("report"), IDENTIFIERS("identifiers"), OFFERINGS("offerings"), EVENTS("events"), CONFIG("config")
    }

    fun url(path: Path): String = "$server/sdk/v1/${path.value}"

    fun url(path: Path, query: List<Pair<String, String>>): String {
        if (query.isEmpty()) return url(path)
        return url(path) + "?" + query.joinToString("&") { (name, value) -> "${encode(name)}=${encode(value)}" }
    }

    private fun encode(value: String): String = URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    private fun baseHeaders(): MutableMap<String, String> = linkedMapOf(
        "Accept" to "application/json",
        "X-Revflare-Key" to sdkKey,
        "User-Agent" to "RevflareKit/${Revflare.VERSION} (Android)",
    )

    /** `POST` with the body plus `"environment"` at its top level. */
    fun postRequest(path: Path, body: RevflareJson.Object): HttpRequest {
        val headers = baseHeaders()
        headers["Content-Type"] = "application/json"
        val env = environment()
        val full = if (env != null) RevflareJson.Object(body.value + ("environment" to RevflareJson.Str(env))) else body
        return HttpRequest("POST", url(path), headers, full.toJsonString())
    }

    fun getRequest(url: String, etag: String?): HttpRequest {
        val headers = baseHeaders()
        if (etag != null) headers["If-None-Match"] = etag
        return HttpRequest("GET", url, headers)
    }

    suspend fun send(path: Path, body: RevflareJson.Object): ReportOutcome {
        val request = postRequest(path, body)
        return try {
            val response = transport.send(request)
            when {
                response.status in 200..299 -> ReportOutcome.Accepted(ReportResponse.parse(response.body))
                response.status == 429 || response.status >= 500 -> ReportOutcome.Retryable("HTTP ${response.status}")
                else -> ReportOutcome.Rejected(response.status, response.body.take(300))
            }
        } catch (error: Exception) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            ReportOutcome.Retryable(error.toString())
        }
    }
}

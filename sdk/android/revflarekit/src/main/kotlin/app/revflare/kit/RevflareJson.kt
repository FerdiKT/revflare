package app.revflare.kit

/**
 * A JSON value: the free-form metadata of offerings and packages (titles, colors, layout keys...) and remote config
 * values set in Revflare.
 *
 * ```kotlin
 * offering.metadata["title"]?.stringValue        // "Go Pro"
 * offering.metadata["features"]?.arrayValue      // [Str("No ads"), ...]
 * Revflare.remoteConfig.json("paywall")?.get("title")?.stringValue
 * ```
 */
public sealed class RevflareJson {
    public object Null : RevflareJson()
    public data class Bool(val value: Boolean) : RevflareJson()
    public data class Number(val value: Double) : RevflareJson()
    public data class Str(val value: String) : RevflareJson()
    public data class Array(val value: List<RevflareJson>) : RevflareJson()
    public data class Object(val value: Map<String, RevflareJson>) : RevflareJson()

    /** The string, or null when the value is not a string. */
    public val stringValue: String? get() = (this as? Str)?.value

    /** The number, or null when the value is not a number. */
    public val numberValue: Double? get() = (this as? Number)?.value

    /** The number as a `Long` when it is a whole number, else null. */
    public val longValue: Long?
        get() {
            val number = (this as? Number)?.value ?: return null
            if (!number.isFinite() || Math.rint(number) != number || Math.abs(number) >= 9.0e15) return null
            return number.toLong()
        }

    /** The number as an `Int` when it is a whole number in range, else null. */
    public val intValue: Int?
        get() = longValue?.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()

    /** The boolean, or null when the value is not a boolean. */
    public val boolValue: Boolean? get() = (this as? Bool)?.value

    /** The array, or null when the value is not an array. */
    public val arrayValue: List<RevflareJson>? get() = (this as? Array)?.value

    /** The object, or null when the value is not an object. */
    public val objectValue: Map<String, RevflareJson>? get() = (this as? Object)?.value

    public val isNull: Boolean get() = this === Null

    /** The value at `key` when this is an object. */
    public operator fun get(key: String): RevflareJson? = objectValue?.get(key)

    /** The element at `index` when this is an array (null when out of range). */
    public operator fun get(index: Int): RevflareJson? = arrayValue?.getOrNull(index)

    /** Compact JSON text, object keys sorted, slashes not escaped. */
    public fun toJsonString(): String = StringBuilder().also { JsonWriter.write(this, it) }.toString()

    override fun toString(): String = toJsonString()

    public companion object {
        /** Parses JSON text; throws [IllegalArgumentException] when it is not valid JSON. */
        @JvmStatic
        public fun parse(text: String): RevflareJson = JsonParser(text).parseDocument()

        /** Parses JSON text, or null when it is not valid JSON. */
        @JvmStatic
        public fun parseOrNull(text: String): RevflareJson? = try {
            parse(text)
        } catch (_: IllegalArgumentException) {
            null
        }

        /**
         * Converts a Kotlin value: `String`, `Boolean`, numbers, `Map<String, *>`, `List<*>` / arrays, `null`,
         * [RevflareJson]. Returns null for anything else.
         */
        @JvmStatic
        public fun from(value: Any?): RevflareJson? = when (value) {
            null -> Null
            is RevflareJson -> value
            is String -> Str(value)
            is Boolean -> Bool(value)
            is Int -> Number(value.toDouble())
            is Long -> Number(value.toDouble())
            is Short -> Number(value.toDouble())
            is Byte -> Number(value.toDouble())
            is Double -> if (value.isFinite()) Number(value) else null
            is Float -> if (value.isFinite()) Number(value.toDouble()) else null
            is java.math.BigDecimal -> Number(value.toDouble())
            is java.math.BigInteger -> Number(value.toDouble())
            is Map<*, *> -> {
                val result = LinkedHashMap<String, RevflareJson>()
                var ok = true
                for ((key, item) in value) {
                    val converted = from(item)
                    if (key !is String || converted == null) {
                        ok = false
                        break
                    }
                    result[key] = converted
                }
                if (ok) Object(result) else null
            }
            is Iterable<*> -> {
                val items = value.map { from(it) }
                if (items.any { it == null }) null else Array(items.map { it!! })
            }
            is kotlin.Array<*> -> from(value.toList())
            else -> null
        }

        /** Builds an object, leaving out null values (use [Null] for an explicit JSON null). */
        internal fun obj(vararg pairs: Pair<String, RevflareJson?>): Object =
            Object(pairs.filter { it.second != null }.associate { it.first to it.second!! })

        internal fun str(value: String?): RevflareJson? = value?.let { Str(it) }
        internal fun strOrNull(value: String?): RevflareJson = value?.let { Str(it) } ?: Null
        internal fun num(value: Long?): RevflareJson? = value?.let { Number(it.toDouble()) }
        internal fun strings(values: List<String>): Array = Array(values.map { Str(it) })
    }
}

/** Whole numbers without a decimal point ("2", not "2.0"). */
internal fun formatNumber(number: Double): String {
    if (number.isFinite() && Math.rint(number) == number && Math.abs(number) < 1e15) return number.toLong().toString()
    return number.toString()
}

internal object JsonWriter {
    fun write(value: RevflareJson, out: StringBuilder) {
        when (value) {
            RevflareJson.Null -> out.append("null")
            is RevflareJson.Bool -> out.append(if (value.value) "true" else "false")
            is RevflareJson.Number -> out.append(if (value.value.isFinite()) formatNumber(value.value) else "null")
            is RevflareJson.Str -> writeString(value.value, out)
            is RevflareJson.Array -> {
                out.append('[')
                value.value.forEachIndexed { index, item ->
                    if (index > 0) out.append(',')
                    write(item, out)
                }
                out.append(']')
            }
            is RevflareJson.Object -> {
                out.append('{')
                value.value.keys.sorted().forEachIndexed { index, key ->
                    if (index > 0) out.append(',')
                    writeString(key, out)
                    out.append(':')
                    write(value.value.getValue(key), out)
                }
                out.append('}')
            }
        }
    }

    fun writeString(text: String, out: StringBuilder) {
        out.append('"')
        for (char in text) {
            when (char) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                '\b' -> out.append("\\b")
                '\u000C' -> out.append("\\f")
                else -> if (char < ' ') out.append(String.format("\\u%04x", char.code)) else out.append(char)
            }
        }
        out.append('"')
    }
}

internal class JsonParser(private val text: String) {
    private var index = 0

    fun parseDocument(): RevflareJson {
        skipWhitespace()
        val value = parseValue(0)
        skipWhitespace()
        if (index != text.length) fail("trailing characters")
        return value
    }

    private fun fail(message: String): Nothing = throw IllegalArgumentException("Invalid JSON at $index: $message")

    private fun skipWhitespace() {
        while (index < text.length && text[index].let { it == ' ' || it == '\n' || it == '\r' || it == '\t' }) index++
    }

    private fun parseValue(depth: Int): RevflareJson {
        if (depth > 200) fail("too deep")
        if (index >= text.length) fail("unexpected end")
        return when (val char = text[index]) {
            '{' -> parseObject(depth)
            '[' -> parseArray(depth)
            '"' -> RevflareJson.Str(parseString())
            't' -> literal("true", RevflareJson.Bool(true))
            'f' -> literal("false", RevflareJson.Bool(false))
            'n' -> literal("null", RevflareJson.Null)
            else -> if (char == '-' || char.isDigit()) parseNumber() else fail("unexpected '$char'")
        }
    }

    private fun literal(word: String, value: RevflareJson): RevflareJson {
        if (!text.startsWith(word, index)) fail("expected $word")
        index += word.length
        return value
    }

    private fun parseObject(depth: Int): RevflareJson {
        index++
        val result = LinkedHashMap<String, RevflareJson>()
        skipWhitespace()
        if (index < text.length && text[index] == '}') {
            index++
            return RevflareJson.Object(result)
        }
        while (true) {
            skipWhitespace()
            if (index >= text.length || text[index] != '"') fail("expected a key")
            val key = parseString()
            skipWhitespace()
            if (index >= text.length || text[index] != ':') fail("expected ':'")
            index++
            skipWhitespace()
            result[key] = parseValue(depth + 1)
            skipWhitespace()
            if (index >= text.length) fail("unexpected end")
            when (text[index]) {
                ',' -> index++
                '}' -> {
                    index++
                    return RevflareJson.Object(result)
                }
                else -> fail("expected ',' or '}'")
            }
        }
    }

    private fun parseArray(depth: Int): RevflareJson {
        index++
        val result = ArrayList<RevflareJson>()
        skipWhitespace()
        if (index < text.length && text[index] == ']') {
            index++
            return RevflareJson.Array(result)
        }
        while (true) {
            skipWhitespace()
            result.add(parseValue(depth + 1))
            skipWhitespace()
            if (index >= text.length) fail("unexpected end")
            when (text[index]) {
                ',' -> index++
                ']' -> {
                    index++
                    return RevflareJson.Array(result)
                }
                else -> fail("expected ',' or ']'")
            }
        }
    }

    private fun parseString(): String {
        index++
        val out = StringBuilder()
        while (true) {
            if (index >= text.length) fail("unterminated string")
            val char = text[index++]
            when {
                char == '"' -> return out.toString()
                char == '\\' -> {
                    if (index >= text.length) fail("bad escape")
                    when (val escaped = text[index++]) {
                        '"' -> out.append('"')
                        '\\' -> out.append('\\')
                        '/' -> out.append('/')
                        'b' -> out.append('\b')
                        'f' -> out.append('\u000C')
                        'n' -> out.append('\n')
                        'r' -> out.append('\r')
                        't' -> out.append('\t')
                        'u' -> {
                            if (index + 4 > text.length) fail("bad unicode escape")
                            val code = text.substring(index, index + 4).toIntOrNull(16) ?: fail("bad unicode escape")
                            out.append(code.toChar())
                            index += 4
                        }
                        else -> fail("bad escape '$escaped'")
                    }
                }
                char < ' ' -> fail("control character in string")
                else -> out.append(char)
            }
        }
    }

    private fun parseNumber(): RevflareJson {
        val start = index
        if (text[index] == '-') index++
        while (index < text.length && text[index].let { it.isDigit() || it == '.' || it == 'e' || it == 'E' || it == '+' || it == '-' }) {
            index++
        }
        val number = text.substring(start, index).toDoubleOrNull() ?: fail("bad number")
        return RevflareJson.Number(number)
    }
}

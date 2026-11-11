package app.revflare.kit

/**
 * How this install was acquired, as Revflare resolved it from the Play Install Referrer ([Revflare.attribution]).
 * Remote config conditions can target it (`source`, `campaign`).
 */
public data class RevflareAttribution(
    /** The source as the server sent it (`google_ads`, `referral`, `organic`, `unknown`...). */
    val rawSource: String,
    /** The campaign id when the server resolved one (attributed sources only). */
    val campaignId: String? = null,
    val adGroupId: String? = null,
    val keywordId: String? = null,
) {
    public enum class Source(public val wireValue: String) {
        /** A Google Ads click (`gclid` in the referrer). */
        GOOGLE_ADS("google_ads"),
        /** A link with a `utm_source` other than Google Play's own. */
        REFERRAL("referral"),
        /** An Apple Ads campaign (iOS only; kept for parity). */
        APPLE_ADS("apple_ads"),
        /** The Play Store itself, or no referrer. */
        ORGANIC("organic"),
        /** Not known yet (the first report has not been answered), or a source this version does not know. */
        UNKNOWN("unknown");

        public companion object {
            @JvmStatic
            public fun from(raw: String?): Source = entries.firstOrNull { it.wireValue == raw } ?: UNKNOWN
        }
    }

    /** The source, [Source.UNKNOWN] for values this version does not know (see [rawSource]). */
    val source: Source get() = Source.from(rawSource)

    /** Resolution reached: nothing more will change. */
    val isResolved: Boolean get() = rawSource != Source.UNKNOWN.wireValue

    public companion object {
        @JvmField
        public val UNKNOWN: RevflareAttribution = RevflareAttribution(Source.UNKNOWN.wireValue)

        internal fun of(source: String?, campaignId: String?, adGroupId: String?, keywordId: String?): RevflareAttribution {
            val raw = source?.trim()?.ifEmpty { null } ?: return UNKNOWN
            val attributed = raw != Source.ORGANIC.wireValue && raw != Source.UNKNOWN.wireValue
            fun clean(value: String?) = value?.trim()?.ifEmpty { null }?.takeIf { attributed }
            return RevflareAttribution(raw, clean(campaignId), clean(adGroupId), clean(keywordId))
        }
    }
}

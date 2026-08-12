package ovh.delhomme.ytmusic.data

import com.squareup.moshi.FromJson
import com.squareup.moshi.JsonReader
import com.squareup.moshi.JsonWriter
import com.squareup.moshi.ToJson
import kotlin.math.roundToInt

/**
 * Accepte number | string | null pour les champs [Int]/[Int?].
 * Couvre les sous-titres YTM du type « 180K views - 27 tracks - 1 hour ».
 */
class FlexibleIntAdapter {
    @FromJson
    fun fromJson(reader: JsonReader): Int? {
        return when (reader.peek()) {
            JsonReader.Token.NULL -> {
                reader.nextNull<Unit>()
                null
            }
            JsonReader.Token.NUMBER -> {
                val n = reader.nextDouble()
                if (!n.isFinite()) null else n.roundToInt()
            }
            JsonReader.Token.STRING -> parseTrackCount(reader.nextString())
            JsonReader.Token.BOOLEAN -> {
                reader.nextBoolean()
                null
            }
            else -> {
                reader.skipValue()
                null
            }
        }
    }

    @ToJson
    fun toJson(writer: JsonWriter, value: Int?) {
        if (value == null) writer.nullValue() else writer.value(value)
    }

    companion object {
        private val TRACKS_RE = Regex("""(\d[\d\s]*)\s*tracks?""", RegexOption.IGNORE_CASE)
        private val PLAIN_RE = Regex("""^\s*(\d+)\s*$""")

        fun parseTrackCount(raw: String?): Int? {
            if (raw.isNullOrBlank()) return null
            PLAIN_RE.find(raw)?.groupValues?.getOrNull(1)?.toIntOrNull()?.let { return it }
            TRACKS_RE.find(raw)?.groupValues?.getOrNull(1)
                ?.replace("\\s".toRegex(), "")
                ?.toIntOrNull()
                ?.let { return it }
            return null
        }
    }
}

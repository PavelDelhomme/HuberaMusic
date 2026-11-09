package ovh.delhomme.ytmusic.data

/** Dernière pochette connue par id, pour ne pas perdre l’image si le payload pin arrive sans miniature. */
object ThumbLedger {
    private const val MAX = 400
    private val mem = object : LinkedHashMap<String, String>(128, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?) = size > MAX
    }

    fun remember(id: String, url: String?) {
        if (id.isBlank() || url.isNullOrBlank()) return
        synchronized(mem) { mem[id] = url }
    }

    fun get(id: String): String? = synchronized(mem) { mem[id] }
}

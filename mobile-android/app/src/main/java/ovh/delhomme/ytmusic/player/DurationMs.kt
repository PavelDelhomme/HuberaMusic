package ovh.delhomme.ytmusic.player

/**
 * Choisit une durée de lecture fiable.
 *
 * ExoPlayer (flux progressif googlevideo) annonce parfois une durée **trop courte**
 * (chunk / content-length / moov incomplet) alors que la position a déjà dépassé
 * ou que le catalogue YTM indique ~3–5 min. On privilégie alors le catalogue.
 */
fun pickSaneDurationMs(
    exoMs: Long?,
    catalogMs: Long?,
    fallbackMs: Long? = null,
    positionMs: Long = 0L,
): Long {
    val exo = exoMs?.takeIf { it >= 1_000L }
    val catalog = catalogMs?.takeIf { it >= 1_000L }
    val fallback = fallbackMs?.takeIf { it >= 1_000L }
    val pos = positionMs.coerceAtLeast(0L)

    if (exo != null) {
        // Durée déjà dépassée par la tête de lecture → invalide
        if (pos > 0L && exo < pos - 2_000L) {
            val rescue = listOfNotNull(catalog, fallback)
                .maxOrNull()
                ?.coerceAtLeast(pos + 30_000L)
            return rescue ?: (pos + 30_000L)
        }
        // Exo nettement plus court que le catalogue YTM → méta catalogue
        if (catalog != null && catalog >= 45_000L && exo < (catalog * 0.6).toLong()) {
            return catalog
        }
        return exo
    }
    return catalog ?: fallback ?: 0L
}

/** True si [exoMs] est probablement une durée tronquée / fausse. */
fun isSuspiciousExoDuration(
    exoMs: Long,
    catalogMs: Long?,
    positionMs: Long = 0L,
): Boolean {
    if (exoMs < 1_000L) return true
    if (positionMs > 0L && exoMs < positionMs - 2_000L) return true
    val cat = catalogMs?.takeIf { it >= 45_000L } ?: return false
    return exoMs < (cat * 0.6).toLong()
}

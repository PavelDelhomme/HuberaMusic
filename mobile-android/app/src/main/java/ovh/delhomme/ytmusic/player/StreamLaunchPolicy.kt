package ovh.delhomme.ytmusic.player

/**
 * Au lancement, le titre courant finit sa propre tête avant tout suivant.
 * À chaud (tête prête, pas de quiet) : 2 suivants en préfixe (têtes), jamais 4–8
 * fichiers entiers — disque complet seulement hors lecture (allowFullFileDownload).
 */
object StreamLaunchPolicy {
    /** Préfixe chaud : courant prêt → 2 suivants (roadmap cache + enchaînement). */
    const val WARM_PREFIX_AHEAD = 2

    fun mayStartUpcoming(
        currentReady: Boolean,
        currentLoading: Boolean,
        quiet: Boolean = false,
    ): Boolean = currentReady && !currentLoading && !quiet

    fun upcomingCount(
        requestedAhead: Int,
        currentReady: Boolean,
        currentLoading: Boolean,
        playbackActive: Boolean,
        quiet: Boolean = false,
    ): Int {
        if (currentLoading || quiet || requestedAhead <= 0) return 0
        // Tête du titre courant pas prête : ne pas voler le réseau (play ou pause).
        if (!currentReady) return 0
        return minOf(requestedAhead, WARM_PREFIX_AHEAD)
    }

    /** Pas de fichier entier (cache disque serveur / hors-ligne opportuniste) pendant l'écoute. */
    fun allowFullFileDownload(playbackActive: Boolean): Boolean = !playbackActive
}

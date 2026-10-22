package ovh.delhomme.ytmusic.player

/**
 * Au lancement, le titre déjà détecté finit sa propre tête avant tout suivant.
 * À chaud (lecture en cours, tête prête, pas de quiet) : un seul prochain titre,
 * en préfixe — jamais 4 à 8 fichiers entiers.
 */
object StreamLaunchPolicy {
    const val WARM_PREFIX_AHEAD = 1

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
        // Lecture en cours et tête du titre courant pas prête : ne pas lui voler le réseau.
        // En pause, un seul suivant se prépare quand même, pour enchaîner sans trou.
        if (!currentReady && playbackActive) return 0
        return WARM_PREFIX_AHEAD
    }

    /** Pas de fichier entier (cache disque serveur / hors-ligne opportuniste) pendant l'écoute. */
    fun allowFullFileDownload(playbackActive: Boolean): Boolean = !playbackActive
}

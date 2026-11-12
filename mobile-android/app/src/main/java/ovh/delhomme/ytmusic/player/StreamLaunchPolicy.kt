package ovh.delhomme.ytmusic.player

/**
 * Politique de préchargement des titres suivants.
 *
 * Objectif (retour Paul) : pendant que le titre courant joue, on précharge en
 * parallèle les suivants pour que « Suivant » soit quasi instantané — y compris
 * quand le courant n'a pas encore fini de remplir sa propre tête.
 */
object StreamLaunchPolicy {
    /** Préfixe chaud : courant prêt → jusqu'à 5 suivants (enchaînement + skip). */
    const val WARM_PREFIX_AHEAD = 5

    /**
     * Même pendant que le courant charge, on garde 2 suivants chauds en parallèle :
     * sinon un « Suivant » tombe toujours sur un titre à froid.
     */
    const val LOADING_PREFIX_AHEAD = 2

    fun mayStartUpcoming(
        currentReady: Boolean,
        currentLoading: Boolean,
        quiet: Boolean = false,
    ): Boolean = !quiet && (currentReady || !currentLoading)

    fun upcomingCount(
        requestedAhead: Int,
        currentReady: Boolean,
        currentLoading: Boolean,
        playbackActive: Boolean,
        quiet: Boolean = false,
    ): Int {
        if (quiet || requestedAhead <= 0) return 0
        // Courant pas encore prêt : on précharge quand même 1–2 suivants (parallèle),
        // l'objectif étant que « Suivant » ne soit jamais à froid.
        if (!currentReady) return minOf(requestedAhead, LOADING_PREFIX_AHEAD)
        return minOf(requestedAhead, WARM_PREFIX_AHEAD)
    }

    /** Pas de fichier entier (cache disque serveur / hors-ligne opportuniste) pendant l'écoute. */
    fun allowFullFileDownload(playbackActive: Boolean): Boolean = !playbackActive
}


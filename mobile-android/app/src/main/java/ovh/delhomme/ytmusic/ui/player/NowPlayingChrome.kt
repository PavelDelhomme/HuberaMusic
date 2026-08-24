package ovh.delhomme.ytmusic.ui.player

/**
 * Slots d’actions du Now Playing — liste ordonnée, facile à ajouter / retirer / réordonner.
 * L’UI lit uniquement cette config ; le comportement est branché par [PlayerChromeAction.id].
 */
enum class PlayerChromeAction {
    Like,
    Lyrics,
    AddToPlaylist,
    Download,
    Mix,
    Equalizer,
    Speed,
    Shuffle,
    Previous,
    PlayPause,
    Next,
    Repeat,
    Cast,
    More,
    SaveQueue,
}

data class ChromeSlot(
    val id: PlayerChromeAction,
    val label: String,
    val enabled: Boolean = true,
)

object NowPlayingChrome {
    /** Sous le titre / artiste. */
    val secondaryActions: List<ChromeSlot> = listOf(
        ChromeSlot(PlayerChromeAction.Like, "J'aime"),
        ChromeSlot(PlayerChromeAction.Lyrics, "Paroles"),
        ChromeSlot(PlayerChromeAction.AddToPlaylist, "Playlist"),
        ChromeSlot(PlayerChromeAction.Download, "Télécharger"),
        ChromeSlot(PlayerChromeAction.Mix, "Mix"),
        ChromeSlot(PlayerChromeAction.Equalizer, "Égaliseur"),
        ChromeSlot(PlayerChromeAction.Speed, "Vitesse"),
    )

    /** Sous la barre de seek. */
    val transportActions: List<ChromeSlot> = listOf(
        ChromeSlot(PlayerChromeAction.Shuffle, "Aléatoire"),
        ChromeSlot(PlayerChromeAction.Previous, "Précédent"),
        ChromeSlot(PlayerChromeAction.PlayPause, "Lecture"),
        ChromeSlot(PlayerChromeAction.Next, "Suivant"),
        ChromeSlot(PlayerChromeAction.Repeat, "Boucle"),
    )

    /** Barre du haut (plein écran) — Cast est dans le menu ⋮. */
    val topBarActions: List<ChromeSlot> = listOf(
        ChromeSlot(PlayerChromeAction.More, "Plus"),
    )
}

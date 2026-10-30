package cloud.hubera.chrome

/**
 * Hubera ID absent : l’autre app ouvre l’app ou son OTA.
 * Jamais d’installation silencieuse.
 */
object IdAbsentCta {
    const val PACKAGE = "cloud.hubera.id"
    const val OTA_HOST = "id.hubera.cloud"

    enum class Action {
        OPEN_APP,
        OFFER_OTA,
    }

    fun choose(idInstalled: Boolean): Action =
        if (idInstalled) Action.OPEN_APP else Action.OFFER_OTA
}

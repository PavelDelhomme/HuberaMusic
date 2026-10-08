package cloud.hubera.id.sso

/**
 * Paquets Hubera + héritage Cloudity, même signature labo.
 * Sans cette liste (et les &lt;queries&gt; du manifeste), Android 11+ cache les peers.
 */
object HuberaIdPeers {
    const val ACCOUNT_TYPE = "cloud.hubera.id"
    const val TOKEN_ACCESS = "access"
    const val TOKEN_REFRESH = "refresh"
    const val PERM_READ = "cloud.hubera.permission.READ_ID_ACCOUNT"
    const val PERM_WRITE = "cloud.hubera.permission.WRITE_ID_ACCOUNT"
    const val CLOUDITY_READ = "fr.cloudity.permission.READ_AUTH_BROKER"
    const val CLOUDITY_WRITE = "fr.cloudity.permission.WRITE_AUTH_BROKER"

    val packages: List<String> = listOf(
        "cloud.hubera.id",
        "cloud.hubera.music",
        "cloud.hubera.music.dev",
        "cloud.hubera.music.preprod",
        "ovh.delhomme.ytmusic",
        "cloud.hubera.docs",
        "cloud.hubera.maps",
        "ovh.delhomme.maps",
        "cloud.hubera.fuel",
        "cloud.hubera.pass",
        "cloud.hubera.mail",
        "cloud.hubera.drive",
        "cloud.hubera.photos",
        "cloud.hubera.calendar",
        "cloud.hubera.contacts",
        "cloud.hubera.notes",
        "cloud.hubera.tasks",
        "cloud.hubera.cook",
        "cloud.hubera.admin",
        "cloud.hubera.jobs",
        "cloud.hubera.jobs.dev",
        "cloud.hubera.jobs.preprod",
        "cloud.hubera.office",
        "cloud.hubera.row",
        "cloud.hubera.office.docs",
        "cloud.hubera.slides",
        "cloud.hubera.budget",
        "cloud.hubera.stream",
        "cloud.hubera.cms",
        "fr.cloudity.cloudity_mail",
        "fr.cloudity.cloudity_drive",
        "fr.cloudity.cloudity_photos",
        "com.cloudity.cloudity_pass",
        "fr.cloudity.cloudity_calendar",
        "fr.cloudity.cloudity_contacts",
        "fr.cloudity.cloudity_notes",
        "fr.cloudity.cloudity_tasks",
        "fr.cloudity.cloudity_cook",
        "fr.cloudity.admin_app",
    )

    fun huberaAuthority(packageName: String): String = "$packageName.hubera.id"

    fun cloudityAuthority(packageName: String): String = "$packageName.cloudity.auth"
}

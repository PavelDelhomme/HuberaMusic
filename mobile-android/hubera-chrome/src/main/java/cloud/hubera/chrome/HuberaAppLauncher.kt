package cloud.hubera.chrome

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build

/**
 * Ouvre l’app Android Hubera installée (package Hubera puis legacy), sinon le site.
 * Jamais Custom Tabs / Chrome si un paquet est présent.
 */
object HuberaAppLauncher {

    data class Spec(
        val slug: String,
        val host: String,
        val packages: List<String>,
        val scheme: String = "hubera-$slug",
    )

    val catalog: List<Spec> = listOf(
        Spec("music", "music.hubera.cloud", listOf("cloud.hubera.music", "ovh.delhomme.ytmusic")),
        Spec("maps", "maps.hubera.cloud", listOf("cloud.hubera.maps", "ovh.delhomme.maps")),
        Spec("fuel", "fuel.hubera.cloud", listOf("cloud.hubera.fuel", "com.gasoiltracking.app")),
        Spec("docs", "docs.hubera.cloud", listOf("cloud.hubera.docs", "ovh.delhomme.hubera.docs")),
        Spec("calendar", "calendar.hubera.cloud", listOf("cloud.hubera.calendar", "fr.cloudity.cloudity_calendar")),
        Spec("drive", "drive.hubera.cloud", listOf("cloud.hubera.drive", "fr.cloudity.cloudity_drive")),
        Spec("mail", "mail.hubera.cloud", listOf("cloud.hubera.mail", "fr.cloudity.cloudity_mail")),
        Spec("pass", "pass.hubera.cloud", listOf("cloud.hubera.pass", "com.cloudity.cloudity_pass")),
        Spec("jobs", "jobs.hubera.cloud", listOf("cloud.hubera.jobs", "ovh.delhomme.jobbingtrack")),
        Spec("id", "id.hubera.cloud", listOf("cloud.hubera.id")),
        Spec("tasks", "tasks.hubera.cloud", listOf("cloud.hubera.tasks", "fr.cloudity.cloudity_tasks")),
        Spec("contacts", "contacts.hubera.cloud", listOf("cloud.hubera.contacts", "fr.cloudity.cloudity_contacts")),
        Spec("photos", "photos.hubera.cloud", listOf("cloud.hubera.photos", "fr.cloudity.cloudity_photos")),
        Spec("notes", "notes.hubera.cloud", listOf("cloud.hubera.notes", "fr.cloudity.cloudity_notes")),
        Spec("cook", "cook.hubera.cloud", listOf("cloud.hubera.cook", "fr.cloudity.cloudity_cook")),
        Spec("office", "office.hubera.cloud", listOf("cloud.hubera.office.docs")),
        Spec("budget", "budget.hubera.cloud", listOf("cloud.hubera.budget")),
        Spec("stream", "stream.hubera.cloud", listOf("cloud.hubera.stream")),
    )

    fun spec(slug: String): Spec? = catalog.find { it.slug.equals(slug, ignoreCase = true) }

    fun openOrWeb(context: Context, slug: String) {
        val spec = spec(slug) ?: Spec(slug, "$slug.hubera.cloud", listOf("cloud.hubera.$slug"))
        openOrWeb(context, spec)
    }

    fun openOrWeb(context: Context, spec: Spec) {
        for (pkg in spec.packages) {
            if (startInstalled(context, pkg)) return
        }
        if (startScheme(context, spec.scheme)) return
        openHttps(context, spec.host)
    }

    private fun startInstalled(context: Context, pkg: String): Boolean {
        val pm = context.packageManager
        runCatching {
            val launch = pm.getLaunchIntentForPackage(pkg)
            if (launch != null && launch.component != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
                context.startActivity(launch)
                return true
            }
        }
        runCatching {
            val probe = Intent(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_LAUNCHER)
                setPackage(pkg)
            }
            val resolved = resolveLauncher(pm, probe) ?: return@runCatching
            val start = Intent(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_LAUNCHER)
                component = ComponentName(
                    resolved.activityInfo.packageName,
                    resolved.activityInfo.name,
                )
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
            }
            context.startActivity(start)
            return true
        }
        return false
    }

    private fun resolveLauncher(pm: PackageManager, probe: Intent) =
        if (Build.VERSION.SDK_INT >= 33) {
            pm.resolveActivity(probe, PackageManager.ResolveInfoFlags.of(0))
                ?: pm.queryIntentActivities(probe, PackageManager.ResolveInfoFlags.of(0)).firstOrNull()
        } else {
            @Suppress("DEPRECATION")
            pm.resolveActivity(probe, 0)
                ?: @Suppress("DEPRECATION")
                pm.queryIntentActivities(probe, 0).firstOrNull()
        }

    private fun startScheme(context: Context, scheme: String): Boolean {
        val uri = Uri.parse("$scheme://open")
        val intent = Intent(Intent.ACTION_VIEW, uri).apply {
            addCategory(Intent.CATEGORY_BROWSABLE)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val pm = context.packageManager
        val hit = if (Build.VERSION.SDK_INT >= 33) {
            pm.resolveActivity(intent, PackageManager.ResolveInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            pm.resolveActivity(intent, 0)
        } ?: return false
        val pkg = hit.activityInfo?.packageName.orEmpty()
        if (pkg.isBlank() || isBrowserPackage(pkg)) return false
        intent.component = ComponentName(pkg, hit.activityInfo.name)
        return runCatching {
            context.startActivity(intent)
            true
        }.getOrDefault(false)
    }

    private fun isBrowserPackage(pkg: String): Boolean {
        val p = pkg.lowercase()
        return p.contains("chrome") ||
            p.contains("browser") ||
            p.contains("firefox") ||
            p.contains("samsung.android.sbrowser") ||
            p.endsWith(".captiveportallogin")
    }

    private fun openHttps(context: Context, host: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://$host")).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        runCatching { context.startActivity(intent) }
    }
}

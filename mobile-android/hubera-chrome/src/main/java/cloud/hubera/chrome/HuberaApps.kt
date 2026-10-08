package cloud.hubera.chrome

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.DirectionsCar
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Mail
import androidx.compose.material.icons.outlined.Map
import androidx.compose.material.icons.outlined.MenuBook
import androidx.compose.material.icons.outlined.MusicNote
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Work
import androidx.compose.ui.graphics.vector.ImageVector

data class HuberaNavItem(
    val id: String,
    val label: String,
    val icon: ImageVector,
)

enum class HuberaProduct(
    val id: String,
    val title: String,
    val host: String,
    val packages: List<String>,
    val icon: ImageVector,
) {
    MUSIC(
        "music",
        "Music",
        "music.hubera.cloud",
        listOf("cloud.hubera.music", "ovh.delhomme.ytmusic"),
        Icons.Outlined.MusicNote,
    ),
    MAPS(
        "maps",
        "Maps",
        "maps.hubera.cloud",
        listOf("cloud.hubera.maps", "ovh.delhomme.maps"),
        Icons.Outlined.Map,
    ),
    FUEL(
        "fuel",
        "Fuel",
        "fuel.hubera.cloud",
        listOf("cloud.hubera.fuel", "com.gasoiltracking.app"),
        Icons.Outlined.DirectionsCar,
    ),
    DOCS(
        "docs",
        "Docs",
        "docs.hubera.cloud",
        listOf("cloud.hubera.docs", "ovh.delhomme.hubera.docs"),
        Icons.Outlined.MenuBook,
    ),
    CALENDAR(
        "calendar",
        "Agenda",
        "calendar.hubera.cloud",
        listOf("cloud.hubera.calendar"),
        Icons.Outlined.CalendarMonth,
    ),
    DRIVE(
        "drive",
        "Drive",
        "drive.hubera.cloud",
        listOf("cloud.hubera.drive"),
        Icons.Outlined.Folder,
    ),
    MAIL(
        "mail",
        "Mail",
        "mail.hubera.cloud",
        listOf("cloud.hubera.mail"),
        Icons.Outlined.Mail,
    ),
    PASS(
        "pass",
        "Pass",
        "pass.hubera.cloud",
        listOf("cloud.hubera.pass"),
        Icons.Outlined.Lock,
    ),
    JOBS(
        "jobs",
        "Jobs",
        "jobs.hubera.cloud",
        listOf("cloud.hubera.jobs", "ovh.delhomme.jobbingtrack"),
        Icons.Outlined.Work,
    ),
    ID(
        "id",
        "ID",
        "id.hubera.cloud",
        listOf("cloud.hubera.id"),
        Icons.Outlined.Person,
    ),
    ;

    companion object {
        val suite: List<HuberaProduct> = entries
    }
}

fun openHuberaApp(context: Context, product: HuberaProduct) {
    val pm = context.packageManager
    for (pkg in product.packages) {
        val launch = pm.getLaunchIntentForPackage(pkg)
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(launch)
            return
        }
    }
    context.startActivity(
        Intent(Intent.ACTION_VIEW, Uri.parse("https://${product.host}")).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        },
    )
}

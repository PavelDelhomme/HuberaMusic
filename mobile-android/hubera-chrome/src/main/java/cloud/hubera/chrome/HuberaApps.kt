package cloud.hubera.chrome

import android.content.Context
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountBalance
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Contacts
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.DirectionsCar
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Mail
import androidx.compose.material.icons.outlined.Map
import androidx.compose.material.icons.outlined.MenuBook
import androidx.compose.material.icons.outlined.MusicNote
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.PlayCircle
import androidx.compose.material.icons.outlined.Restaurant
import androidx.compose.material.icons.outlined.StickyNote2
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
    val icon: ImageVector,
) {
    MUSIC("music", "Music", Icons.Outlined.MusicNote),
    MAPS("maps", "Maps", Icons.Outlined.Map),
    FUEL("fuel", "Fuel", Icons.Outlined.DirectionsCar),
    DOCS("docs", "Docs", Icons.Outlined.MenuBook),
    CALENDAR("calendar", "Agenda", Icons.Outlined.CalendarMonth),
    DRIVE("drive", "Drive", Icons.Outlined.Folder),
    MAIL("mail", "Mail", Icons.Outlined.Mail),
    PASS("pass", "Pass", Icons.Outlined.Lock),
    JOBS("jobs", "Jobs", Icons.Outlined.Work),
    ID("id", "ID", Icons.Outlined.Person),
    TASKS("tasks", "Tâches", Icons.Outlined.CheckCircle),
    CONTACTS("contacts", "Contacts", Icons.Outlined.Contacts),
    PHOTOS("photos", "Photos", Icons.Outlined.PhotoLibrary),
    NOTES("notes", "Notes", Icons.Outlined.StickyNote2),
    COOK("cook", "Cook", Icons.Outlined.Restaurant),
    OFFICE("office", "Office", Icons.Outlined.Description),
    BUDGET("budget", "Budget", Icons.Outlined.AccountBalance),
    STREAM("stream", "Stream", Icons.Outlined.PlayCircle),
    ;

    val spec: HuberaAppLauncher.Spec
        get() = HuberaAppLauncher.spec(id) ?: HuberaAppLauncher.Spec(id, "$id.hubera.cloud", listOf("cloud.hubera.$id"))

    val host: String get() = spec.host
    val packages: List<String> get() = spec.packages

    companion object {
        val suite: List<HuberaProduct> = entries
    }
}

fun openHuberaApp(context: Context, product: HuberaProduct) {
    HuberaAppLauncher.openOrWeb(context, product.id)
}

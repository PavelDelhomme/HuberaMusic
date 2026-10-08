import java.io.File

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "PLM"
include(":app")

val persoRoot = rootProject.projectDir.parentFile.parentFile
val siblingSso = File(persoRoot, "HuberaID/android-sso")
val vendoredSso = File(rootProject.projectDir, "hubera-id-sso")
val ssoDir = when {
    File(siblingSso, "src/main/AndroidManifest.xml").isFile -> siblingSso
    else -> vendoredSso
}
include(":hubera-id-sso")
project(":hubera-id-sso").projectDir = ssoDir

include(":hubera-chrome")
project(":hubera-chrome").projectDir = file("hubera-chrome")

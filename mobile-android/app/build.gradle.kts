plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

fun loadRootEnv(): Map<String, String> {
    val map = mutableMapOf<String, String>()
    val envFile = rootProject.projectDir.parentFile.resolve(".env")
    if (!envFile.isFile) return map
    envFile.readLines().forEach { raw ->
        val line = raw.trim()
        if (line.isEmpty() || line.startsWith("#") || !line.contains("=")) return@forEach
        val idx = line.indexOf('=')
        val key = line.substring(0, idx).trim()
        var value = line.substring(idx + 1).trim()
        if ((value.startsWith("\"") && value.endsWith("\"")) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.substring(1, value.length - 1)
        }
        map[key] = value
    }
    return map
}

val rootEnv = loadRootEnv()

fun readAppVersion(): String {
    val f = rootProject.projectDir.parentFile.resolve("VERSION")
    if (!f.isFile) return "0.0.0"
    return f.readText().trim().ifBlank { "0.0.0" }
}

fun versionCodeFromSemver(semver: String): Int {
    val parts = semver.split(".").mapNotNull { it.toIntOrNull() }
    val maj = parts.getOrElse(0) { 0 }
    val min = parts.getOrElse(1) { 0 }
    val pat = parts.getOrElse(2) { 0 }
    return maj * 10_000 + min * 100 + pat
}

android {
    namespace = "ovh.delhomme.ytmusic"
    compileSdk = 35

    defaultConfig {
        applicationId = "ovh.delhomme.ytmusic"
        minSdk = 26
        targetSdk = 35

        val semver = readAppVersion()
        val rawApi = (project.findProperty("API_BASE_URL") as String?)
            ?: rootEnv["ANDROID_API_BASE_URL"]
            ?: rootEnv["API_BASE_URL"]
            ?: ""
        fun detectLanIp(): String =
            runCatching {
                ProcessBuilder(
                    "bash",
                    "-lc",
                    "ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if(\$i==\"src\") {print \$(i+1); exit}}'",
                ).redirectErrorStream(true).start()
                    .inputStream.bufferedReader().readText().trim()
            }.getOrNull().orEmpty()

        val lanIp = detectLanIp()
        val lanApi = if (lanIp.matches(Regex("""\d+\.\d+\.\d+\.\d+"""))) {
            "http://$lanIp:8787"
        } else {
            ""
        }
        val deployUrl = rootEnv["DEPLOY_URL"]?.trim()?.trimEnd('/').orEmpty()
        val buildingProd = gradle.startParameter.taskNames.any { it.contains("Prod", ignoreCase = true) }
        // Téléphone physique ≠ 127.0.0.1 (ça pointe le phone). Toujours LAN pour le local.
        val apiBase = when {
            rawApi.isNotBlank() && !(rawApi.contains("127.0.0.1") || rawApi.contains("localhost")) -> rawApi
            rawApi.isNotBlank() && (rawApi.contains("127.0.0.1") || rawApi.contains("localhost")) ->
                lanApi.ifBlank {
                    logger.warn("API locale 127.0.0.1/localhost → IP LAN introuvable, garde $rawApi (émulateur ?)")
                    rawApi
                }
            buildingProd && deployUrl.startsWith("https://") -> deployUrl
            else -> lanApi.ifBlank { error("API_BASE_URL manquant et IP LAN introuvable") }
        }
        // Jamais préremplir les secrets locaux quand l’APK pointe la prod / un HTTPS distant
        val isRemoteApi = apiBase.startsWith("https://") &&
            !apiBase.contains("127.0.0.1") &&
            !apiBase.contains("localhost")
        // d+ = local/LAN · p+ = API prod distante
        val channel = if (isRemoteApi) "p" else "d"
        versionCode = versionCodeFromSemver(semver)
        versionName = "$channel+$semver"
        val devEmail = if (isRemoteApi) {
            ""
        } else {
            rootEnv["SEED_EMAIL"] ?: rootEnv["VITE_DEV_EMAIL"] ?: ""
        }
        val devPassword = if (isRemoteApi) {
            ""
        } else {
            rootEnv["SEED_PASSWORD"] ?: rootEnv["VITE_DEV_PASSWORD"] ?: ""
        }
        val androidOrigin = rootEnv["WEBAUTHN_ANDROID_ORIGINS"]
            ?.split(",")
            ?.firstOrNull()
            ?.trim()
            ?: "android:apk-key-hash:PPbFMh2hUX55lAyeJVFKY5ssRJ4-_333R2h2y_b0wR8"

        fun esc(s: String) = s.replace("\\", "\\\\").replace("\"", "\\\"")
        buildConfigField("String", "API_BASE_URL", "\"${esc(apiBase)}\"")
        buildConfigField("String", "DEV_EMAIL", "\"${esc(devEmail)}\"")
        buildConfigField("String", "DEV_PASSWORD", "\"${esc(devPassword)}\"")
        buildConfigField("String", "ANDROID_WEBAUTHN_ORIGIN", "\"${esc(androidOrigin)}\"")
        buildConfigField("String", "APP_VERSION", "\"${esc(semver)}\"")
        buildConfigField("String", "APP_CHANNEL", "\"$channel\"")
        buildConfigField("String", "APP_VERSION_LABEL", "\"${esc(versionName!!)}\"")
        // URL publique (DEPLOY_URL / PUBLIC_API_URL) — fallback LAN→prod, bouton Debug
        val publicApi = listOfNotNull(
            rootEnv["PUBLIC_API_URL"],
            rootEnv["DEPLOY_URL"],
            rootEnv["ANDROID_API_BASE_URL"],
        ).map { it.trim().trimEnd('/') }
            .firstOrNull { it.startsWith("https://") && !it.contains("127.0.0.1") && !it.contains("localhost") }
            ?: ""
        buildConfigField("String", "PUBLIC_API_URL", "\"${esc(publicApi)}\"")
    }

    // Deux APK côte à côte sur le même téléphone :
    //   prod → ovh.delhomme.ytmusic      (PLM)
    //   dev  → ovh.delhomme.ytmusic.dev  (PLM Dev)
    flavorDimensions += "channel"
    productFlavors {
        create("prod") {
            dimension = "channel"
            resValue("string", "app_name", "PLM")
            manifestPlaceholders["usesCleartext"] = "false"
        }
        create("dev") {
            dimension = "channel"
            applicationIdSuffix = ".dev"
            resValue("string", "app_name", "PLM Dev")
            manifestPlaceholders["usesCleartext"] = "true"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-process:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.navigation:navigation-compose:2.8.4")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("androidx.media3:media3-exoplayer:1.5.0")
    implementation("androidx.media3:media3-session:1.5.0")
    implementation("androidx.media3:media3-ui:1.5.0")

    implementation("androidx.credentials:credentials:1.5.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.5.0")
    implementation("com.google.android.gms:play-services-fido:21.1.0")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-moshi:2.11.0")
    implementation("com.squareup.moshi:moshi-kotlin:1.15.1")

    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("io.coil-kt:coil-compose:2.7.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}

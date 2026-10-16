import java.util.Properties

plugins {
    id("com.android.application")
}

val appId = providers.gradleProperty("rq.applicationId").get()

// Release signing comes from the untracked android/keystore.properties (see keystore.properties.example). Nothing secret is written here.
val signingProps = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.isFile) file.inputStream().use { load(it) }
}

android {
    namespace = appId
    compileSdk = 36

    defaultConfig {
        applicationId = appId
        minSdk = 26
        targetSdk = 36
        versionCode = providers.gradleProperty("rq.versionCode").get().toInt()
        versionName = providers.gradleProperty("rq.versionName").get()
    }

    signingConfigs {
        if (signingProps.getProperty("storeFile") != null) {
            create("release") {
                storeFile = rootProject.file(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Without keystore.properties the release APK stays unsigned; build.ps1 -Release refuses to run in that case.
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
        debug {
            // Signed with the machine's debug key; its fingerprint goes into assetlinks next to the release key (android/fingerprint.ps1).
        }
        // Loopback variant for the emulator: its start URL (http, reached through adb reverse) lives only in
        // src/localDebug/res/values/twa.xml, which gen-resources.mjs writes. The release build type never sees it.
        create("localDebug") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".local"
            versionNameSuffix = "-local"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.7.4")
}

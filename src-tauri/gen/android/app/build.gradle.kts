import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "de.tobiaskneidl.nia_todo"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "de.tobiaskneidl.nia_todo"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

rust {
    rootDirRel = "../../../"
}

tasks.register("patchTauriAndroidGeneratedSources") {
    val webChromeClient = file("src/main/java/de/tobiaskneidl/nia_todo/generated/RustWebChromeClient.kt")
    val rustWebView = file("src/main/java/de/tobiaskneidl/nia_todo/generated/RustWebView.kt")
    val wryActivity = file("src/main/java/de/tobiaskneidl/nia_todo/generated/WryActivity.kt")
    doLast {
        if (webChromeClient.exists()) {
            val source = webChromeClient.readText()
            val patched = source.replace(
                "      permissionList.add(Manifest.permission.MODIFY_AUDIO_SETTINGS)\n      permissionList.add(Manifest.permission.RECORD_AUDIO)",
                "      permissionList.add(Manifest.permission.RECORD_AUDIO)"
            )
            if (patched != source) {
                webChromeClient.writeText(patched)
                println("Patched Tauri WebView microphone permission request to RECORD_AUDIO only")
            }
        }
        if (rustWebView.exists()) {
            val source = rustWebView.readText()
            val patched = source.replace("        settings.databaseEnabled = true\n", "")
            if (patched != source) {
                rustWebView.writeText(patched)
                println("Removed legacy WebView databaseEnabled assignment")
            }
        }
        if (wryActivity.exists()) {
            val source = wryActivity.readText()
            val patched = source.replace(
                "this@WryActivity.onBackPressed()",
                "this@WryActivity.onBackPressedDispatcher.onBackPressed()"
            )
            if (patched != source) {
                wryActivity.writeText(patched)
                println("Updated WryActivity back navigation")
            }
        }
    }
}

tasks.matching { it.name.startsWith("compile") && it.name.endsWith("Kotlin") }.configureEach {
    dependsOn("patchTauriAndroidGeneratedSources")
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.credentials:credentials:1.5.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.5.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("com.google.android.gms:play-services-location:21.3.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
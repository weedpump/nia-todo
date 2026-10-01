import org.gradle.api.tasks.compile.JavaCompile
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.10")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
    tasks.withType<KotlinCompile>().configureEach {
        if (project.path == ":tauri-android") {
            compilerOptions.suppressWarnings.set(true)
        }
    }
    tasks.withType<JavaCompile>().configureEach {
        if (project.path == ":tauri-android") {
            options.compilerArgs.add("-Xlint:-options")
        }
    }
}

tasks.register("clean").configure {
    delete("build")
}


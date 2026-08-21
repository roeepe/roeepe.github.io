plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "io.github.roeepe.ivrit"
    compileSdk = 35
    // Pinned so the CI image and any local build agree; the workflow installs it.
    ndkVersion = "27.2.12479018"

    defaultConfig {
        applicationId = "io.github.roeepe.ivrit"
        minSdk = 29                 // Android 10 — where the thermal-status API lands
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        ndk {
            // 64-bit ARM only: every phone that can run a 1.5 GB model is arm64,
            // and dropping the other ABIs keeps the APK to one native payload.
            abiFilters += "arm64-v8a"
        }
        externalNativeBuild {
            cmake {
                arguments += listOf("-DANDROID_STL=c++_static", "-DCMAKE_BUILD_TYPE=Release")
                cppFlags += "-O3"
            }
        }
    }

    signingConfigs {
        // A committed, stable key. It is only good for sideloading — its whole
        // job is to keep the SHA-1 constant so the Google OAuth client stays
        // valid across CI builds. Replace it before distributing anywhere.
        create("sideload") {
            storeFile = file("../keystore/sideload.jks")
            storePassword = "sideload"
            keyAlias = "ivrit"
            keyPassword = "sideload"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("sideload")
            isMinifyEnabled = false
        }
        release {
            signingConfig = signingConfigs.getByName("sideload")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.documentfile:documentfile:1.0.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
}

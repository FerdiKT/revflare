import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    `maven-publish`
}

group = "io.github.ferdikt"
version = "1.9.1" // = Revflare.VERSION

android {
    namespace = "app.revflare.kit"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
    }
}

kotlin {
    explicitApi()
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        optIn.add("kotlinx.coroutines.ExperimentalCoroutinesApi")
    }
}

dependencies {
    api(libs.billing)
    implementation(libs.installreferrer)
    implementation(libs.coroutines.android)
    implementation(libs.lifecycle.process)
    // Optional: the app adds play-services-ads-identifier itself to report the Google advertising id (Meta matching).
    compileOnly(libs.ads.identifier)

    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
}

publishing {
    publications {
        register<MavenPublication>("release") {
            groupId = "io.github.ferdikt"
            artifactId = "revflarekit"
            version = project.version.toString()
            afterEvaluate { from(components["release"]) }
            pom {
                name.set("RevflareKit")
                description.set("Revflare SDK for Android: Play Install Referrer attribution, Play Billing purchases, offerings, events and remote config for a self-hosted Revflare server.")
                url.set("https://github.com/FerdiKT/RevflareKit-Android")
                licenses {
                    license {
                        name.set("MIT License")
                        url.set("https://opensource.org/licenses/MIT")
                    }
                }
                developers {
                    developer {
                        id.set("ferdikt")
                        name.set("Ferdi")
                    }
                }
                scm {
                    url.set("https://github.com/FerdiKT/RevflareKit-Android")
                }
            }
        }
    }
    repositories {
        maven {
            name = "GitHubPackages"
            url = uri("https://maven.pkg.github.com/FerdiKT/RevflareKit-Android")
            credentials {
                username = System.getenv("GITHUB_ACTOR")
                password = System.getenv("GITHUB_TOKEN")
            }
        }
    }
}

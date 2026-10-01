import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const rustSource = read('src-tauri/src/lib.rs');
assert.match(rustSource, /#\[cfg\(desktop\)\]\nuse std::io::Read;/);
assert.match(rustSource, /#\[cfg\(desktop\)\]\nuse std::path::Path;/);
for (const symbol of [
  'safe_download_filename',
  'unique_download_path',
  'same_url_origin',
]) {
  assert.match(
    rustSource,
    new RegExp(`#\\[cfg\\(desktop\\)\\]\\nfn ${symbol}\\(`),
    `${symbol} must only compile for desktop targets`,
  );
}
for (const symbol of [
  'DESKTOP_ATTACHMENT_DOWNLOAD_TIMEOUT_SECS',
  'DESKTOP_ATTACHMENT_DOWNLOAD_MAX_BYTES',
]) {
  assert.match(
    rustSource,
    new RegExp(`#\\[cfg\\(desktop\\)\\]\\nconst ${symbol}`),
    `${symbol} must only compile for desktop targets`,
  );
}

const mainActivity = read('src-tauri/gen/android/app/src/main/java/de/tobiaskneidl/nia_todo/MainActivity.kt');
assert.doesNotMatch(mainActivity, /collectionUri!!/);

const oidcCallback = read('src-tauri/gen/android/app/src/main/java/de/tobiaskneidl/nia_todo/OidcCallbackActivity.kt');
assert.match(oidcCallback, /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.UPSIDE_DOWN_CAKE/);
assert.match(oidcCallback, /overrideActivityTransition\(OVERRIDE_TRANSITION_CLOSE, 0, 0\)/);
assert.match(oidcCallback, /@Suppress\("DEPRECATION"\)/);

const buildTask = read('src-tauri/gen/android/buildSrc/src/main/java/de/tobiaskneidl/nia_todo/kotlin/BuildTask.kt');
assert.match(buildTask, /ExecOperations/);
assert.match(buildTask, /ProjectLayout/);
assert.match(buildTask, /@Inject/);
assert.doesNotMatch(buildTask, /\bproject\./);

const appGradle = read('src-tauri/gen/android/app/build.gradle.kts');
assert.match(appGradle, /^@file:Suppress\("DEPRECATION"\)/);
assert.match(appGradle, /compileSdk = 37/);
assert.match(appGradle, /targetSdk = 37/);
assert.match(appGradle, /sourceCompatibility = JavaVersion\.VERSION_17/);
assert.match(appGradle, /targetCompatibility = JavaVersion\.VERSION_17/);
assert.match(appGradle, /import org\.jetbrains\.kotlin\.gradle\.dsl\.JvmTarget/);
assert.match(appGradle, /jvmTarget\.set\(JvmTarget\.JVM_17\)/);
assert.doesNotMatch(appGradle, /jvmTarget = "1\.8"/);
assert.match(appGradle, /databaseEnabled = true/);
assert.match(appGradle, /onBackPressedDispatcher\.onBackPressed\(\)/);
assert.doesNotMatch(appGradle, /println\("[^"\n]*deprecated/i);

const rootGradle = read('src-tauri/gen/android/build.gradle.kts');
assert.match(rootGradle, /com\.android\.tools\.build:gradle:9\.3\.1/);
assert.match(rootGradle, /kotlin-gradle-plugin:2\.2\.10/);
assert.match(rootGradle, /path == ":tauri-android"/);
assert.match(rootGradle, /compilerOptions\.suppressWarnings\.set\(true\)/);
assert.match(rootGradle, /tasks\.withType<JavaCompile>\(\)\.configureEach/);
assert.match(rootGradle, /options\.compilerArgs\.add\("-Xlint:-options"\)/);
assert.doesNotMatch(rootGradle, /kotlinOptions\.jvmTarget = "17"/);

const buildSrcGradle = read('src-tauri/gen/android/buildSrc/build.gradle.kts');
assert.match(buildSrcGradle, /com\.android\.tools\.build:gradle:9\.3\.1/);

const gradleProperties = read('src-tauri/gen/android/gradle.properties');
assert.match(gradleProperties, /^android\.javaCompile\.suppressSourceTargetDeprecationWarning=true$/m);
assert.match(gradleProperties, /^org\.gradle\.warning\.mode=all$/m);
assert.match(gradleProperties, /^org\.gradle\.configuration-cache=true$/m);
assert.match(gradleProperties, /^android\.proguard\.failOnMissingFiles=false$/m);
assert.match(gradleProperties, /^android\.builtInKotlin=false$/m);
assert.match(gradleProperties, /^android\.newDsl=false$/m);
assert.match(gradleProperties, /^android\.sync\.suppressAgpWarnings=UNSUPPORTED_PROJECT_OPTION_USE,DEPRECATED_DSL$/m);
assert.doesNotMatch(gradleProperties, /^android\.nonFinalResIds=/m);
assert.doesNotMatch(gradleProperties, /deprecation\.trace/);

const gradleWrapper = read('src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties');
assert.match(gradleWrapper, /gradle-9\.6\.1-bin\.zip/);

const packageJson = JSON.parse(read('package.json'));
assert.equal(packageJson.dependencies['@tauri-apps/api'], '2.12.1');
assert.equal(packageJson.devDependencies['@tauri-apps/cli'], '2.12.1');

const cargoToml = read('src-tauri/Cargo.toml');
assert.match(cargoToml, /tauri-build = \{ version = "2\.7\.1"/);
assert.match(cargoToml, /tauri = \{ version = "2\.12\.1"/);

const buildWorkflow = read('.github/workflows/build.yml');
const androidJob = buildWorkflow.match(/  build-android:\n([\s\S]*?)\n  build-debian-desktop:/)?.[1];
assert.ok(androidJob, 'build-android job must be present');
assert.doesNotMatch(androidJob, /sdkmanager/);
assert.match(androidJob, /accept-android-sdk-licenses: false/);
assert.match(androidJob, /packages: ""/);
assert.match(androidJob, /android-cli_1\.0\.16486076_amd64\.deb/);
assert.match(androidJob, /6b3e936cf0d770ed39c9118c9cf541c01082fd36b3308749c21affb1f1bcf83d/);
for (const sdkPackage of ['platform-tools', 'platforms/android-37.0', 'ndk/27.0.12077973', 'build-tools/35.0.0']) {
  assert.ok(androidJob.includes(`sdk install ${sdkPackage}`), `Android CLI must install ${sdkPackage}`);
}
assert.match(androidJob, /GIT_CONFIG_COUNT: 1/);
assert.match(androidJob, /GIT_CONFIG_KEY_0: init\.defaultBranch/);
assert.match(androidJob, /GIT_CONFIG_VALUE_0: main/);
assert.match(androidJob, /npm run tauri -- android build --target aarch64 --apk --ci/);
assert.doesNotMatch(androidJob, /filter_android_/);
assert.equal(existsSync(join(ROOT, 'scripts/filter_android_sdkmanager_stderr.py')), false);
assert.equal(existsSync(join(ROOT, 'scripts/filter_android_gradle_output.py')), false);

console.log('✅ Android native build warning guards passed');

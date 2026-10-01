import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const rustSource = read('src-tauri/src/lib.rs');
assert.match(rustSource, /#\[cfg\(desktop\)\]\nuse std::io::Read;/);
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
assert.match(buildTask, /@Inject/);
assert.doesNotMatch(buildTask, /project\.exec\s*\{/);

const appGradle = read('src-tauri/gen/android/app/build.gradle.kts');
assert.match(appGradle, /sourceCompatibility = JavaVersion\.VERSION_17/);
assert.match(appGradle, /targetCompatibility = JavaVersion\.VERSION_17/);
assert.match(appGradle, /import org\.jetbrains\.kotlin\.gradle\.dsl\.JvmTarget/);
assert.match(appGradle, /jvmTarget\.set\(JvmTarget\.JVM_17\)/);
assert.doesNotMatch(appGradle, /jvmTarget = "1\.8"/);
assert.match(appGradle, /databaseEnabled = true/);
assert.match(appGradle, /onBackPressedDispatcher\.onBackPressed\(\)/);

const rootGradle = read('src-tauri/gen/android/build.gradle.kts');
assert.match(rootGradle, /kotlin-gradle-plugin:2\.2\.10/);
assert.match(rootGradle, /path == ":tauri-android"/);
assert.match(rootGradle, /compilerOptions\.suppressWarnings\.set\(true\)/);
assert.match(rootGradle, /tasks\.withType<JavaCompile>\(\)\.configureEach/);
assert.match(rootGradle, /options\.compilerArgs\.add\("-Xlint:-options"\)/);
assert.doesNotMatch(rootGradle, /kotlinOptions\.jvmTarget = "17"/);

const gradleProperties = read('src-tauri/gen/android/gradle.properties');
assert.match(gradleProperties, /^android\.javaCompile\.suppressSourceTargetDeprecationWarning=true$/m);

const buildWorkflow = read('.github/workflows/build.yml');
const androidJob = buildWorkflow.match(/  build-android:\n([\s\S]*?)\n  build-debian-desktop:/)?.[1];
assert.ok(androidJob, 'build-android job must be present');
assert.doesNotMatch(androidJob, /android-cli/);
assert.match(androidJob, /log-accepted-android-sdk-licenses: false/);
assert.match(androidJob, /packages: ""/);
assert.match(
  androidJob,
  /sdkmanager --install "platform-tools" "ndk;27\.0\.12077973" "build-tools;35\.0\.0" 2> >\(grep -Fv "WARNING: The SDK Manager CLI tool \(sdkmanager\) is deprecated\. Use Android CLI instead\." >&2\)/,
);
assert.match(androidJob, /set -o pipefail/);
assert.match(androidJob, /GIT_CONFIG_COUNT: 1/);
assert.match(androidJob, /GIT_CONFIG_KEY_0: init\.defaultBranch/);
assert.match(androidJob, /GIT_CONFIG_VALUE_0: main/);

console.log('✅ Android native build warning guards passed');

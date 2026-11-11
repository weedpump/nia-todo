import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
assert.match(appGradle, /apply\(from = file\("tauri\.build\.gradle\.kts"\)\)/);
assert.doesNotMatch(appGradle, /apply\(from = "tauri\.build\.gradle\.kts"\)/);

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
const packageLock = JSON.parse(read('package-lock.json'));
for (const [section, dependency] of [['dependencies', '@tauri-apps/api'], ['devDependencies', '@tauri-apps/cli']]) {
  const version = packageJson[section][dependency];
  assert.match(version, /^2\.\d+\.\d+$/, `${dependency} must have an exact supported-version pin`);
  assert.equal(packageLock.packages[''][section][dependency], version, `${dependency} root lock pin must match`);
  assert.equal(packageLock.packages[`node_modules/${dependency}`].version, version, `${dependency} resolved package must match`);
}

const cargoToml = read('src-tauri/Cargo.toml');
assert.match(cargoToml, /tauri-build = \{ version = "2\.\d+\.\d+"/);
assert.match(cargoToml, /tauri = \{ version = "2\.\d+\.\d+"/);

const cargoLock = read('src-tauri/Cargo.lock');
const lockedTauriVersion = cargoLock.match(/\[\[package\]\]\nname = "tauri"\nversion = "([^"]+)"/)?.[1];
assert.ok(lockedTauriVersion, 'Cargo.lock must contain the resolved Tauri package');
assert.match(lockedTauriVersion, /^2\.\d+\.\d+$/, 'Android Gradle patch supports the Tauri 2 series');

const buildWorkflow = read('.github/workflows/build.yml');
const androidJob = buildWorkflow.match(/  build-android:\n([\s\S]*?)\n  build-debian-desktop:/)?.[1];
assert.ok(androidJob, 'build-android job must be present');
assert.doesNotMatch(androidJob, /sdkmanager/);
assert.match(androidJob, /accept-android-sdk-licenses: false/);
assert.match(androidJob, /packages: ""/);
assert.match(androidJob, /https:\/\/dl\.google\.com\/android\/cli\/latest\/debian\/ stable main/);
assert.match(androidJob, /sudo apt-get install -y android-cli/);
for (const sdkPackage of ['platform-tools', 'platforms/android-37.0', 'ndk/27.0.12077973', 'build-tools/35.0.0']) {
  assert.ok(androidJob.includes(`sdk install ${sdkPackage}`), `Android CLI must install ${sdkPackage}`);
}
assert.match(androidJob, /GIT_CONFIG_COUNT: 1/);
assert.match(androidJob, /GIT_CONFIG_KEY_0: init\.defaultBranch/);
assert.match(androidJob, /GIT_CONFIG_VALUE_0: main/);
assert.match(androidJob, /npm run tauri -- android build --target aarch64 --apk --ci/);
assert.match(androidJob, /python3 scripts\/patch_tauri_android_gradle\.py/);
assert.doesNotMatch(androidJob, /filter_android_/);
assert.equal(existsSync(join(ROOT, 'scripts/filter_android_sdkmanager_stderr.py')), false);
assert.equal(existsSync(join(ROOT, 'scripts/filter_android_gradle_output.py')), false);

const patchFixture = mkdtempSync(join(tmpdir(), 'nia-todo-tauri-gradle-'));
try {
  const tauriRoot = join(patchFixture, `tauri-${lockedTauriVersion}`);
  const androidGradle = join(tauriRoot, 'mobile/android/build.gradle.kts');
  mkdirSync(join(tauriRoot, 'mobile/android'), { recursive: true });
  writeFileSync(androidGradle, 'plugins {\n    id("com.android.library")\n}\nandroid {\n    namespace = "app.tauri"\n}\n');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const patched = spawnSync('python3', [join(ROOT, 'scripts/patch_tauri_android_gradle.py'), '--tauri-root', tauriRoot], { encoding: 'utf8' });
    assert.equal(patched.status, 0, patched.stderr);
  }
  const patchedSource = readFileSync(androidGradle, 'utf8');
  assert.match(patchedSource, /^@file:Suppress\("DEPRECATION"\)\n\n/);
  assert.equal((patchedSource.match(/@file:Suppress/g) ?? []).length, 1);
} finally {
  rmSync(patchFixture, { recursive: true, force: true });
}

const resolverChecks = spawnSync('python3', [join(ROOT, 'scripts/test_patch_tauri_android_gradle.py')], { encoding: 'utf8' });
assert.equal(resolverChecks.status, 0, resolverChecks.stderr || resolverChecks.stdout);

console.log('✅ Android native build warning guards passed');

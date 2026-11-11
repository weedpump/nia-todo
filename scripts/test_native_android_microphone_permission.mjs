#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

console.log('🤖 Running Android microphone permission test...');
const manifest = readFileSync('src-tauri/gen/android/app/src/main/AndroidManifest.xml', 'utf8');
const buildGradle = readFileSync('src-tauri/gen/android/app/build.gradle.kts', 'utf8');
const webChromeClientPath = 'src-tauri/gen/android/app/src/main/java/de/tobiaskneidl/nia_todo/generated/RustWebChromeClient.kt';
const webChromeClient = existsSync(webChromeClientPath) ? readFileSync(webChromeClientPath, 'utf8') : '';
const mainActivity = readFileSync('src-tauri/gen/android/app/src/main/java/de/tobiaskneidl/nia_todo/MainActivity.kt', 'utf8');

for (const permission of ['android.permission.RECORD_AUDIO']) {
  if (!manifest.includes(`android:name="${permission}"`)) {
    throw new Error(`Missing Android permission required for WebView microphone capture: ${permission}`);
  }
}

if (manifest.includes('android.permission.MODIFY_AUDIO_SETTINGS')) {
  throw new Error('Android manifest must not request MODIFY_AUDIO_SETTINGS for microphone capture');
}

if (!buildGradle.includes('tasks.register("patchTauriAndroidGeneratedSources")')) {
  throw new Error('Android Gradle build must patch Tauri WebChromeClient microphone permission requests');
}

// Generated Wry sources are raw until the Gradle patch task runs. Validate the
// configured transformation rather than requiring a previous Android build.
const permissionPatch = buildGradle.match(/if\s*\(webChromeClient\.exists\(\)\)\s*\{\s*val source = webChromeClient\.readText\(\)\s*val patched = source\.replace\(\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*\)/);
assert.ok(permissionPatch, 'Gradle must patch the generated WebChromeClient permission requests');
assert.match(buildGradle, /webChromeClient\.writeText\(patched\)/,
  'Gradle must persist the patched WebChromeClient before compilation');
const before = JSON.parse(permissionPatch[1]);
const after = JSON.parse(permissionPatch[2]);
const applyPermissionPatch = source => source.split(before).join(after);
assert.ok(before.length > 0, 'The permission patch must have a nonempty source pattern');
assert.match(buildGradle, /tasks\.matching\s*\{\s*it\.name\.startsWith\("compile"\)\s*&&\s*it\.name\.endsWith\("Kotlin"\)\s*\}\.configureEach\s*\{\s*dependsOn\("patchTauriAndroidGeneratedSources"\)\s*\}/,
  'Every Kotlin compilation must depend on patching the generated sources');

const rawPermissionFixture = `
    if (resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
      permissionList.add(Manifest.permission.CAMERA)
    }
    if (resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
      permissionList.add(Manifest.permission.MODIFY_AUDIO_SETTINGS)
      permissionList.add(Manifest.permission.RECORD_AUDIO)
    }
`;

function assertMicrophonePermissions(source, label) {
  const audioBranch = source.match(/if\s*\(resources\.contains\(PermissionRequest\.RESOURCE_AUDIO_CAPTURE\)\)\s*\{([^}]+)\}/);
  assert.ok(audioBranch, `${label}: WebView audio capture permission branch must exist`);
  const permissions = [...audioBranch[1].matchAll(/permissionList\.add\(Manifest\.permission\.(\w+)\)/g)].map(match => match[1]);
  assert.deepEqual(permissions, ['RECORD_AUDIO'],
    `${label}: WebView microphone capture must request RECORD_AUDIO only`);
  assert.doesNotMatch(source, /Manifest\.permission\.MODIFY_AUDIO_SETTINGS/,
    `${label}: MODIFY_AUDIO_SETTINGS must not reach the compiled WebChromeClient`);
}

const patchedFixture = applyPermissionPatch(rawPermissionFixture);
assert.notEqual(patchedFixture, rawPermissionFixture, 'The configured patch must transform raw upstream microphone requests');
assertMicrophonePermissions(patchedFixture, 'Configured Gradle patch');
assert.match(patchedFixture, /permissionList\.add\(Manifest\.permission\.CAMERA\)/,
  'The microphone patch must preserve unrelated camera permission handling');
assert.equal(applyPermissionPatch(patchedFixture), patchedFixture, 'The permission patch must be safe to run again');
if (webChromeClient) assertMicrophonePermissions(applyPermissionPatch(webChromeClient), 'Local generated WebChromeClient');

for (const snippet of ['fun startAudioRecording(): String', 'fun stopAudioRecording(): String', 'fun audioAmplitude(): Int', 'maxAmplitude', 'MediaRecorder.AudioSource.MIC', 'MediaRecorder.OutputFormat.MPEG_4', 'Base64.NO_WRAP', 'override fun onDestroy()', 'cleanupNativeAudioRecording()', 'isTrustedLocalWebView()', 'Looper.myLooper() == Looper.getMainLooper()', 'latch.await(250, TimeUnit.MILLISECONDS)', 'maxNativeAudioDurationMs', 'maxNativeAudioBytes', 'setMaxDuration(maxNativeAudioDurationMs)']) {
  if (!mainActivity.includes(snippet)) {
    throw new Error(`Missing native Android microphone recorder bridge snippet: ${snippet}`);
  }
}

console.log('✅ Android microphone permissions present, WebView request patched, native recorder bridge present');

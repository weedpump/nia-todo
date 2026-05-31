#!/usr/bin/env node
import { readFileSync } from 'node:fs';

console.log('🤖 Running Android microphone permission test...');
const manifest = readFileSync('src-tauri/gen/android/app/src/main/AndroidManifest.xml', 'utf8');
const buildGradle = readFileSync('src-tauri/gen/android/app/build.gradle.kts', 'utf8');
const webChromeClient = readFileSync('src-tauri/gen/android/app/src/main/java/de/tobiaskneidl/nia_todo/generated/RustWebChromeClient.kt', 'utf8');

for (const permission of ['android.permission.RECORD_AUDIO']) {
  if (!manifest.includes(`android:name="${permission}"`)) {
    throw new Error(`Missing Android permission required for WebView microphone capture: ${permission}`);
  }
}

if (manifest.includes('android.permission.MODIFY_AUDIO_SETTINGS')) {
  throw new Error('Android manifest must not request MODIFY_AUDIO_SETTINGS for microphone capture');
}

if (!buildGradle.includes('patchTauriWebChromeMicrophonePermission')) {
  throw new Error('Android Gradle build must patch Tauri WebChromeClient microphone permission requests');
}

if (webChromeClient.includes('Manifest.permission.MODIFY_AUDIO_SETTINGS')) {
  throw new Error('Tauri WebChromeClient must request RECORD_AUDIO only; MODIFY_AUDIO_SETTINGS makes WebView getUserMedia fail with Permission denied');
}

console.log('✅ Android microphone permissions present and WebView request patched');

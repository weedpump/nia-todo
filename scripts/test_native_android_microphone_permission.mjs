#!/usr/bin/env node
import { readFileSync } from 'node:fs';

console.log('🤖 Running Android microphone permission test...');
const manifest = readFileSync('src-tauri/gen/android/app/src/main/AndroidManifest.xml', 'utf8');
for (const permission of ['android.permission.RECORD_AUDIO']) {
  if (!manifest.includes(`android:name="${permission}"`)) {
    throw new Error(`Missing Android permission required for WebView microphone capture: ${permission}`);
  }
}
console.log('✅ Android microphone permissions present');

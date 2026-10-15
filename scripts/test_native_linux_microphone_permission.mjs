#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rustSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
const releaseGateSource = readFileSync(new URL('./test_all.sh', import.meta.url), 'utf8');
const testPath = 'scripts/test_native_linux_microphone_permission.mjs';

assert(packageSource.includes(`node ${testPath}`), 'Linux microphone permission regression must run in test:native');
assert(releaseGateSource.includes(`node ${testPath}`), 'Linux microphone permission regression must run in the release gate');
assert.match(rustSource, /cfg\(all\(unix, not\(target_os = "macos"\), not\(target_os = "android"\)\)\)[\s\S]*on_permission_request/);
assert.match(rustSource, /PermissionKind::Microphone[\s\S]*is_trusted_microphone_webview[\s\S]*PermissionResponse::Allow/);
assert.match(rustSource, /PermissionKind::Microphone[\s\S]*PermissionResponse::Deny/);
assert.match(rustSource, /PermissionResponse::Default/);
assert.match(rustSource, /fn is_trusted_microphone_webview[\s\S]*label != "main"[\s\S]*tauri\.localhost[\s\S]*localhost/);

console.log('✅ Linux WebKitGTK microphone permission is restricted to the trusted main app WebView');

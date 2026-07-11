import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const repackScript = fs.readFileSync(path.join(repoRoot, 'scripts/release/repack-native-debian-deb.sh'), 'utf8');
const releaseScript = fs.readFileSync(path.join(repoRoot, 'release.sh'), 'utf8');
const tauriConfig = fs.readFileSync(path.join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8');
const linuxDesktopTemplate = fs.readFileSync(path.join(repoRoot, 'src-tauri/linux/nia-todo-desktop.desktop'), 'utf8');

assert.match(repackScript, /PACKAGE_NAME=.*nia-todo-desktop/, 'Debian desktop repack must default to Package: nia-todo-desktop');
assert.ok(repackScript.includes('sed -i "s/^Package:.*/Package: ${PACKAGE_NAME}/"'), 'Debian desktop repack must rewrite the Debian Package field');
assert.match(releaseScript, /repack-native-debian-deb\.sh "\$\{TAURI_DEBIAN_DEB\}"/, 'Release must repack the raw Tauri deb before staging');
assert.match(releaseScript, /dpkg-deb -f "\$\{BUILT_DEBIAN_DEB\}" Package\).*nia-todo-desktop/s, 'Release must verify the staged Debian deb package name');
assert.doesNotMatch(releaseScript, /cp "\$\{TAURI_DEBIAN_DEB\}" "\$\{DEBIAN_DEB_STAGING\}"/, 'Release must not stage the raw Tauri deb with Package: nia-todo');
assert.match(tauriConfig, /"desktopTemplate": "linux\/nia-todo-desktop\.desktop"/, 'Debian deb must use the custom desktop template');
assert.match(linuxDesktopTemplate, /^Exec=\{\{exec\}\} %u$/m, 'Debian desktop entry must pass deep-link URLs to the app');
assert.match(linuxDesktopTemplate, /^MimeType=x-scheme-handler\/nia-todo;$/m, 'Debian desktop entry must register the nia-todo URL scheme');

console.log('✅ Native Debian package name regression passed');

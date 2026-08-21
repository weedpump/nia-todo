import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const repackScript = fs.readFileSync(path.join(repoRoot, 'scripts/release/repack-native-debian-deb.sh'), 'utf8');
const buildWorkflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/build.yml'), 'utf8');
const tauriConfig = fs.readFileSync(path.join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8');
const linuxDesktopTemplate = fs.readFileSync(path.join(repoRoot, 'src-tauri/linux/nia-todo-desktop.desktop'), 'utf8');

assert.match(repackScript, /PACKAGE_NAME=.*nia-todo-desktop/, 'Debian desktop repack must default to Package: nia-todo-desktop');
assert.ok(repackScript.includes('sed -i "s/^Package:.*/Package: ${PACKAGE_NAME}/"'), 'Debian desktop repack must rewrite the Debian Package field');
assert.match(buildWorkflow, /repack-native-debian-deb\.sh src-tauri\/target\/release\/bundle\/deb\/nia-todo_\*_amd64\.deb/, 'Build workflow must repack the raw Tauri deb before staging');
assert.match(buildWorkflow, /cp "\$\{BUILT\}" dist\/ci-debian-desktop\/nia-todo-desktop-amd64\.deb/, 'Build workflow must stage the repacked Debian desktop deb');
assert.ok(
  !buildWorkflow.split('\n').some(line => line.includes('cp ') && line.includes('src-tauri/target/release/bundle/deb/nia-todo_') && line.includes('dist/ci-debian-desktop')),
  'Build workflow must not stage the raw Tauri deb with Package: nia-todo',
);
assert.match(tauriConfig, /"desktopTemplate": "linux\/nia-todo-desktop\.desktop"/, 'Debian deb must use the custom desktop template');
assert.match(linuxDesktopTemplate, /^Exec=\{\{exec\}\} %u$/m, 'Debian desktop entry must pass deep-link URLs to the app');
assert.match(linuxDesktopTemplate, /^MimeType=x-scheme-handler\/nia-todo;$/m, 'Debian desktop entry must register the nia-todo URL scheme');

console.log('✅ Native Debian package name regression passed');

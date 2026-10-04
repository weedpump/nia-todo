import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const repackScript = fs.readFileSync(path.join(repoRoot, 'scripts/release/repack-native-debian-deb.sh'), 'utf8');
const buildWorkflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/build.yml'), 'utf8');
const tauriConfig = fs.readFileSync(path.join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8');
const linuxDesktopTemplate = fs.readFileSync(path.join(repoRoot, 'src-tauri/linux/nia-todo-desktop.desktop'), 'utf8');

assert.match(repackScript, /PACKAGE_NAME=.*nia-todo-desktop/, 'Debian desktop repack must default to Package: nia-todo-desktop');
assert.match(repackScript, /APPLICATION_ID=.*de\.tobiaskneidl\.nia-todo/, 'Debian desktop repack must use the Tauri application ID');
assert.ok(repackScript.includes('sed -i "s/^Package:.*/Package: ${PACKAGE_NAME}/"'), 'Debian desktop repack must rewrite the Debian Package field');
assert.match(repackScript, /TAURI_DESKTOP_ENTRY=.*nia-todo\.desktop/, 'Debian desktop repack must locate the Tauri-generated desktop entry');
assert.match(repackScript, /PORTAL_DESKTOP_ENTRY=.*\$\{APPLICATION_ID\}\.desktop/, 'Debian desktop repack must target the portal application ID');
assert.match(
  repackScript,
  /mv "\$\{TAURI_DESKTOP_ENTRY\}" "\$\{PORTAL_DESKTOP_ENTRY\}"/,
  'Debian desktop repack must make the desktop filename match the registered portal application ID',
);
assert.match(buildWorkflow, /repack-native-debian-deb\.sh src-tauri\/target\/release\/bundle\/deb\/nia-todo_\*_amd64\.deb/, 'Build workflow must repack the raw Tauri deb before staging');
assert.match(buildWorkflow, /cp "\$\{BUILT\}" dist\/ci-debian-desktop\/nia-todo-desktop-amd64\.deb/, 'Build workflow must stage the repacked Debian desktop deb');
assert.ok(
  !buildWorkflow.split('\n').some(line => line.includes('cp ') && line.includes('src-tauri/target/release/bundle/deb/nia-todo_') && line.includes('dist/ci-debian-desktop')),
  'Build workflow must not stage the raw Tauri deb with Package: nia-todo',
);
assert.match(tauriConfig, /"desktopTemplate": "linux\/nia-todo-desktop\.desktop"/, 'Debian deb must use the custom desktop template');
assert.match(linuxDesktopTemplate, /^Exec=\{\{exec\}\} %u$/m, 'Debian desktop entry must pass deep-link URLs to the app');
assert.match(linuxDesktopTemplate, /^MimeType=x-scheme-handler\/nia-todo;$/m, 'Debian desktop entry must register the nia-todo URL scheme');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-todo-deb-repack-'));
try {
  const packageRoot = path.join(fixtureRoot, 'package');
  const desktopDir = path.join(packageRoot, 'usr/share/applications');
  const controlDir = path.join(packageRoot, 'DEBIAN');
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(path.join(controlDir, 'control'), [
    'Package: nia-todo',
    'Version: 1.0.0',
    'Architecture: amd64',
    'Maintainer: Test <test@example.invalid>',
    'Description: Debian repack fixture',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(desktopDir, 'nia-todo.desktop'), '[Desktop Entry]\nType=Application\nName=nia-todo\n');
  fs.writeFileSync(path.join(controlDir, 'md5sums'), '00000000000000000000000000000000  usr/share/applications/nia-todo.desktop\n');

  const rawDeb = path.join(fixtureRoot, 'nia-todo_1.0.0_amd64.deb');
  const finalDeb = path.join(fixtureRoot, 'nia-todo-desktop_1.0.0_amd64.deb');
  assert.equal(spawnSync('dpkg-deb', ['--build', packageRoot, rawDeb], { encoding: 'utf8' }).status, 0, 'Fixture deb must build');
  const repack = spawnSync(path.join(repoRoot, 'scripts/release/repack-native-debian-deb.sh'), [rawDeb, finalDeb], { encoding: 'utf8' });
  assert.equal(repack.status, 0, `Debian repack must succeed: ${repack.stderr}`);

  const extractedData = path.join(fixtureRoot, 'data');
  const extractedControl = path.join(fixtureRoot, 'control');
  assert.equal(spawnSync('dpkg-deb', ['-x', finalDeb, extractedData], { encoding: 'utf8' }).status, 0, 'Repacked data must extract');
  assert.equal(spawnSync('dpkg-deb', ['-e', finalDeb, extractedControl], { encoding: 'utf8' }).status, 0, 'Repacked control data must extract');
  const md5sums = fs.readFileSync(path.join(extractedControl, 'md5sums'), 'utf8');
  assert.match(md5sums, /usr\/share\/applications\/de\.tobiaskneidl\.nia-todo\.desktop/, 'md5sums must cover the renamed desktop entry');
  assert.doesNotMatch(md5sums, /usr\/share\/applications\/nia-todo\.desktop/, 'md5sums must not retain the removed desktop entry');
  const md5Check = spawnSync('md5sum', ['-c', path.join(extractedControl, 'md5sums')], { cwd: extractedData, encoding: 'utf8' });
  assert.equal(md5Check.status, 0, `Repacked md5sums must validate: ${md5Check.stdout}${md5Check.stderr}`);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('✅ Native Debian package name regression passed');

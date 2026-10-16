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
assert.match(repackScript, /PREINST=.*DEBIAN\/preinst/, 'Debian desktop repack must install a preinst maintainer script');
assert.match(repackScript, /if \[ -e \/usr\/bin\/nia-todo-desktop \]; then/, 'Debian desktop preinst must attempt the stop whenever the installed executable path exists');
assert.match(repackScript, /start-stop-daemon --stop --oknodo --retry=TERM\/10\/KILL\/5 --exec \/usr\/bin\/nia-todo-desktop/, 'Debian desktop preinst must stop the running app before package files are unpacked');
assert.match(repackScript, /Unsupported existing preinst interpreter/, 'Debian desktop repack must reject unsupported existing preinst interpreters');
assert.match(repackScript, /chmod 0755 "\$\{PREINST\}"/, 'Debian desktop preinst must be executable');
assert.match(repackScript, /TAURI_DESKTOP_ENTRY=.*nia-todo\.desktop/, 'Debian desktop repack must locate the Tauri-generated desktop entry');
assert.match(repackScript, /PORTAL_DESKTOP_ENTRY=.*\$\{APPLICATION_ID\}\.desktop/, 'Debian desktop repack must target the portal application ID');
assert.match(
  repackScript,
  /mv "\$\{TAURI_DESKTOP_ENTRY\}" "\$\{PORTAL_DESKTOP_ENTRY\}"/,
  'Debian desktop repack must make the desktop filename match the registered portal application ID',
);
assert.match(buildWorkflow, /repack-native-debian-deb\.sh/, 'Build workflow must repack the raw Tauri deb before staging');
assert.match(buildWorkflow, /dist\/ci-debian-desktop\/nia-todo-desktop-amd64\.deb/, 'Build workflow must stage the repacked Debian desktop deb');
assert.match(buildWorkflow, /src-tauri\/target\/release\/nia-todo-desktop-updater/, 'Build workflow must inject the restricted updater binary');
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
  const executableDir = path.join(packageRoot, 'usr/bin');
  const desktopDir = path.join(packageRoot, 'usr/share/applications');
  const controlDir = path.join(packageRoot, 'DEBIAN');
  fs.mkdirSync(executableDir, { recursive: true });
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(path.join(controlDir, 'control'), [
    'Package: nia-todo',
    'Version: 1.0.0',
    'Architecture: amd64',
    'Depends: libwebkit2gtk-4.1-0, libc6 (>= 2.34)',
    'Maintainer: Test <test@example.invalid>',
    'Description: Debian repack fixture',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(executableDir, 'nia-todo-desktop'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(desktopDir, 'nia-todo.desktop'), '[Desktop Entry]\nType=Application\nName=nia-todo\n');
  fs.writeFileSync(path.join(controlDir, 'md5sums'), '00000000000000000000000000000000  usr/share/applications/nia-todo.desktop\n');
  fs.writeFileSync(path.join(controlDir, 'preinst'), '#!/bin/sh\nset -e\necho original-preinst\nexit 0\n', { mode: 0o755 });

  const rawDeb = path.join(fixtureRoot, 'nia-todo_1.0.0_amd64.deb');
  const finalDeb = path.join(fixtureRoot, 'nia-todo-desktop_1.0.0_amd64.deb');
  const updaterBinary = path.join(fixtureRoot, 'nia-todo-desktop-updater');
  fs.writeFileSync(updaterBinary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(spawnSync('dpkg-deb', ['--build', packageRoot, rawDeb], { encoding: 'utf8' }).status, 0, 'Fixture deb must build');
  const repack = spawnSync(path.join(repoRoot, 'scripts/release/repack-native-debian-deb.sh'), [rawDeb, finalDeb, updaterBinary], { encoding: 'utf8' });
  assert.equal(repack.status, 0, `Debian repack must succeed: ${repack.stderr}`);
  const archiveContents = spawnSync('dpkg-deb', ['--contents', finalDeb], { encoding: 'utf8' });
  assert.equal(archiveContents.status, 0, `Repacked archive contents must be readable: ${archiveContents.stderr}`);
  for (const packagedPath of [
    './usr/lib/nia-todo-desktop/nia-todo-desktop-updater',
    './usr/share/polkit-1/actions/de.tobiaskneidl.nia-todo.desktop-update.policy',
    './var/lib/nia-todo-desktop/updater/',
  ]) {
    const line = archiveContents.stdout.split('\n').find(entry => entry.endsWith(packagedPath));
    assert.ok(line, `Repacked archive must contain ${packagedPath}`);
    assert.match(line, /\sroot\/root\s/, `${packagedPath} must be archived as root:root`);
  }

  const dependencies = spawnSync('dpkg-deb', ['-f', finalDeb, 'Depends'], { encoding: 'utf8' });
  assert.equal(dependencies.status, 0, `Repacked dependencies must be readable: ${dependencies.stderr}`);
  assert.match(dependencies.stdout, /libwebkit2gtk-4\.1-0/, 'Repack must preserve Tauri-generated WebKit dependencies');
  assert.match(dependencies.stdout, /libc6 \(>= 2\.34\)/, 'Repack must preserve Tauri-generated libc dependencies');
  assert.match(dependencies.stdout, /(?:^|, )gstreamer1\.0-plugins-bad(?:,|\s*$)/, 'Debian desktop package must install the GStreamer MediaRecorder runtime');
  assert.match(dependencies.stdout, /(?:^|, )pkexec(?:,|\s*$)/, 'Debian desktop package must install the Polkit execution runtime');

  const extractedData = path.join(fixtureRoot, 'data');
  const extractedControl = path.join(fixtureRoot, 'control');
  assert.equal(spawnSync('dpkg-deb', ['-x', finalDeb, extractedData], { encoding: 'utf8' }).status, 0, 'Repacked data must extract');
  assert.equal(spawnSync('dpkg-deb', ['-e', finalDeb, extractedControl], { encoding: 'utf8' }).status, 0, 'Repacked control data must extract');
  const preinstPath = path.join(extractedControl, 'preinst');
  const preinst = fs.readFileSync(preinstPath, 'utf8');
  assert.match(preinst, /start-stop-daemon --stop --oknodo --retry=TERM\/10\/KILL\/5 --exec \/usr\/bin\/nia-todo-desktop/, 'Repacked preinst must stop the running desktop executable');
  const stopExecutable = preinst.match(/start-stop-daemon .* --exec (\/[^\s]+)/)?.[1];
  assert.ok(stopExecutable, 'Repacked preinst must declare the executable it stops');
  assert.ok(fs.existsSync(path.join(extractedData, stopExecutable.slice(1))), 'Repacked preinst must stop an executable that exists in the package');
  assert.ok(preinst.indexOf('set -e') < preinst.indexOf('start-stop-daemon'), 'Repacked preinst must enable fail-fast behavior before stopping the app');
  assert.ok(preinst.indexOf('start-stop-daemon') < preinst.indexOf('original-preinst'), 'Repacked preinst must stop the app before running the original maintainer script body');
  assert.equal(fs.statSync(preinstPath).mode & 0o777, 0o755, 'Repacked preinst must be executable');
  const updaterPath = path.join(extractedData, 'usr/lib/nia-todo-desktop/nia-todo-desktop-updater');
  const policyPath = path.join(extractedData, 'usr/share/polkit-1/actions/de.tobiaskneidl.nia-todo.desktop-update.policy');
  const rootStagePath = path.join(extractedData, 'var/lib/nia-todo-desktop/updater');
  assert.equal(fs.statSync(updaterPath).mode & 0o777, 0o755, 'Restricted updater must be executable');
  assert.equal(fs.statSync(policyPath).mode & 0o777, 0o644, 'Polkit policy must not be executable');
  assert.equal(fs.statSync(rootStagePath).mode & 0o777, 0o700, 'Root update staging must not be accessible to users');
  const md5sums = fs.readFileSync(path.join(extractedControl, 'md5sums'), 'utf8');
  assert.match(md5sums, /usr\/share\/applications\/de\.tobiaskneidl\.nia-todo\.desktop/, 'md5sums must cover the renamed desktop entry');
  assert.match(md5sums, /usr\/lib\/nia-todo-desktop\/nia-todo-desktop-updater/, 'md5sums must cover the restricted updater');
  assert.match(md5sums, /usr\/share\/polkit-1\/actions\/de\.tobiaskneidl\.nia-todo\.desktop-update\.policy/, 'md5sums must cover the Polkit policy');
  assert.doesNotMatch(md5sums, /usr\/share\/applications\/nia-todo\.desktop/, 'md5sums must not retain the removed desktop entry');
  const md5Check = spawnSync('md5sum', ['-c', path.join(extractedControl, 'md5sums')], { cwd: extractedData, encoding: 'utf8' });
  assert.equal(md5Check.status, 0, `Repacked md5sums must validate: ${md5Check.stdout}${md5Check.stderr}`);

  const unsupportedRoot = path.join(fixtureRoot, 'unsupported-package');
  const unsupportedControl = path.join(unsupportedRoot, 'DEBIAN');
  fs.cpSync(packageRoot, unsupportedRoot, { recursive: true });
  fs.writeFileSync(path.join(unsupportedControl, 'preinst'), '#!/usr/bin/python3\nprint("original")\n', { mode: 0o755 });
  const unsupportedDeb = path.join(fixtureRoot, 'unsupported_1.0.0_amd64.deb');
  const unsupportedOutput = path.join(fixtureRoot, 'unsupported-repacked.deb');
  assert.equal(spawnSync('dpkg-deb', ['--build', unsupportedRoot, unsupportedDeb], { encoding: 'utf8' }).status, 0, 'Unsupported-interpreter fixture deb must build');
  const unsupportedRepack = spawnSync(path.join(repoRoot, 'scripts/release/repack-native-debian-deb.sh'), [unsupportedDeb, unsupportedOutput, updaterBinary], { encoding: 'utf8' });
  assert.notEqual(unsupportedRepack.status, 0, 'Debian repack must reject a non-shell preinst');
  assert.match(unsupportedRepack.stderr, /Unsupported existing preinst interpreter/, 'Unsupported preinst rejection must explain the interpreter constraint');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('✅ Native Debian package name regression passed');

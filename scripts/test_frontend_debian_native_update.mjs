#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const rawSignature = 'untrusted comment: signature from minisign secret key\nRWQ' + 'A'.repeat(96) + '\ntrusted comment: timestamp:1\tfile:nia-todo-desktop-amd64.deb\tversion:4.2.1\nRWQ' + 'B'.repeat(96) + '\n';
const signature = Buffer.from(rawSignature, 'utf8').toString('base64');
const scenario = String.raw`
  const calls = [];
  Object.defineProperty(globalThis, 'location', { value: new URL('https://todo.example.test/?nativeApp=tauri'), configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64', maxTouchPoints: 0 }, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: {
    __TAURI_INTERNALS__: {
      invoke: async (command, args = {}) => {
        calls.push({ command, args });
        if (command === 'desktop_install_debian_update') return true;
        throw new Error('unexpected invoke ' + command);
      },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  }, configurable: true });

  const signature = ${JSON.stringify(signature)};
  const { createNativeBridge } = await import('./web/static/js/features/native-bridge.js');
  const bridge = createNativeBridge();
  const download = {
    platform: 'debian',
    arch: 'amd64',
    version: 'v4.2.1',
    filename: 'nia-todo-desktop-v4.2.1-debian-amd64.deb',
    url: 'https://todo.example.test/downloads/nia-todo-desktop-v4.2.1-debian-amd64.deb',
    sha256: 'a'.repeat(64),
    sizeBytes: 12345,
    signature,
    debian_updater: true,
  };
  const installed = await bridge.installDebianUpdate(download);
  if (!installed) throw new Error('Debian native update result was not returned');
  const call = calls.find(item => item.command === 'desktop_install_debian_update');
  if (!call) throw new Error('Debian Tauri update command was not invoked');
  if (call.args.update?.filename !== download.filename) throw new Error('Debian filename was not forwarded');
  if (call.args.update?.version !== '4.2.1') throw new Error('Debian version was not normalized');
  if (call.args.update?.signature !== signature) throw new Error('Debian signature was not forwarded');
  if (call.args.update?.sizeBytes !== 12345) throw new Error('Debian size was not forwarded');

  const { validateDownloadEntry } = await import('./web/static/js/features/app-downloads.js');
  const signed = validateDownloadEntry({
    platform: 'debian', arch: 'amd64', version: 'v4.2.1',
    filename: 'nia-todo-desktop-v4.2.1-debian-amd64.deb',
    url: '/downloads/nia-todo-desktop-v4.2.1-debian-amd64.deb',
    sha256: 'a'.repeat(64), size_bytes: 12345, signature, debian_updater: true,
  });
  if (signed?.debian_updater !== true || signed?.signature !== signature) {
    throw new Error('signed Debian updater metadata was lost during validation');
  }
  const unsigned = validateDownloadEntry({
    platform: 'debian', arch: 'amd64', version: 'v4.2.1',
    filename: 'nia-todo-desktop-v4.2.1-debian-amd64.deb',
    url: '/downloads/nia-todo-desktop-v4.2.1-debian-amd64.deb',
    sha256: 'a'.repeat(64), size_bytes: 12345,
  });
  if (unsigned?.debian_updater !== false || unsigned?.signature !== '') {
    throw new Error('unsigned Debian package must remain on the external-download path');
  }
`;

const result = spawnSync(process.execPath, ['--input-type=module', '-e', scenario], {
  cwd: process.cwd(),
  encoding: 'utf8',
});
if (result.status !== 0) {
  throw new Error(`Debian native update frontend scenario failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
}

const appDownloadsSource = readFileSync('web/static/js/features/app-downloads.js', 'utf8');
if (!appDownloadsSource.includes("RUNTIME_PLATFORM === 'linux' && download.debian_updater === true")) {
  throw new Error('Debian native updater must only run for explicitly signed Debian artifacts');
}
if (!appDownloadsSource.includes('installDebianNativeUpdate')) {
  throw new Error('Debian update button must use the native Debian installer controller');
}

console.log('✅ Debian native update frontend test passed');

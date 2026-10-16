#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const scenario = String.raw`
  const calls = [];
  const listeners = new Map();
  Object.defineProperty(globalThis, 'location', { value: new URL('https://todo.example.test/?nativeApp=tauri'), configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32', maxTouchPoints: 0 }, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: {
    __TAURI_INTERNALS__: {
      invoke: async (command, args = {}) => {
        calls.push({ command, args });
        if (command === 'desktop_install_update') return true;
        throw new Error('unexpected invoke ' + command);
      },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: {
      unregisterListener: () => {},
    },
  }, configurable: true });

  const { createNativeBridge } = await import('./web/static/js/features/native-bridge.js');
  const bridge = createNativeBridge();
  bridge.listenNativeUpdateProgress = async (callback) => {
    listeners.set('progress', callback);
    return () => listeners.delete('progress');
  };
  const progress = [];
  const { installWindowsNativeUpdate } = await import('./web/static/js/features/windows-native-update.js');
  const installed = await installWindowsNativeUpdate(bridge, (payload) => progress.push(payload));
  if (!installed) throw new Error('native update result was not returned');
  if (!calls.some(call => call.command === 'desktop_install_update')) throw new Error('Tauri update command was not invoked');
  if (listeners.has('progress')) throw new Error('progress listener was not removed');

  const { validateDownloadEntry } = await import('./web/static/js/features/app-downloads.js');
  const signedDownload = validateDownloadEntry({
    platform: 'windows',
    arch: 'x64',
    version: 'v4.2.1',
    filename: 'nia-todo-v4.2.1-windows-x64-setup.exe',
    url: '/downloads/nia-todo-v4.2.1-windows-x64-setup.exe',
    sha256: 'a'.repeat(64),
    size_bytes: 12345,
    tauri_updater: true,
  });
  if (signedDownload?.tauri_updater !== true) throw new Error('signed updater capability was lost during manifest validation');
  const unsignedDownload = validateDownloadEntry({
    platform: 'windows',
    arch: 'x64',
    version: 'v4.2.1',
    filename: 'nia-todo-v4.2.1-windows-x64-setup.exe',
    url: '/downloads/nia-todo-v4.2.1-windows-x64-setup.exe',
    sha256: 'a'.repeat(64),
    size_bytes: 12345,
    tauri_updater: false,
  });
  if (unsignedDownload?.tauri_updater !== false) throw new Error('unsigned updater capability was not preserved');
`;

const result = spawnSync(process.execPath, ['--input-type=module', '-e', scenario], {
  cwd: process.cwd(),
  encoding: 'utf8',
});
if (result.status !== 0) {
  throw new Error(`Windows native update frontend scenario failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
}

const appDownloadsSource = readFileSync('web/static/js/features/app-downloads.js', 'utf8');
if (!appDownloadsSource.includes("download.tauri_updater === true")) {
  throw new Error('Windows native updater must only run for explicitly signed updater artifacts');
}
if (!appDownloadsSource.includes("t('update.native.install')")) {
  throw new Error('Windows native updater must label the native action as installation');
}
if (appDownloadsSource.includes("t('update.native.download')")) {
  throw new Error('Windows native updater must not retain the download action label');
}

const indexHtml = readFileSync('web/index.html', 'utf8');
if (!indexHtml.includes('data-i18n-key="update.native.install"')) {
  throw new Error('Native update button must use the installation translation key');
}

const expectedInstallLabels = {
  cs: 'Nainstalovat aktualizaci',
  de: 'Update installieren',
  en: 'Install update',
  es: 'Instalar actualización',
  fr: 'Installer la mise à jour',
  it: 'Installa aggiornamento',
  nl: 'Update installeren',
  pl: 'Zainstaluj aktualizację',
  'pt-BR': 'Instalar atualização',
  ru: 'Установить обновление',
  sv: 'Installera uppdatering',
  'zh-CN': '安装更新',
};
for (const [locale, expected] of Object.entries(expectedInstallLabels)) {
  const dictionary = JSON.parse(readFileSync(`web/static/i18n/${locale}.json`, 'utf8'));
  if (dictionary['update.native.install'] !== expected) {
    throw new Error(`${locale} must translate update.native.install as ${expected}`);
  }
  if ('update.native.download' in dictionary) {
    throw new Error(`${locale} must not retain update.native.download`);
  }
}

console.log('✅ Windows native update frontend test passed');

#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const originalWindow = globalThis.window;
const originalLocation = globalThis.location;
const originalDocument = globalThis.document;
const originalNavigator = globalThis.navigator;

try {
  globalThis.window = {
    NIA_TODO_NATIVE: true,
    NIA_TODO_PLATFORM: 'android',
    location: { origin: 'https://todo.example.test', search: '?nativeApp=tauri' },
  };
  globalThis.location = globalThis.window.location;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Android' } });
  globalThis.document = {
    documentElement: { classList: { contains: () => false } },
    body: { classList: { contains: () => false } },
  };

  const downloadsModule = await import(pathToFileURL(`${process.cwd()}/web/static/js/features/app-downloads.js`).href);
  const androidModule = await import(pathToFileURL(`${process.cwd()}/web/static/js/features/android-native-update.js`).href);
  const nativeBridgeModule = await import(pathToFileURL(`${process.cwd()}/web/static/js/features/native-bridge.js`).href);
  const { validateDownloadEntry } = downloadsModule;
  const {
    createAndroidUpdatePermissionFlow,
    createAndroidUpdateResumeCoordinator,
    runAndroidUpdateBridgeAction,
  } = androidModule;
  const { createNativeBridge } = nativeBridgeModule;

  const download = validateDownloadEntry({
    platform: 'android',
    arch: 'arm64',
    version: 'v4.2.1',
    filename: 'nia-todo-v4.2.1-android-arm64.apk',
    url: '/downloads/nia-todo-v4.2.1-android-arm64.apk',
    sha256: 'a'.repeat(64),
    size_bytes: 123456,
    android_updater: true,
  }, 'v4.2.1');
  if (!download?.android_updater) throw new Error('signed Android APK must opt into native updates');

  const legacy = validateDownloadEntry({
    platform: 'android',
    arch: 'arm64',
    version: 'v4.2.1',
    filename: 'nia-todo-v4.2.1-android-arm64.apk',
    url: '/downloads/nia-todo-v4.2.1-android-arm64.apk',
    sha256: 'a'.repeat(64),
    size_bytes: 123456,
  }, 'v4.2.1');
  if (legacy?.android_updater) throw new Error('legacy Android APK must remain an external download');

  let permissionState = 'prompt';
  let settingsOpened = 0;
  let installCalls = 0;
  let receivedDownload = null;
  let receivedProgress = null;
  const bridge = {
    androidUpdatePermissionState: async () => permissionState,
    openAndroidUpdatePermissionSettings: async () => { settingsOpened += 1; return true; },
    installAndroidUpdate: async (value, onProgress) => {
      installCalls += 1;
      receivedDownload = value;
      onProgress({ phase: 'downloading', downloadedBytes: 25, totalBytes: 100 });
      return true;
    },
  };
  const flow = createAndroidUpdatePermissionFlow(bridge);
  const first = await flow.start(download, (progress) => { receivedProgress = progress; });
  if (first.status !== 'permission-required' || installCalls !== 0 || !flow.hasPendingUpdate()) {
    throw new Error('missing Android install permission must pause the update before download');
  }
  if (!await flow.openPermissionSettings() || settingsOpened !== 1) {
    throw new Error('permission dialog must open Android install-source settings');
  }
  const denied = await flow.resume();
  if (denied.status !== 'permission-required' || installCalls !== 0 || !flow.hasPendingUpdate()) {
    throw new Error('returning without permission must keep the update paused');
  }
  permissionState = 'granted';
  const resumed = await flow.resume();
  if (resumed.status !== 'started' || !(resumed.installPromise instanceof Promise) || installCalls !== 1 || flow.hasPendingUpdate()) {
    throw new Error('returning with permission must automatically continue the pending update');
  }
  if (await resumed.installPromise !== true) {
    throw new Error('Android update flow must expose the native installation result');
  }
  if (receivedDownload !== download || receivedProgress?.downloadedBytes !== 25) {
    throw new Error('Android update flow must preserve the validated download and progress callback');
  }

  const resumeOrder = [];
  let releaseResume;
  const resumeGate = new Promise(resolve => { releaseResume = resolve; });
  const coordinateResume = createAndroidUpdateResumeCoordinator(
    async () => { resumeOrder.push('resume:start'); await resumeGate; resumeOrder.push('resume:end'); },
    async () => { resumeOrder.push('refresh'); },
  );
  const coordinatedA = coordinateResume();
  const coordinatedB = coordinateResume();
  if (coordinatedA !== coordinatedB || resumeOrder.join(',') !== 'resume:start') {
    throw new Error('Android settings return must deduplicate concurrent focus/visibility events');
  }
  releaseResume();
  await coordinatedA;
  if (resumeOrder.join(',') !== 'resume:start,resume:end,refresh') {
    throw new Error('Android settings return must finish permission resume before manifest refresh');
  }
  let refreshAfterFailure = 0;
  const coordinateFailedResume = createAndroidUpdateResumeCoordinator(
    async () => ({ skipRefresh: true }),
    async () => { refreshAfterFailure += 1; },
  );
  await coordinateFailedResume();
  if (refreshAfterFailure !== 0) {
    throw new Error('Android permission bridge failures must preserve the visible error instead of refreshing the modal');
  }

  const postedRequests = [];
  window.NiaAndroidUpdater = {
    postMessage(raw) { postedRequests.push(JSON.parse(raw)); },
  };
  const nativeBridgeA = createNativeBridge();
  const firstNativeInstall = nativeBridgeA.installAndroidUpdate(download);
  const firstRequest = postedRequests.at(-1);
  window.__niaAndroidUpdateComplete(firstRequest.requestId, true, { started: true });
  if (await firstNativeInstall !== true) throw new Error('first Android native install request did not settle');
  const nativeBridgeB = createNativeBridge();
  const secondNativeInstall = nativeBridgeB.installAndroidUpdate(download);
  const secondRequest = postedRequests.at(-1);
  window.__niaAndroidUpdateComplete(secondRequest.requestId, true, { started: true });
  const secondResult = await Promise.race([
    secondNativeInstall,
    new Promise((_, reject) => setTimeout(() => reject(new Error('second bridge request remained pending')), 100)),
  ]);
  if (secondResult !== true) throw new Error('second Android native install request did not settle');

  const recoveredErrors = [];
  for (const operation of ['permission-check', 'settings-open', 'permission-resume']) {
    const result = await runAndroidUpdateBridgeAction(
      async () => { throw new Error(operation); },
      async error => { recoveredErrors.push(error.message); },
    );
    if (result.status !== 'error' || result.error?.message !== operation) {
      throw new Error(`${operation} rejection must become a recoverable Android update result`);
    }
  }
  if (recoveredErrors.join(',') !== 'permission-check,settings-open,permission-resume') {
    throw new Error('all Android updater bridge failures must use the shared UI recovery path');
  }

  const indexHtml = readFileSync('web/index.html', 'utf8');
  for (const id of [
    'android-update-permission-modal',
    'android-update-permission-open-settings',
    'android-update-permission-cancel',
    'android-update-permission-message',
  ]) {
    if (!indexHtml.includes(`id="${id}"`)) throw new Error(`Android update permission dialog missing ${id}`);
  }
  const appDownloadsSource = readFileSync('web/static/js/features/app-downloads.js', 'utf8');
  if (!appDownloadsSource.includes("RUNTIME_PLATFORM === 'android' && download.android_updater === true")) {
    throw new Error('Android updater-capable APK must use the native installation path');
  }
  if (!appDownloadsSource.includes('androidUpdatePermissionFlow.resume()')) {
    throw new Error('Android update must resume automatically after returning from settings');
  }
  const requiredKeys = [
    'update.android.permission.title',
    'update.android.permission.body',
    'update.android.permission.denied',
    'update.android.permission.openSettings',
  ];
  for (const locale of ['cs', 'de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'zh-CN']) {
    const dictionary = JSON.parse(readFileSync(`web/static/i18n/${locale}.json`, 'utf8'));
    for (const key of requiredKeys) {
      if (!dictionary[key]) throw new Error(`${locale} missing ${key}`);
    }
  }

  console.log('✅ Android native update frontend test passed');
} finally {
  globalThis.window = originalWindow;
  globalThis.location = originalLocation;
  globalThis.document = originalDocument;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
}

import { RUNTIME_CAPABILITIES } from '../core/config.js';
import { t } from '../i18n/index.js';
import { createNativeBridge } from './native-bridge.js';

const nativeBridge = createNativeBridge();
const HOTKEY_DESCRIPTION_RETRY_INITIAL_MS = 500;
const HOTKEY_DESCRIPTION_RETRY_MAX_MS = 15_000;

let pendingHotkeyDescriptions = null;
let hotkeyDescriptionSyncPromise = null;
let hotkeyDescriptionRetryTimer = null;
let hotkeyDescriptionRetryDelay = HOTKEY_DESCRIPTION_RETRY_INITIAL_MS;
let hotkeyLanguageSyncBound = false;

function supportsNativeHotkeys() {
  return Boolean(RUNTIME_CAPABILITIES.desktop && RUNTIME_CAPABILITIES.nativeHotkeys);
}

export function localizedHotkeyDescriptions() {
  return {
    toggleApp: t('settings.desktop.hotkeys.toggleApp'),
    newTodo: t('settings.desktop.hotkeys.newTodo'),
    search: t('settings.desktop.hotkeys.search'),
  };
}

function scheduleHotkeyDescriptionRetry() {
  if (hotkeyDescriptionRetryTimer || !pendingHotkeyDescriptions) return;
  const delay = hotkeyDescriptionRetryDelay;
  hotkeyDescriptionRetryDelay = Math.min(delay * 2, HOTKEY_DESCRIPTION_RETRY_MAX_MS);
  hotkeyDescriptionRetryTimer = setTimeout(() => {
    hotkeyDescriptionRetryTimer = null;
    syncDesktopHotkeyDescriptions();
  }, delay);
}

async function drainHotkeyDescriptionSync() {
  while (pendingHotkeyDescriptions) {
    const descriptions = pendingHotkeyDescriptions;
    pendingHotkeyDescriptions = null;
    try {
      await nativeBridge.syncHotkeyDescriptions(descriptions);
      hotkeyDescriptionRetryDelay = HOTKEY_DESCRIPTION_RETRY_INITIAL_MS;
    } catch (error) {
      if (!pendingHotkeyDescriptions) pendingHotkeyDescriptions = descriptions;
      console.warn('[Desktop] Failed to synchronize localized hotkey descriptions; retrying', error);
      scheduleHotkeyDescriptionRetry();
      break;
    }
  }
}

export function syncDesktopHotkeyDescriptions() {
  if (!supportsNativeHotkeys()) return Promise.resolve();
  pendingHotkeyDescriptions = localizedHotkeyDescriptions();
  if (hotkeyDescriptionRetryTimer) {
    clearTimeout(hotkeyDescriptionRetryTimer);
    hotkeyDescriptionRetryTimer = null;
  }
  if (!hotkeyDescriptionSyncPromise) {
    hotkeyDescriptionSyncPromise = drainHotkeyDescriptionSync().finally(() => {
      hotkeyDescriptionSyncPromise = null;
      if (pendingHotkeyDescriptions) scheduleHotkeyDescriptionRetry();
    });
  }
  return hotkeyDescriptionSyncPromise;
}

export function bindDesktopHotkeyDescriptionSync() {
  if (hotkeyLanguageSyncBound || !supportsNativeHotkeys()) return;
  hotkeyLanguageSyncBound = true;
  window.addEventListener('nia-language-change', () => {
    syncDesktopHotkeyDescriptions();
  });
}

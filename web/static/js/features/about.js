import { API, RUNTIME_CAPABILITIES } from '../core/config.js';
import { t } from '../i18n/index.js';
import { iconSvg } from '../icons/lucide-icons.js';
import { createNativeBridge } from './native-bridge.js';

function displayVersion(value) {
  const normalized = String(value || '').trim().replace(/^v/i, '');
  return normalized ? `v${normalized}` : '–';
}

function connectedServerUrl() {
  return String(API || window.location.origin || '').replace(/\/$/, '');
}

export function createAboutFeature({ appVersion, serverUpdatesApi, openAppDownloadsModal, getClientUpdateStatus }) {
  const nativeBridge = createNativeBridge();
  let actionsBound = false;
  let lastFocusedElement = null;
  let renderGeneration = 0;

  function renderVersionStatus(targetId, status = {}) {
    const target = document.getElementById(targetId);
    if (!target) return;
    const known = status?.known === true;
    const stale = Boolean(status?.stale);
    const updateAvailable = Boolean(status?.updateAvailable);
    const visible = known || stale;
    target.hidden = !visible;
    target.classList.toggle('is-current', known && !stale && !updateAvailable);
    target.classList.toggle('has-update', visible && (stale || updateAvailable));
    target.innerHTML = visible ? iconSvg(stale || updateAvailable ? 'triangle-alert' : 'check-circle') : '';
    if (!visible) {
      target.removeAttribute('aria-label');
    } else if (stale) {
      target.setAttribute('aria-label', t('about.updateStatusStale'));
    } else {
      target.setAttribute('aria-label', t(updateAvailable ? 'admin.serverUpdate.badge.available' : 'admin.serverUpdate.badge.current'));
    }
  }

  function setUpdateNote(message = '', state = '') {
    const note = document.getElementById('about-update-note');
    const row = document.getElementById('about-server-version-row');
    if (!note || !row) return;
    note.textContent = message;
    note.hidden = !message;
    note.dataset.state = state;
    row.classList.toggle('update-available', state === 'available');
  }

  async function renderClientVersion(generation) {
    const label = document.getElementById('about-client-version-label');
    const value = document.getElementById('about-client-version');
    if (!label || !value) return;
    const version = RUNTIME_CAPABILITIES.native ? await nativeBridge.getAppVersion() : appVersion;
    if (generation !== renderGeneration) return;
    label.textContent = t(RUNTIME_CAPABILITIES.native ? 'about.appVersion' : 'about.webAppVersion');
    value.textContent = displayVersion(version);
    try {
      const status = await getClientUpdateStatus?.();
      if (generation !== renderGeneration) return;
      renderVersionStatus('about-client-version-status', status);
    } catch (error) {
      console.warn('[About] Client update status unavailable', error);
      if (generation !== renderGeneration) return;
      renderVersionStatus('about-client-version-status', { known: false });
    }
  }

  async function renderServerStatus(generation) {
    const current = document.getElementById('about-server-version');
    const latest = document.getElementById('about-latest-server-version');
    const versionUpdate = document.getElementById('about-server-version-update');
    if (!current || !latest || !versionUpdate) return;
    current.textContent = '…';
    latest.textContent = '…';
    versionUpdate.hidden = true;
    setUpdateNote();
    try {
      const status = await serverUpdatesApi.status();
      if (generation !== renderGeneration) return;
      current.textContent = displayVersion(status?.current_version);
      latest.textContent = displayVersion(status?.latest_version);
      versionUpdate.hidden = !status?.update_available;
      renderVersionStatus('about-server-version-status', {
        known: Boolean(status?.current_version && status?.latest_version),
        updateAvailable: Boolean(status?.update_available),
        stale: Boolean(status?.stale),
      });
      if (status?.stale) setUpdateNote(t('about.updateStatusStale'), 'stale');
    } catch (error) {
      console.warn('[About] Server update status unavailable', error);
      if (generation !== renderGeneration) return;
      current.textContent = '–';
      latest.textContent = '–';
      versionUpdate.hidden = true;
      renderVersionStatus('about-server-version-status', { known: false });
      setUpdateNote(t('about.updateStatusUnavailable'), 'unavailable');
    }
  }

  async function openAboutModal({ returnFocusTo = null } = {}) {
    const modal = document.getElementById('about-modal');
    if (!modal) return;
    const generation = ++renderGeneration;
    if (returnFocusTo) lastFocusedElement = returnFocusTo;
    else if (!modal.contains(document.activeElement)) lastFocusedElement = document.activeElement;
    const serverUrl = connectedServerUrl();
    const serverTarget = document.getElementById('about-server-url');
    if (serverTarget) {
      serverTarget.textContent = serverUrl || '–';
      serverTarget.title = serverUrl;
    }
    document.getElementById('about-reload-btn')?.toggleAttribute('hidden', RUNTIME_CAPABILITIES.native);
    document.getElementById('about-downloads-btn')?.toggleAttribute('hidden', RUNTIME_CAPABILITIES.native);
    modal.classList.add('active');
    modal.removeAttribute('aria-hidden');
    modal.querySelector('.modal-close-x')?.focus();
    await Promise.all([renderClientVersion(generation), renderServerStatus(generation)]);
  }

  function closeAboutModal({ restoreFocus = true } = {}) {
    renderGeneration += 1;
    const modal = document.getElementById('about-modal');
    modal?.classList.remove('active');
    modal?.setAttribute('aria-hidden', 'true');
    if (restoreFocus && lastFocusedElement?.isConnected) lastFocusedElement.focus();
  }

  function trapAboutFocus(event) {
    if (event.key !== 'Tab') return;
    const modal = document.getElementById('about-modal');
    if (!modal?.classList.contains('active')) return;
    const focusable = Array.from(modal.querySelectorAll('a[href], button:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])'))
      .filter(element => !element.closest('[hidden]'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function copyServerUrl(button) {
    const serverUrl = connectedServerUrl();
    if (!serverUrl) return;
    try {
      await navigator.clipboard.writeText(serverUrl);
      button?.classList.add('copied');
      button?.setAttribute('title', t('about.copied'));
      window.setTimeout(() => {
        button?.classList.remove('copied');
        button?.setAttribute('title', t('about.copyServer'));
      }, 1600);
    } catch (error) {
      console.warn('[About] Server URL could not be copied', error);
    }
  }

  function bindAboutActions() {
    if (actionsBound) return;
    actionsBound = true;
    document.addEventListener('click', (event) => {
      if (event.target?.closest?.('[data-close-modal="about-modal"]')) {
        closeAboutModal();
        return;
      }
      const target = event.target?.closest?.('[data-about-action]');
      if (!target) return;
      event.preventDefault();
      if (target.dataset.aboutAction === 'copy-server') {
        copyServerUrl(target);
        return;
      }
      if (target.dataset.aboutAction === 'downloads') {
        const returnFocusTo = lastFocusedElement;
        closeAboutModal({ restoreFocus: false });
        openAppDownloadsModal?.({ returnFocusTo });
      }
    });
    document.addEventListener('keydown', (event) => {
      const modal = document.getElementById('about-modal');
      if (!modal?.classList.contains('active')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAboutModal();
        return;
      }
      trapAboutFocus(event);
    });
    window.addEventListener('nia-language-change', () => {
      if (document.getElementById('about-modal')?.classList.contains('active')) openAboutModal();
    });
  }

  return { openAboutModal, bindAboutActions };
}

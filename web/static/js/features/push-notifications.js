import { t } from '../i18n/index.js';

export function createPushNotificationsFeature({ pushApi }) {
  let pushSubscription = null;
  let lastPushStatus = 'default';
  let lastPushError = '';

  function pushMessage(key, params = {}) {
    return { key, params };
  }

  function renderPushMessage(message) {
    if (!message) return '';
    if (typeof message === 'object' && message.key) return t(message.key, message.params || {});
    return String(message);
  }

  function updatePushStatus(status, errorText) {
    const statusEl = document.getElementById('push-status');
    const enableBtn = document.getElementById('push-enable-btn');
    const disableBtn = document.getElementById('push-disable-btn');
    const testBtn = document.getElementById('push-test-btn');
    const errorEl = document.getElementById('push-error');
    if (!statusEl) return;

    lastPushStatus = status;
    lastPushError = errorText || '';
    const texts = {
      granted: t('settings.push.state.granted'),
      denied: t('settings.push.state.denied'),
      default: t('settings.push.state.default'),
      unknown: t('settings.push.state.unknown'),
      unsupported: t('settings.push.state.unsupported'),
    };
    statusEl.textContent = t('settings.push.status', { status: texts[status] || status });

    if (enableBtn) enableBtn.style.display = status === 'default' ? 'inline-block' : 'none';
    if (disableBtn) disableBtn.style.display = status === 'granted' ? 'inline-block' : 'none';
    if (testBtn) testBtn.style.display = status === 'granted' ? 'inline-block' : 'none';
    if (errorEl) errorEl.textContent = renderPushMessage(errorText);
  }

  async function updatePushSettingsUI() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      updatePushStatus('unsupported');
      return;
    }
    const perm = Notification.permission;

    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      pushSubscription = sub || null;

      if (perm === 'granted' && sub) {
        try {
          const serverStatus = await pushApi.status();
          if (!serverStatus.has_subscriptions) {
            updatePushStatus('default', pushMessage('settings.push.serverSubscriptionMissing'));
            return;
          }
        } catch (e) {
          console.error('[Push] Server status check failed:', e);
        }
        updatePushStatus('granted');
      } else if (perm === 'granted' && !sub) {
        updatePushStatus('default', pushMessage('settings.push.browserSubscriptionMissing'));
      } else if (perm === 'denied') {
        updatePushStatus('denied', pushMessage('settings.push.browserSettingsHint'));
      } else {
        updatePushStatus('default');
      }
    } catch (e) {
      console.error('[Push] Error checking subscription:', e);
      updatePushStatus('unknown', pushMessage('settings.push.statusCheckFailed'));
    }
  }

  async function enablePushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      updatePushStatus('unsupported', pushMessage('settings.push.unsupportedBrowser'));
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        updatePushStatus(perm, pushMessage('settings.push.permissionNotGranted'));
        return;
      }

      const keyData = await pushApi.vapidPublicKey();
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyData.public_key),
      });
      pushSubscription = sub;

      await pushApi.subscribe({
        endpoint: sub.endpoint,
        keys: {
          p256dh: arrayBufferToBase64(sub.getKey('p256dh')),
          auth: arrayBufferToBase64(sub.getKey('auth')),
        },
      });
      updatePushStatus('granted');
    } catch (e) {
      console.error('[Push] Enable failed:', e);
      updatePushStatus('default', String(e.message || e) || pushMessage('settings.push.enableFailed'));
    }
  }

  async function disablePushNotifications() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await pushApi.unsubscribe({ endpoint: sub.endpoint, keys: {} });
        const unsubResult = await sub.unsubscribe();
        if (!unsubResult) throw new Error(t('settings.push.browserUnsubscribeFailed'));
      }
      pushSubscription = null;
      updatePushStatus('default', pushMessage('settings.push.disabled'));
    } catch (e) {
      console.error('[Push] Disable failed:', e);
      updatePushStatus('default', pushMessage('settings.push.disableFailed', { error: String(e.message || e) }));
    }
  }

  async function sendTestPush() {
    try {
      const result = await pushApi.test({ title: t('settings.push.testTitle'), body: t('settings.push.testBody') });
      if (result?.sent === false) {
        updatePushStatus('granted', pushMessage('settings.push.testNotSent'));
        return;
      }
      updatePushStatus('granted', pushMessage('settings.push.testSent'));
    } catch (e) {
      updatePushStatus('granted', String(e.message || e) || pushMessage('settings.push.sendFailed'));
    }
  }

  let pushActionsBound = false;
  function bindPushActions() {
    if (pushActionsBound) return;
    pushActionsBound = true;
    document.addEventListener('click', async (event) => {
      const target = event.target?.closest?.('[data-push-action]');
      if (!target) return;
      event.preventDefault();
      const action = target.dataset.pushAction;
      if (action === 'enable') await enablePushNotifications();
      else if (action === 'disable') await disablePushNotifications();
      else if (action === 'test') await sendTestPush();
    });
  }

  window.addEventListener('nia-language-change', () => {
    setTimeout(() => updatePushStatus(lastPushStatus, lastPushError), 0);
  });

  return {
    updatePushStatus,
    updatePushSettingsUI,
    enablePushNotifications,
    disablePushNotifications,
    sendTestPush,
    bindPushActions,
    getPushSubscription: () => pushSubscription,
  };
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

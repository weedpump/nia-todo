export function createPushNotificationsFeature({ pushApi }) {
  let pushSubscription = null;

  function updatePushStatus(status, errorText) {
    const statusEl = document.getElementById('push-status');
    const enableBtn = document.getElementById('push-enable-btn');
    const disableBtn = document.getElementById('push-disable-btn');
    const testBtn = document.getElementById('push-test-btn');
    const errorEl = document.getElementById('push-error');
    if (!statusEl) return;

    const texts = {
      granted: '✅ Erlaubt — du bekommst Benachrichtigungen',
      denied: '❌ Blockiert — in den Browser-Einstellungen änderbar',
      default: '⏳ Nicht gefragt',
      unknown: '❓ Service Worker nicht verfügbar',
      unsupported: '❌ Nicht unterstützt (kein HTTPS?)',
    };
    statusEl.textContent = 'Status: ' + (texts[status] || status);

    if (enableBtn) enableBtn.style.display = status === 'default' ? 'inline-block' : 'none';
    if (disableBtn) disableBtn.style.display = status === 'granted' ? 'inline-block' : 'none';
    if (testBtn) testBtn.style.display = status === 'granted' ? 'inline-block' : 'none';
    if (errorEl) errorEl.textContent = errorText || '';
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
            updatePushStatus('default', 'Berechtigung vorhanden, aber Server kennt keine aktive Subscription. Klicke "Aktivieren".');
            return;
          }
        } catch (e) {
          console.error('[Push] Server status check failed:', e);
        }
        updatePushStatus('granted');
      } else if (perm === 'granted' && !sub) {
        updatePushStatus('default', 'Berechtigung vorhanden, aber keine aktive Subscription. Klicke "Aktivieren".');
      } else if (perm === 'denied') {
        updatePushStatus('denied', 'In den Browser-Einstellungen für diese Seite änderbar.');
      } else {
        updatePushStatus('default');
      }
    } catch (e) {
      console.error('[Push] Error checking subscription:', e);
      updatePushStatus('unknown', 'Fehler beim Prüfen des Push-Status');
    }
  }

  async function enablePushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      updatePushStatus('unsupported', 'Push-Benachrichtigungen werden in diesem Browser nicht unterstützt.');
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        updatePushStatus(perm, 'Berechtigung nicht erteilt.');
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
      updatePushStatus('default', String(e.message || e) || 'Fehler beim Aktivieren');
    }
  }

  async function disablePushNotifications() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await pushApi.unsubscribe({ endpoint: sub.endpoint, keys: {} });
        const unsubResult = await sub.unsubscribe();
        if (!unsubResult) throw new Error('Browser-Subscription konnte nicht gelöscht werden');
      }
      pushSubscription = null;
      updatePushStatus('default', 'Push-Benachrichtigungen deaktiviert.');
    } catch (e) {
      console.error('[Push] Disable failed:', e);
      updatePushStatus('default', 'Fehler beim Deaktivieren: ' + String(e.message || e));
    }
  }

  async function sendTestPush() {
    try {
      const result = await pushApi.test({ title: 'Test 🔔', body: 'Push Notifications funktionieren!' });
      if (result?.sent === false) {
        updatePushStatus('granted', 'Test-Benachrichtigung konnte nicht gesendet werden. Keine aktive Subscription oder Push-Dienst hat abgelehnt.');
        return;
      }
      updatePushStatus('granted', 'Test-Benachrichtigung gesendet!');
    } catch (e) {
      updatePushStatus('granted', String(e.message || e) || 'Fehler beim Senden');
    }
  }

  return {
    updatePushStatus,
    updatePushSettingsUI,
    enablePushNotifications,
    disablePushNotifications,
    sendTestPush,
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

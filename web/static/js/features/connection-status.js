export function updateConnectionStatus(wsState, { pendingCount = 0, syncing = false } = {}) {
  const indicator = document.getElementById('online-status');
  if (!indicator) return;

  if (syncing) {
    indicator.style.display = 'inline-flex';
    indicator.className = 'status-syncing';
    indicator.dataset.count = '';
    indicator.textContent = 'Sync';
    indicator.title = 'Synchronisierung läuft';
    return;
  }

  if (pendingCount > 0) {
    indicator.style.display = 'inline-flex';
    indicator.className = 'status-pending-sync';
    indicator.dataset.count = String(Math.min(pendingCount, 99));
    indicator.textContent = `${pendingCount}`;
    indicator.title = `${pendingCount} lokale Änderung${pendingCount === 1 ? '' : 'en'} warten auf Sync`;
    return;
  }

  if (wsState === 'connected') {
    indicator.style.display = 'none';
    indicator.className = 'status-online';
    indicator.dataset.count = '';
    indicator.textContent = '';
    indicator.title = '';
  } else {
    indicator.style.display = 'inline-block';
    indicator.className = 'status-offline';
    indicator.dataset.count = '';
    indicator.textContent = '';
    indicator.title = 'Offline';
  }
}

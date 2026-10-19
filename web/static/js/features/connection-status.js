import { t } from '../i18n/index.js';
import { iconSvg } from '../icons/lucide-icons.js';

function setForceRefreshButtonsEnabled(enabled) {
  document.querySelectorAll('#force-refresh-btn, [data-force-refresh-button]').forEach((button) => {
    button.disabled = !enabled;
    button.classList.toggle('is-offline-disabled', !enabled);
    button.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    button.title = enabled ? t('version.refreshCache') : t('connection.offline');
  });
}

export function updateConnectionStatus(wsState, { pendingCount = 0 } = {}) {
  const indicator = document.getElementById('online-status');
  if (!indicator) return;

  if (pendingCount > 0) {
    indicator.style.display = 'inline-flex';
    indicator.className = 'status-pending-sync';
    indicator.dataset.count = String(Math.min(pendingCount, 99));
    indicator.innerHTML = `<span class="status-sync-icon">${iconSvg('refresh-cw')}</span><span class="status-sync-count">${pendingCount}</span>`;
    indicator.title = t(pendingCount === 1 ? 'connection.pendingSync.one' : 'connection.pendingSync.many', { count: pendingCount });
    setForceRefreshButtonsEnabled(wsState === 'connected' && navigator.onLine !== false);
    return;
  }

  if (wsState === 'connected') {
    indicator.style.display = 'none';
    indicator.className = 'status-online';
    indicator.dataset.count = '';
    indicator.textContent = '';
    indicator.title = '';
    setForceRefreshButtonsEnabled(true);
  } else if (wsState === 'reconnecting' && indicator.className === 'status-offline') {
    setForceRefreshButtonsEnabled(false);
  } else if (wsState === 'connecting' || wsState === 'reconnecting') {
    indicator.style.display = 'none';
    indicator.className = 'status-checking';
    indicator.dataset.count = '';
    indicator.textContent = '';
    indicator.title = '';
    setForceRefreshButtonsEnabled(true);
  } else {
    indicator.style.display = 'inline-flex';
    indicator.className = 'status-offline';
    indicator.dataset.count = '';
    indicator.textContent = t('connection.offline');
    indicator.title = t('connection.offline');
    setForceRefreshButtonsEnabled(false);
  }
}

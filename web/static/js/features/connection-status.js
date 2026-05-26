export function updateConnectionStatus(wsState) {
  const indicator = document.getElementById('online-status');
  if (!indicator) return;

  if (wsState === 'connected') {
    indicator.style.display = 'none';
    indicator.className = 'status-online';
  } else {
    indicator.style.display = 'inline-block';
    indicator.className = 'status-offline';
    indicator.textContent = '';
  }
}

export function createServerUpdateIndicator({
  serverUpdatesApi = null,
  getElement = () => document.getElementById('server-update-indicator'),
} = {}) {
  function applyStatus(status = {}) {
    const element = getElement();
    if (!element) return;
    const visible = status.update_available === true;
    element.hidden = !visible;
    element.classList.toggle('hidden', !visible);
  }

  async function loadStatus() {
    if (!serverUpdatesApi) return;
    try {
      applyStatus(await serverUpdatesApi.status());
    } catch (error) {
      console.warn('Server update status unavailable', error);
    }
  }

  return { applyStatus, loadStatus };
}

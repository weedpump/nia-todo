import { invoke } from './vendor/tauri-api/core.js';
    const input = document.getElementById('server-url');
    const errorEl = document.getElementById('error');

    function normalizeUrl(value) {
      const raw = value.trim().replace(/\/+$/, '');
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Bitte eine http(s)-URL eingeben.');
      return url.origin + url.pathname.replace(/\/+$/, '');
    }

    function nativeLaunchUrl(serverUrl) {
      const url = new URL(serverUrl);
      url.searchParams.set('nativeApp', 'tauri');
      return url.toString();
    }

    async function boot() {
      if (!invoke) {
        errorEl.textContent = 'Tauri API nicht verfügbar.';
        return;
      }
      const settings = await invoke('desktop_get_settings');
      if (settings?.serverUrl) {
        location.replace(nativeLaunchUrl(settings.serverUrl));
      }
    }

    document.getElementById('server-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      errorEl.textContent = '';
      try {
        const serverUrl = normalizeUrl(input.value);
        await invoke('desktop_set_server_url', { serverUrl });
        location.replace(nativeLaunchUrl(serverUrl));
      } catch (error) {
        errorEl.textContent = error?.message || String(error);
      }
    });

    boot().catch((error) => { errorEl.textContent = error?.message || String(error); });

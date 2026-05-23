function showBootError(error) {
  const subtitle = document.getElementById('boot-subtitle');
  const spinner = document.getElementById('boot-spinner');
  const retry = document.getElementById('boot-retry');
  if (subtitle) {
    subtitle.textContent = 'App konnte nicht geladen werden. Bitte neu laden.';
    subtitle.title = error?.message || String(error || 'Import failed');
  }
  if (spinner) spinner.style.display = 'none';
  if (retry) retry.style.display = '';
}

function showNativeServerSetup(config) {
  const overlay = document.getElementById('boot-overlay');
  if (!overlay) return;
  overlay.classList.add('native-server-setup');
  overlay.innerHTML = `
    <form class="boot-card native-server-card" id="native-server-form">
      <img src="/static/icons/icon-192.png" class="boot-logo" alt="nia-todo">
      <div class="boot-title">nia-todo verbinden</div>
      <div class="boot-subtitle">Server-URL eingeben, danach prüfe ich die Instanz.</div>
      <label class="native-server-label" for="native-server-url">Server</label>
      <input class="native-server-input" id="native-server-url" type="text" inputmode="url" autocomplete="url" required placeholder="todo.example.test">
      <button class="native-server-button" type="submit">Server prüfen & speichern</button>
      <div class="native-server-error" id="native-server-error"></div>
      <div class="native-server-hint">Die App-Oberfläche ist lokal gebündelt. Der Server liefert nur API, Sync und Login.</div>
    </form>
  `;
  const form = document.getElementById('native-server-form');
  const input = document.getElementById('native-server-url');
  const errorEl = document.getElementById('native-server-error');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    try {
      const serverUrl = config.normalizeServerUrl(input.value);
      const instance = await config.verifyInstance(serverUrl);
      if (instance?.app !== 'nia-todo') throw new Error('Das ist kein nia-todo Server.');
      await config.getTauriInvoke()('desktop_set_server_url', { serverUrl });
      location.reload();
    } catch (error) {
      errorEl.textContent = error?.message || String(error);
    }
  });
}

const startImport = () => {
  setTimeout(async () => {
    try {
      const config = await import('./core/config.js');
      const runtime = await config.initRuntimeConfig();
      window.NIA_TODO_RUNTIME = runtime;
      if (runtime?.capabilities?.native) document.documentElement.classList.add('native-app');
      if (runtime?.capabilities?.android) document.documentElement.classList.add('native-android');
      if (config.isNativeRuntime() && config.getTauriInvoke() && !runtime.apiBaseUrl) {
        showNativeServerSetup(config);
        return;
      }
      const module = await import('./app.js');
      module.startAppModule?.();
    } catch (err) {
      console.error('App import failed:', err);
      showBootError(err);
    }
  }, 0);
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startImport, { once: true });
} else {
  startImport();
}

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

const startImport = () => {
  setTimeout(() => {
    import('./app.js').then((module) => {
      module.startAppModule?.();
    }).catch((err) => {
      console.error('App import failed:', err);
      showBootError(err);
    });
  }, 0);
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startImport, { once: true });
} else {
  startImport();
}

const startImport = () => {
  setTimeout(() => {
    import('./app.js').then((module) => {
      module.startAppModule?.();
    }).catch((err) => {
      console.error('App import failed:', err);
    });
  }, 0);
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startImport, { once: true });
} else {
  startImport();
}

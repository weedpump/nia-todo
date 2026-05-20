console.log('[boot] main.js start', Math.round(performance.now() - (window.__niaBootT0 || 0)) + 'ms');

const startImport = () => {
  console.log('[boot] scheduling app.js import', Math.round(performance.now() - (window.__niaBootT0 || 0)) + 'ms');
  setTimeout(() => {
    console.log('[boot] app.js import start', Math.round(performance.now() - (window.__niaBootT0 || 0)) + 'ms');
    import('./app.js').then(() => {
      console.log('[boot] app.js import done', Math.round(performance.now() - (window.__niaBootT0 || 0)) + 'ms');
    }).catch((err) => {
      console.error('[boot] app.js import failed', err);
    });
  }, 0);
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startImport, { once: true });
} else {
  startImport();
}

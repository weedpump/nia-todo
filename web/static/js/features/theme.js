export function initTheme() {
  const stored = localStorage.getItem('theme');
  applyTheme(stored && stored !== 'system' ? stored : 'system');
}

export function setTheme(mode) {
  if (mode === 'system') {
    localStorage.removeItem('theme');
    applyTheme('system');
  } else {
    localStorage.setItem('theme', mode);
    applyTheme(mode);
  }
}

export function applyTheme(mode) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = mode === 'dark' || (mode === 'system' && prefersDark);

  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', isDark ? '#0f172a' : '#f8fafc');

  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === mode);
  });

  const toggleBtn = document.getElementById('theme-toggle-btn');
  if (toggleBtn) {
    const icons = { light: '☀️', dark: '🌙', system: '💻' };
    const titles = { light: 'Hell', dark: 'Dunkel', system: 'System' };
    toggleBtn.textContent = icons[mode] || icons.system;
    toggleBtn.title = `Theme: ${titles[mode] || titles.system} (klicken zum Wechseln)`;
  }
}

export function cycleTheme() {
  const cycle = ['light', 'dark', 'system'];
  const current = localStorage.getItem('theme') || 'system';
  const idx = cycle.indexOf(current);
  setTheme(cycle[(idx + 1) % cycle.length]);
}

export function bindSystemThemeListener() {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const stored = localStorage.getItem('theme');
    if (!stored || stored === 'system') applyTheme('system');
  });
}

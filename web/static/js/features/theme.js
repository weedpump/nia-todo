import { iconSvg } from '../icons/lucide-icons.js';

const ACCENT_STORAGE_KEY = 'nia-accent-preset';

export const ACCENT_PRESETS = [
  {
    id: 'standard',
    label: 'Standard',
    dark: { accent: '#6366f1', hover: '#818cf8', rgb: '99, 102, 241', hoverRgb: '129, 140, 248' },
    light: { accent: '#4f46e5', hover: '#4338ca', rgb: '79, 70, 229', hoverRgb: '67, 56, 202' },
  },
  {
    id: 'ocean',
    label: 'Ocean',
    dark: { accent: '#0ea5e9', hover: '#38bdf8', rgb: '14, 165, 233', hoverRgb: '56, 189, 248' },
    light: { accent: '#0284c7', hover: '#0369a1', rgb: '2, 132, 199', hoverRgb: '3, 105, 161' },
  },
  {
    id: 'emerald',
    label: 'Emerald',
    dark: { accent: '#10b981', hover: '#34d399', rgb: '16, 185, 129', hoverRgb: '52, 211, 153' },
    light: { accent: '#059669', hover: '#047857', rgb: '5, 150, 105', hoverRgb: '4, 120, 87' },
  },
  {
    id: 'amber',
    label: 'Amber',
    dark: { accent: '#f59e0b', hover: '#fbbf24', rgb: '245, 158, 11', hoverRgb: '251, 191, 36' },
    light: { accent: '#d97706', hover: '#b45309', rgb: '217, 119, 6', hoverRgb: '180, 83, 9' },
  },
  {
    id: 'rose',
    label: 'Rose',
    dark: { accent: '#f43f5e', hover: '#fb7185', rgb: '244, 63, 94', hoverRgb: '251, 113, 133' },
    light: { accent: '#e11d48', hover: '#be123c', rgb: '225, 29, 72', hoverRgb: '190, 18, 60' },
  },
  {
    id: 'violet',
    label: 'Violet',
    dark: { accent: '#8b5cf6', hover: '#a78bfa', rgb: '139, 92, 246', hoverRgb: '167, 139, 250' },
    light: { accent: '#7c3aed', hover: '#6d28d9', rgb: '124, 58, 237', hoverRgb: '109, 40, 217' },
  },
  {
    id: 'teal',
    label: 'Teal',
    dark: { accent: '#14b8a6', hover: '#2dd4bf', rgb: '20, 184, 166', hoverRgb: '45, 212, 191' },
    light: { accent: '#0d9488', hover: '#0f766e', rgb: '13, 148, 136', hoverRgb: '15, 118, 110' },
  },
];

function findAccentPreset(id) {
  return ACCENT_PRESETS.find(preset => preset.id === id) || ACCENT_PRESETS[0];
}

export function getAccentPreset() {
  return findAccentPreset(localStorage.getItem(ACCENT_STORAGE_KEY) || 'standard');
}

function applyAccentPreset(resolvedTheme) {
  const preset = getAccentPreset();
  const palette = preset[resolvedTheme] || preset.dark;
  const root = document.documentElement;
  root.dataset.accent = preset.id;
  root.style.setProperty('--accent', palette.accent);
  root.style.setProperty('--accent-hover', palette.hover);
  root.style.setProperty('--accent-rgb', palette.rgb);
  root.style.setProperty('--accent-hover-rgb', palette.hoverRgb);

  document.querySelectorAll('.accent-preset-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.accent === preset.id);
  });
}

export function setAccentPreset(id) {
  const preset = findAccentPreset(id);
  if (preset.id === 'standard') {
    localStorage.removeItem(ACCENT_STORAGE_KEY);
  } else {
    localStorage.setItem(ACCENT_STORAGE_KEY, preset.id);
  }
  const resolvedTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  applyAccentPreset(resolvedTheme);
  const accentOptionsEl = document.getElementById('settings-accent-options');
  if (accentOptionsEl) accentOptionsEl.innerHTML = renderAccentPresetOptions();
}

export function renderAccentPresetOptions() {
  const current = getAccentPreset().id;
  return ACCENT_PRESETS.map(preset => {
    const darkAccent = preset.dark.accent;
    const lightAccent = preset.light.accent;
    const active = preset.id === current ? ' active' : '';
    const check = preset.id === current ? `<span class="accent-preset-check">${iconSvg('check')}</span>` : '';
    return `<button type="button" class="accent-preset-option${active}" data-accent="${preset.id}" onclick="setAccentPreset('${preset.id}')" title="Designfarbe: ${preset.label}">
      <span class="accent-preset-swatch" style="--accent-swatch-dark:${darkAccent}; --accent-swatch-light:${lightAccent};"></span>
      <span class="accent-preset-name">${preset.label}</span>
      ${check}
    </button>`;
  }).join('');
}

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
  const resolvedTheme = isDark ? 'dark' : 'light';

  document.documentElement.setAttribute('data-theme', resolvedTheme);
  applyAccentPreset(resolvedTheme);

  window.NiaAndroidNative?.setTheme?.(resolvedTheme);
  window.NiaAndroidSystemBars?.setTheme?.(resolvedTheme);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', isDark ? '#0f172a' : '#f8fafc');

  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === mode);
  });

  const toggleBtn = document.getElementById('theme-toggle-btn');
  if (toggleBtn) {
    const icons = { light: iconSvg('sun'), dark: iconSvg('moon'), system: iconSvg('monitor') };
    const titles = { light: 'Hell', dark: 'Dunkel', system: 'System' };
    const iconEl = toggleBtn.querySelector('.menu-item-icon');
    const labelEl = toggleBtn.querySelector('.menu-item-label');
    if (iconEl && labelEl) {
      iconEl.innerHTML = icons[mode] || icons.system;
      labelEl.textContent = `Theme: ${titles[mode] || titles.system}`;
    } else {
      toggleBtn.textContent = icons[mode] || icons.system;
    }
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

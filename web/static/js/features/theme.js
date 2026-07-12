import { t } from '../i18n/index.js';
import { hydrateIcons, iconSvg } from '../icons/lucide-icons.js';
import { createNativeBridge } from './native-bridge.js';

const ACCENT_STORAGE_KEY = 'nia-accent-preset';
const ACCENT_INTENSITY_STORAGE_KEY = 'nia-accent-intensity';
const nativeBridge = createNativeBridge();

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
    id: 'magenta',
    label: 'Magenta',
    dark: { accent: '#d946ef', hover: '#f0abfc', rgb: '217, 70, 239', hoverRgb: '240, 171, 252' },
    light: { accent: '#c026d3', hover: '#a21caf', rgb: '192, 38, 211', hoverRgb: '162, 28, 175' },
  },
  {
    id: 'teal',
    label: 'Teal',
    dark: { accent: '#14b8a6', hover: '#2dd4bf', rgb: '20, 184, 166', hoverRgb: '45, 212, 191' },
    light: { accent: '#0d9488', hover: '#0f766e', rgb: '13, 148, 136', hoverRgb: '15, 118, 110' },
  },
];

const CHEVRON_DOWN = '<svg class="menu-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

function findAccentPreset(id) {
  return ACCENT_PRESETS.find(preset => preset.id === id) || ACCENT_PRESETS[0];
}

export function getAccentPreset() {
  return findAccentPreset(localStorage.getItem(ACCENT_STORAGE_KEY) || 'standard');
}

function clampAccentIntensity(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

export function getAccentIntensity() {
  return clampAccentIntensity(localStorage.getItem(ACCENT_INTENSITY_STORAGE_KEY) ?? 100);
}

function accentSwatchStyle(preset) {
  return `--accent-swatch-dark:${preset.dark.accent}; --accent-swatch-light:${preset.light.accent};`;
}

function renderAccentSwatch(preset) {
  return `<span class="accent-preset-swatch" style="${accentSwatchStyle(preset)}"></span>`;
}

let accentIntensityBound = false;

function bindAccentIntensitySlider() {
  if (accentIntensityBound) return;
  const slider = document.getElementById('accent-intensity-slider');
  if (!slider) return;
  accentIntensityBound = true;
  slider.addEventListener('input', () => setAccentIntensity(slider.value));
  slider.addEventListener('change', () => setAccentIntensity(slider.value));
}

function updateAccentMenuUi() {
  const preset = getAccentPreset();
  const intensity = getAccentIntensity();
  const current = document.getElementById('accent-preset-current');
  if (current) current.innerHTML = renderAccentSwatch(preset);

  const slider = document.getElementById('accent-intensity-slider');
  if (slider) {
    slider.value = String(intensity);
    bindAccentIntensitySlider();
  }

  const value = document.getElementById('accent-intensity-value');
  if (value) value.textContent = `${intensity}%`;

  document.querySelectorAll('.accent-preset-option').forEach(btn => {
    const isActive = btn.dataset.accent === preset.id;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function applyAccentPreset(resolvedTheme) {
  const preset = getAccentPreset();
  const intensity = getAccentIntensity();
  const palette = preset[resolvedTheme] || preset.dark;
  const strength = `${intensity}%`;
  const root = document.documentElement;
  root.dataset.accent = preset.id;
  root.dataset.accentIntensity = String(intensity);
  root.style.setProperty('--accent-intensity', String(intensity / 100));
  root.style.setProperty('--accent-strength', strength);
  if (intensity >= 100) {
    root.style.setProperty('--accent', palette.accent);
    root.style.setProperty('--accent-hover', palette.hover);
  } else {
    root.style.setProperty('--accent', `color-mix(in srgb, ${palette.accent} ${strength}, var(--text-secondary))`);
    root.style.setProperty('--accent-hover', `color-mix(in srgb, ${palette.hover} ${strength}, var(--text-primary))`);
  }
  root.style.setProperty('--accent-rgb', palette.rgb);
  root.style.setProperty('--accent-hover-rgb', palette.hoverRgb);
  updateAccentMenuUi();
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
}

export function setAccentIntensity(value) {
  const intensity = clampAccentIntensity(value);
  if (intensity === 100) {
    localStorage.removeItem(ACCENT_INTENSITY_STORAGE_KEY);
  } else {
    localStorage.setItem(ACCENT_INTENSITY_STORAGE_KEY, String(intensity));
  }
  const resolvedTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  applyAccentPreset(resolvedTheme);
}

export function toggleAccentPresetMenu(event) {
  event?.stopPropagation?.();
  const row = document.getElementById('accent-preset-row');
  const panel = document.getElementById('accent-preset-panel');
  if (!row || !panel) return;
  const nextOpen = !panel.classList.contains('active');
  panel.classList.toggle('active', nextOpen);
  row.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
}

export function renderAccentPresetOptions() {
  const current = getAccentPreset().id;
  return ACCENT_PRESETS.map(preset => {
    const active = preset.id === current ? ' active' : '';
    const pressed = preset.id === current ? 'true' : 'false';
    return `<button type="button" class="accent-preset-option${active}" data-accent="${preset.id}" aria-pressed="${pressed}" title="${preset.label}">
      ${renderAccentSwatch(preset)}
    </button>`;
  }).join('');
}

export function renderAccentPresetMenu() {
  const preset = getAccentPreset();
  const intensity = getAccentIntensity();
  const panel = document.getElementById('accent-preset-panel');
  const current = document.getElementById('accent-preset-current');
  if (panel) panel.innerHTML = `${renderAccentPresetOptions()}
    <label class="accent-intensity-control" title="${t('theme.accentIntensity')}">
      <span class="accent-intensity-label">${t('theme.intensity')}</span>
      <input id="accent-intensity-slider" class="accent-intensity-slider" type="range" min="0" max="100" step="5" value="${intensity}">
      <span class="accent-intensity-value" id="accent-intensity-value">${intensity}%</span>
    </label>`;
  if (current) current.innerHTML = renderAccentSwatch(preset);
  accentIntensityBound = false;
  bindAccentIntensitySlider();
  const chevron = document.querySelector('#accent-preset-row .accent-preset-chevron');
  if (chevron) chevron.innerHTML = CHEVRON_DOWN;
}

export function initTheme() {
  const stored = localStorage.getItem('theme');
  applyTheme(stored && stored !== 'system' ? stored : 'system');
  renderAccentPresetMenu();
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

  nativeBridge.setSystemBarsTheme(resolvedTheme);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', isDark ? '#0f172a' : '#f8fafc');

  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === mode);
  });

  document.querySelectorAll('[data-theme-cycle]').forEach(btn => {
    const icons = { light: 'sun', dark: 'moon', system: 'monitor' };
    const titles = { light: t('common.theme.light'), dark: t('common.theme.dark'), system: t('common.theme.system') };
    const iconEl = btn.querySelector('[data-theme-cycle-icon]');
    btn.dataset.themeMode = mode;
    if (iconEl) {
      iconEl.dataset.icon = icons[mode] || icons.system;
      hydrateIcons(btn);
    }
    btn.title = t('menu.themeTitle', { theme: titles[mode] || titles.system });
    btn.setAttribute('aria-label', btn.title);
  });

  const toggleBtn = document.getElementById('theme-toggle-btn');
  if (toggleBtn) {
    const icons = { light: iconSvg('sun'), dark: iconSvg('moon'), system: iconSvg('monitor') };
    const titles = { light: t('common.theme.light'), dark: t('common.theme.dark'), system: t('common.theme.system') };
    const iconEl = toggleBtn.querySelector('.menu-item-icon');
    const labelEl = toggleBtn.querySelector('.menu-item-label');
    if (iconEl && labelEl) {
      iconEl.innerHTML = icons[mode] || icons.system;
      labelEl.textContent = t('menu.theme', { theme: titles[mode] || titles.system });
    } else {
      toggleBtn.textContent = icons[mode] || icons.system;
    }
    toggleBtn.title = t('menu.themeTitle', { theme: titles[mode] || titles.system });
  }
}

export function cycleTheme() {
  const cycle = ['light', 'dark', 'system'];
  const current = localStorage.getItem('theme') || 'system';
  const idx = cycle.indexOf(current);
  setTheme(cycle[(idx + 1) % cycle.length]);
}

let themeOptionButtonsBound = false;
export function bindThemeOptionButtons() {
  if (themeOptionButtonsBound) return;
  themeOptionButtonsBound = true;
  document.addEventListener('click', (event) => {
    const cycleButton = event.target?.closest?.('[data-theme-cycle]');
    if (!cycleButton) return;
    event.preventDefault();
    cycleTheme();
  });
  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.('.theme-option[data-theme]');
    if (!button) return;
    event.preventDefault();
    setTheme(button.dataset.theme);
  });
  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.('.accent-preset-option[data-accent]');
    if (!button) return;
    event.preventDefault();
    setAccentPreset(button.dataset.accent);
  });
}

let systemThemeListenerBound = false;
export function bindSystemThemeListener() {
  if (systemThemeListenerBound) return;
  systemThemeListenerBound = true;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const stored = localStorage.getItem('theme');
    if (!stored || stored === 'system') applyTheme('system');
  });
}

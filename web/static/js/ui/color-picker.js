import { t } from '../i18n/index.js';

const DEFAULT_COLORS = [
  '#6366f1', '#0ea5e9', '#10b981', '#f59e0b',
  '#f43f5e', '#d946ef', '#14b8a6', '#64748b',
  '#ef4444', '#22c55e', '#8b5cf6', '#06b6d4',
];

function normalizeColor(value, fallback = '#6366f1') {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : fallback;
}

function labelForColor(color) {
  return normalizeColor(color).toUpperCase();
}

export function renderColorPicker({ container, input, selected, colors = DEFAULT_COLORS, onChange } = {}) {
  if (!container || !input) return;
  const current = normalizeColor(selected || input.value);
  input.value = current;
  input.classList.add('color-picker-native');

  const normalizedColors = Array.from(new Set(colors.map((color) => normalizeColor(color))));
  const selectedInPalette = normalizedColors.includes(current);

  container.innerHTML = `
    <button type="button" class="ui-field color-picker-current" aria-expanded="false">
      <span class="color-picker-swatch" style="background:${current}" aria-hidden="true"></span>
      <span class="color-picker-current-text">
        <span class="color-picker-current-label">${t('colorPicker.selected')}</span>
        <span class="color-picker-current-name">${labelForColor(current)}</span>
      </span>
      <svg class="color-picker-current-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="ui-dropdown-panel color-picker-panel" hidden>
      <div class="color-picker-grid">
        ${normalizedColors.map((color) => `
          <button type="button" class="btn btn-secondary btn-icon color-picker-option ${current === color ? 'is-selected' : ''}" data-color="${color}" aria-selected="${current === color ? 'true' : 'false'}" title="${labelForColor(color)}">
            <span class="color-picker-swatch" style="background:${color}" aria-hidden="true"></span>
          </button>
        `).join('')}
        <button type="button" class="btn btn-secondary color-picker-custom ${selectedInPalette ? '' : 'is-selected'}" aria-selected="${selectedInPalette ? 'false' : 'true'}">
          <span class="color-picker-swatch" style="background:${current}" aria-hidden="true"></span>
          <span>${t('colorPicker.custom')}</span>
        </button>
      </div>
    </div>
  `;

  const currentButton = container.querySelector('.color-picker-current');
  const panel = container.querySelector('.color-picker-panel');
  if (currentButton) currentButton.disabled = input.disabled;
  const swatch = container.querySelector('.color-picker-current .color-picker-swatch');
  const name = container.querySelector('.color-picker-current-name');
  const customButton = container.querySelector('.color-picker-custom');

  function setExpanded(expanded) {
    panel.hidden = !expanded;
    currentButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function update(value, emit = true) {
    const color = normalizeColor(value, current);
    input.value = color;
    if (swatch) swatch.style.background = color;
    if (name) name.textContent = labelForColor(color);
    container.querySelectorAll('.color-picker-option').forEach((button) => {
      const selectedColor = button.dataset.color === color;
      button.classList.toggle('is-selected', selectedColor);
      button.setAttribute('aria-selected', selectedColor ? 'true' : 'false');
    });
    const inPalette = normalizedColors.includes(color);
    customButton?.classList.toggle('is-selected', !inPalette);
    customButton?.setAttribute('aria-selected', inPalette ? 'false' : 'true');
    customButton?.querySelector('.color-picker-swatch')?.style.setProperty('background', color);
    if (emit && typeof onChange === 'function') onChange(color);
  }

  currentButton?.addEventListener('click', () => {
    if (input.disabled) return;
    const expanded = currentButton.getAttribute('aria-expanded') === 'true';
    setExpanded(!expanded);
  });

  container.querySelectorAll('.color-picker-option').forEach((button) => {
    button.addEventListener('click', () => {
      if (input.disabled) return;
      update(button.dataset.color || current);
      setExpanded(false);
    });
  });

  customButton?.addEventListener('click', () => {
    if (input.disabled) return;
    input.click();
  });

  input.oninput = () => update(input.value, true);
}

import { renderIconPicker, safeColor } from '../icons/lucide-icons.js';
import { renderColorPicker } from '../ui/color-picker.js';
import { escapeHtmlAttr } from '../core/utils.js';
import { t } from '../i18n/index.js';

export function renderEntityAppearanceFields({ prefix } = {}) {
  if (!prefix) throw new TypeError('prefix is required');
  return `<section class="ui-section-card ui-detail-section ui-section-divider ui-detail-title-section entity-title-section">
    <div class="form-group ui-detail-title-group">
      <label for="${prefix}-name" data-i18n-key="common.name">${escapeHtmlAttr(t('common.name'))}</label>
      <input class="ui-field ui-detail-title-field" type="text" id="${prefix}-name" maxlength="200" required autocomplete="off" placeholder="${escapeHtmlAttr(t('entity.namePlaceholder'))}" data-i18n-placeholder-key="entity.namePlaceholder">
    </div>
  </section>
  <section class="ui-section-card ui-detail-section ui-section-divider entity-appearance-section">
    <div class="ui-section-heading ui-detail-section-heading">
      <div class="ui-section-icon ui-detail-section-icon" data-icon="palette"></div>
      <div>
        <h4 data-i18n-key="entity.appearance.title">${escapeHtmlAttr(t('entity.appearance.title'))}</h4>
        <p data-i18n-key="entity.appearance.hint">${escapeHtmlAttr(t('entity.appearance.hint'))}</p>
      </div>
    </div>
    <div class="ui-field-grid two-columns entity-appearance-grid">
      <div class="form-group">
        <label for="${prefix}-color" data-i18n-key="common.color">${escapeHtmlAttr(t('common.color'))}</label>
        <input type="color" id="${prefix}-color" value="#6366f1">
        <div id="${prefix}-color-picker" class="color-picker" aria-label="${escapeHtmlAttr(t('entity.chooseColor'))}" data-i18n-aria-label-key="entity.chooseColor"></div>
      </div>
      <div class="form-group">
        <label for="${prefix}-icon" data-i18n-key="common.icon">${escapeHtmlAttr(t('common.icon'))}</label>
        <input type="hidden" id="${prefix}-icon">
        <div id="${prefix}-icon-picker" class="icon-picker" aria-label="${escapeHtmlAttr(t('entity.chooseIcon'))}" data-i18n-aria-label-key="entity.chooseIcon"></div>
      </div>
    </div>
  </section>`;
}

export function createEntityAppearanceController({
  prefix,
  document: doc = globalThis.document,
  defaultColor = '#6366f1',
  defaultIcon = '',
  onChange = () => {},
} = {}) {
  if (!prefix) throw new TypeError('prefix is required');

  function elements() {
    return {
      name: doc?.getElementById?.(`${prefix}-name`) || null,
      color: doc?.getElementById?.(`${prefix}-color`) || null,
      icon: doc?.getElementById?.(`${prefix}-icon`) || null,
      colorPicker: doc?.getElementById?.(`${prefix}-color-picker`) || null,
      iconPicker: doc?.getElementById?.(`${prefix}-icon-picker`) || null,
    };
  }

  function emitChange() {
    onChange(readState());
  }

  function renderPickers() {
    const { color, icon, colorPicker, iconPicker } = elements();
    if (!color || !icon) return;
    renderIconPicker({
      container: iconPicker,
      input: icon,
      selected: icon.value || '',
      color: color.value || defaultColor,
      onChange: emitChange,
    });
    renderColorPicker({
      container: colorPicker,
      input: color,
      selected: color.value || defaultColor,
      onChange: selectedColor => {
        renderIconPicker({
          container: iconPicker,
          input: icon,
          selected: icon.value || '',
          color: selectedColor,
          onChange: emitChange,
        });
        emitChange();
      },
    });
  }

  function setEditable(editable) {
    const { name, color, icon, colorPicker, iconPicker } = elements();
    for (const input of [name, color, icon]) {
      if (!input) continue;
      input.disabled = !editable;
      input.setAttribute('aria-readonly', editable ? 'false' : 'true');
    }
    for (const picker of [colorPicker, iconPicker]) {
      if (!picker) continue;
      picker.style.pointerEvents = editable ? '' : 'none';
      picker.style.opacity = editable ? '' : '0.6';
      picker.setAttribute('aria-disabled', editable ? 'false' : 'true');
    }
    renderPickers();
  }

  function setValues({ name = '', color = defaultColor, icon = defaultIcon } = {}, { editable = true } = {}) {
    const fields = elements();
    if (fields.name) fields.name.value = String(name ?? '');
    if (fields.color) fields.color.value = safeColor(color, defaultColor);
    if (fields.icon) fields.icon.value = String(icon ?? '');
    setEditable(editable);
  }

  function readState() {
    const { name, color, icon } = elements();
    return {
      name: String(name?.value || '').trim(),
      color: safeColor(color?.value || defaultColor, defaultColor),
      icon: String(icon?.value || '') || null,
    };
  }

  return {
    elements,
    readState,
    renderPickers,
    setEditable,
    setValues,
    focusName() {
      elements().name?.focus?.();
    },
  };
}

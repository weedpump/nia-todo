import { escapeHtml, escapeHtmlAttr } from '../core/utils.js';
import { niaIconSvg } from '../icons/nia-product-icons.js';
import { t } from '../i18n/index.js';

export function createEmptyModule(definition) {
  let mountedSlots = null;

  function render() {
    if (!mountedSlots) return;
    const label = t(definition.labelKey);
    mountedSlots.sidebar.innerHTML = `
      <nav class="nav-section module-placeholder-sidebar" aria-label="${escapeHtmlAttr(label)}">
        <div class="nav-title">${escapeHtml(label)}</div>
      </nav>
    `;
    mountedSlots.main.innerHTML = `
      <div class="module-page module-empty-page">
        <div class="module-empty-icon" aria-hidden="true">${niaIconSvg(definition.icon)}</div>
        <p class="module-page-eyebrow">Nia</p>
        <h1>${escapeHtml(label)}</h1>
        <p>${escapeHtml(t('module.placeholder.body'))}</p>
      </div>
    `;
  }

  return Object.freeze({
    searchEnabled: false,
    searchPlaceholderKey: 'module.placeholder.search',
    ...definition,
    mount({ slots }) {
      mountedSlots = slots;
      render();
    },
    render,
  });
}

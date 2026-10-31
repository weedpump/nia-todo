function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeHtmlAttr(value) {
  return escapeHtml(value)
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderTopbarToggle({
  id,
  icon = null,
  iconMarkup = '',
  label = '',
  labelKey = '',
  title = '',
} = {}) {
  const renderedIcon = iconMarkup || (icon ? `<span data-icon="${escapeHtmlAttr(icon)}"></span>` : '');
  const i18nAttribute = labelKey ? ` data-i18n-key="${escapeHtmlAttr(labelKey)}"` : '';
  return `
    <button type="button" class="ui-topbar-toggle" id="${escapeHtmlAttr(id || '')}" aria-pressed="false" aria-label="${escapeHtmlAttr(title)}" title="${escapeHtmlAttr(title)}">
      ${renderedIcon}
      <span data-topbar-toggle-label${i18nAttribute}>${escapeHtml(label)}</span>
    </button>
  `;
}

export function updateTopbarToggle(button, { pressed = false, label = '', title = '' } = {}) {
  if (!button) return false;
  const active = pressed === true;
  button.classList.toggle('active', active);
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
  button.setAttribute('aria-label', title);
  button.title = title;
  const labelElement = button.querySelector('[data-topbar-toggle-label]');
  if (labelElement) labelElement.textContent = label;
  return true;
}

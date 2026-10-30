import { escapeHtmlAttr } from '../core/utils.js';

const DATA_ATTRIBUTE_PATTERN = /^data-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function renderModulePrimaryAction({
  actionAttribute,
  action,
  ariaLabel,
  ariaLabelKey,
  title,
  titleKey,
}) {
  if (!DATA_ATTRIBUTE_PATTERN.test(String(actionAttribute ?? ''))) {
    throw new TypeError('Module primary action requires a data attribute');
  }

  return `
    <button class="ui-module-primary-action" type="button" ${actionAttribute}="${escapeHtmlAttr(action)}" aria-label="${escapeHtmlAttr(ariaLabel)}" data-i18n-aria-label-key="${escapeHtmlAttr(ariaLabelKey)}" title="${escapeHtmlAttr(title)}" data-i18n-title-key="${escapeHtmlAttr(titleKey)}">
      <span aria-hidden="true">+</span>
    </button>
  `;
}

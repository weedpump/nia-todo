import { escapeHtmlAttr } from '../core/utils.js';
import { t } from '../i18n/index.js';

function keyedText(tag, { id = '', key = '', text = '' } = {}) {
  const content = key ? t(key) : text;
  return `<${tag}${id ? ` id="${escapeHtmlAttr(id)}"` : ''}${key ? ` data-i18n-key="${escapeHtmlAttr(key)}"` : ''}>${escapeHtmlAttr(content)}</${tag}>`;
}

export function renderEntityDetailHeader({
  headerClassNames = [],
  iconClassNames = [],
  icon,
  title = {},
  subtitle = {},
  actionsClassNames = [],
  actionsId = '',
  actionsHtml = '',
} = {}) {
  return `<div class="${['entity-modal-header', ...headerClassNames, 'ui-detail-modal-header', 'ui-detail-entity-header'].filter(Boolean).join(' ')}">
    <div class="${['entity-modal-title-icon', ...iconClassNames, 'ui-detail-title-icon'].filter(Boolean).join(' ')}" data-icon="${escapeHtmlAttr(icon)}"></div>
    <div class="ui-detail-header-copy">
      ${keyedText('h3', title)}
      ${keyedText('p', subtitle)}
    </div>
    <div class="${[...actionsClassNames, 'ui-detail-header-actions'].filter(Boolean).join(' ')}"${actionsId ? ` id="${escapeHtmlAttr(actionsId)}"` : ''}>${actionsHtml}</div>
  </div>`;
}

import { escapeHtmlAttr } from '../core/utils.js';

function classNames(value) {
  return (Array.isArray(value) ? value : [value]).filter(Boolean).join(' ');
}

function attributes(values = {}) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([name, value]) => {
      if (!/^[a-zA-Z][a-zA-Z0-9:_-]*$/.test(name)) throw new TypeError('Invalid modal attribute name');
      return value === true ? ` ${name}` : ` ${name}="${escapeHtmlAttr(value)}"`;
    }).join('');
}

/**
 * Shared window structure. Modules provide trusted rendered content and their
 * existing attributes; class options replace the complete default class list.
 * The footer slot includes its own markup, so no extra wrapper is introduced.
 */
export function renderDetailModalFrame({
  id,
  rootClasses = ['modal', 'ui-detail-modal', 'ui-detail-view'],
  contentClasses = ['modal-content', 'entity-modal-content', 'ui-detail-modal-content'],
  headerHtml = '',
  bodyHtml = '',
  footerHtml = '',
  overlayId = '',
  overlayAttributes,
  rootAttributes = {},
  contentAttributes = {},
  bodyClasses = ['modal-body', 'entity-modal-body', 'ui-detail-modal-body'],
  bodyId = '',
} = {}) {
  if (!id) throw new TypeError('A modal id is required');
  return `<div${attributes({ class: classNames(rootClasses), id, ...rootAttributes })}>
    <div${attributes({ class: 'modal-overlay', ...(overlayId ? { id: overlayId } : {}), ...(overlayAttributes ?? { 'data-close-modal': id }) })}></div>
    <div${attributes({ class: classNames(contentClasses), ...contentAttributes })}>
      ${headerHtml}
      <div${attributes({ class: classNames(bodyClasses), ...(bodyId ? { id: bodyId } : {}) })}>${bodyHtml}</div>
      ${footerHtml}
    </div>
  </div>`;
}

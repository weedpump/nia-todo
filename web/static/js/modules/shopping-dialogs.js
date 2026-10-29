import { escapeHtmlAttr } from '../core/utils.js';
import { t } from '../i18n/index.js';
import { renderEntityAppearanceFields } from '../features/entity-appearance.js';
import { renderEntityDetailHeader } from '../features/entity-detail-header.js';

export const SHOPPING_DIALOGS_HTML = `
  <div class="modal ui-detail-modal ui-detail-view" id="shopping-list-modal" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="shopping-list-modal-title">
    <div class="modal-overlay" data-close-modal="shopping-list-modal"></div>
    <div class="modal-content entity-modal-content ui-detail-modal-content">
      ${renderEntityDetailHeader({
        icon: 'shopping-cart',
        title: {
          id: 'shopping-list-modal-title',
          key: 'shopping.list.modal.createTitle',
        },
        subtitle: {
          key: 'shopping.list.modal.subtitle',
        },
        actionsHtml: `
          <button type="submit" form="shopping-list-form" class="btn btn-primary" id="shopping-list-save-btn" data-i18n-key="common.save">${escapeHtmlAttr(t('common.save'))}</button>
          <button type="button" class="modal-close-x" data-close-modal="shopping-list-modal" aria-label="${escapeHtmlAttr(t('common.close'))}" data-i18n-aria-label-key="common.close"><span data-icon="x"></span></button>
        `,
      })}
      <div class="modal-body entity-modal-body ui-detail-modal-body">
        <form id="shopping-list-form" class="entity-modal-form ui-detail-shell">
          <input type="hidden" id="shopping-list-id">
          ${renderEntityAppearanceFields({ prefix: 'shopping-list' })}
          <div class="settings-field-error" id="shopping-list-error" role="alert"></div>
        </form>
      </div>
    </div>
  </div>
`;

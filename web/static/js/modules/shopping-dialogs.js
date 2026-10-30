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
          <details class="ui-detail-header-menu-toggle" id="shopping-list-detail-header-menu" hidden>
            <summary id="shopping-list-detail-header-menu-trigger" aria-label="${escapeHtmlAttr(t('common.more'))}" data-i18n-aria-label-key="common.more"><span data-icon="menu"></span></summary>
            <div class="ui-detail-header-menu ui-menu" role="menu">
              <button type="button" class="ui-menu-item danger" id="shopping-list-delete-btn" data-shopping-list-action="delete-from-modal" role="menuitem"><span data-icon="trash-2"></span> <span data-i18n-key="shopping.list.delete.confirm">${escapeHtmlAttr(t('shopping.list.delete.confirm'))}</span></button>
            </div>
          </details>
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

  <div class="modal ui-detail-modal ui-detail-view" id="shopping-item-modal" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="shopping-item-modal-title">
    <div class="modal-overlay" data-close-modal="shopping-item-modal"></div>
    <div class="modal-content entity-modal-content ui-detail-modal-content">
      ${renderEntityDetailHeader({
        icon: 'shopping-cart',
        title: {
          id: 'shopping-item-modal-title',
          key: 'shopping.item.modal.title',
        },
        subtitle: {
          key: 'shopping.item.modal.subtitle',
        },
        actionsHtml: `
          <button type="submit" form="shopping-item-form" class="btn btn-primary" id="shopping-item-save-btn" data-i18n-key="common.save">${escapeHtmlAttr(t('common.save'))}</button>
          <details class="ui-detail-header-menu-toggle" id="shopping-item-detail-menu-toggle" hidden>
            <summary aria-label="${escapeHtmlAttr(t('common.more'))}" data-i18n-aria-label-key="common.more"><span data-icon="menu"></span></summary>
            <div class="ui-detail-header-menu ui-menu" role="menu">
              <button type="button" class="ui-menu-item danger" data-shopping-item-editor-action="delete" role="menuitem"><span data-icon="trash-2"></span><span data-i18n-key="shopping.item.delete">${escapeHtmlAttr(t('shopping.item.delete'))}</span></button>
            </div>
          </details>
          <button type="button" class="modal-close-x" data-close-modal="shopping-item-modal" aria-label="${escapeHtmlAttr(t('common.close'))}" data-i18n-aria-label-key="common.close"><span data-icon="x"></span></button>
        `,
      })}
      <div class="modal-body entity-modal-body ui-detail-modal-body">
        <form id="shopping-item-form" class="entity-modal-form ui-detail-shell">
          <section class="ui-section-card ui-detail-section ui-section-divider ui-detail-title-section">
            <div class="form-group ui-detail-title-group">
              <label for="shopping-item-name" data-i18n-key="shopping.item.name">${escapeHtmlAttr(t('shopping.item.name'))}</label>
              <input class="ui-field ui-detail-title-field" type="text" id="shopping-item-name" required maxlength="500" autocomplete="off" data-i18n-placeholder-key="shopping.item.namePlaceholder" placeholder="${escapeHtmlAttr(t('shopping.item.namePlaceholder'))}">
            </div>
          </section>
          <section class="ui-section-card ui-detail-section ui-section-divider">
            <div class="ui-section-heading ui-detail-section-heading">
              <div class="ui-section-icon ui-detail-section-icon" data-icon="sliders-horizontal"></div>
              <div>
                <h4 data-i18n-key="shopping.item.details">${escapeHtmlAttr(t('shopping.item.details'))}</h4>
                <p data-i18n-key="shopping.item.detailsHint">${escapeHtmlAttr(t('shopping.item.detailsHint'))}</p>
              </div>
            </div>
            <div class="ui-field-grid two-columns shopping-item-create-grid">
              <div class="form-group">
                <label for="shopping-item-quantity" data-i18n-key="shopping.item.quantity">${escapeHtmlAttr(t('shopping.item.quantity'))}</label>
                <input class="ui-field" type="number" id="shopping-item-quantity" min="0" step="any" inputmode="decimal" data-i18n-placeholder-key="shopping.item.quantityPlaceholder" placeholder="${escapeHtmlAttr(t('shopping.item.quantityPlaceholder'))}">
              </div>
              <div class="form-group">
                <label for="shopping-item-unit" data-i18n-key="shopping.item.unit">${escapeHtmlAttr(t('shopping.item.unit'))}</label>
                <input class="ui-field" type="text" id="shopping-item-unit" maxlength="40" autocomplete="off" data-i18n-placeholder-key="shopping.item.unitPlaceholder" placeholder="${escapeHtmlAttr(t('shopping.item.unitPlaceholder'))}">
              </div>
              <div class="form-group">
                <label for="shopping-item-section" data-i18n-key="common.section">${escapeHtmlAttr(t('common.section'))}</label>
                <select class="ui-field" id="shopping-item-section" data-ui-select></select>
              </div>
              <div class="form-group shopping-item-store-group">
                <label for="shopping-item-store" data-i18n-key="shopping.item.store">${escapeHtmlAttr(t('shopping.item.store'))}</label>
                <select class="ui-field" id="shopping-item-store" data-ui-select></select>
                <div class="shopping-item-new-store" id="shopping-item-new-store" hidden>
                  <label for="shopping-item-new-store-name" data-i18n-key="shopping.store.name">${escapeHtmlAttr(t('shopping.store.name'))}</label>
                  <div class="shopping-item-new-store-row">
                    <input class="ui-field" type="text" id="shopping-item-new-store-name" maxlength="120" autocomplete="off" data-i18n-placeholder-key="shopping.store.namePlaceholder" placeholder="${escapeHtmlAttr(t('shopping.store.namePlaceholder'))}">
                    <button type="button" class="btn btn-primary" data-shopping-item-create-action="save-store" data-i18n-key="common.add">${escapeHtmlAttr(t('common.add'))}</button>
                    <button type="button" class="btn btn-secondary" data-shopping-item-create-action="cancel-store" data-i18n-key="common.cancel">${escapeHtmlAttr(t('common.cancel'))}</button>
                  </div>
                  <div class="settings-field-error" id="shopping-item-store-error" role="alert"></div>
                </div>
              </div>
            </div>
          </section>
          <div class="settings-field-error" id="shopping-item-error" role="alert"></div>
        </form>
      </div>
    </div>
  </div>
`;

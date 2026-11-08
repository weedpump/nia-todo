import { escapeHtmlAttr } from '../core/utils.js';
import { renderDetailModalFrame } from '../ui/detail-modal.js';
import { t } from '../i18n/index.js';
import { renderEntityEditorModal } from '../features/entity-editor-modal.js';
import { renderEntityDetailHeader } from '../features/entity-detail-header.js';
import { renderEntityDirectSharingSection } from '../features/entity-direct-sharing.js';
import { renderEntityOwnershipField } from '../features/entity-ownership-field.js';
import { renderShoppingStoreCreator } from '../features/shopping-store-creator.js';
import { renderMultiAddModeSwitch, renderMultiAddPanel } from '../features/multi-add.js';

export const SHOPPING_DIALOGS_HTML = `
  ${renderEntityEditorModal({
    prefix: 'shopping-list',
    icon: 'shopping-cart',
    createTitleKey: 'shopping.list.modal.createTitle',
    subtitleKey: 'shopping.list.modal.subtitle',
    deleteKey: 'shopping.list.delete.confirm',
    formContentHtml: `
          <section class="ui-section-card ui-detail-section ui-section-divider">
            ${renderEntityOwnershipField({ prefix: 'shopping-list', labelKey: 'entity.ownership.for' })}
          </section>
          <div class="settings-field-error" id="shopping-list-error" role="alert"></div>
    `,
    sharingHtml: renderEntityDirectSharingSection({ prefix: 'shopping-list', leaveKey: 'shopping.list.share.leave' }),
  })}

  ${renderDetailModalFrame({
    id: 'shopping-store-modal',
    rootAttributes: { role: 'dialog', 'aria-modal': 'true', 'aria-hidden': 'true', 'aria-labelledby': 'shopping-store-modal-title' },
    headerHtml: renderEntityDetailHeader({
        icon: 'store',
        title: {
          id: 'shopping-store-modal-title',
          key: 'shopping.store.modal.editTitle',
        },
        subtitle: {
          key: 'shopping.store.modal.subtitle',
        },
        actionsHtml: `
          <button type="submit" form="shopping-store-form" class="btn btn-primary" id="shopping-store-save-btn" data-i18n-key="common.save">${escapeHtmlAttr(t('common.save'))}</button>
          <details class="ui-detail-header-menu-toggle" id="shopping-store-detail-menu-toggle">
            <summary id="shopping-store-detail-menu-trigger" aria-label="${escapeHtmlAttr(t('common.more'))}" data-i18n-aria-label-key="common.more"><span data-icon="menu"></span></summary>
            <div class="ui-detail-header-menu ui-menu" role="menu">
              <button type="button" class="ui-menu-item danger" data-shopping-store-editor-action="delete" role="menuitem"><span data-icon="trash-2"></span><span data-i18n-key="shopping.store.delete">${escapeHtmlAttr(t('shopping.store.delete'))}</span></button>
            </div>
          </details>
          <button type="button" class="modal-close-x" data-close-modal="shopping-store-modal" aria-label="${escapeHtmlAttr(t('common.close'))}" data-i18n-aria-label-key="common.close"><span data-icon="x"></span></button>
        `,
      }),
    bodyHtml: `
        <form id="shopping-store-form" class="entity-modal-form ui-detail-shell">
          <input type="hidden" id="shopping-store-list-id">
          <input type="hidden" id="shopping-store-id">
          <section class="ui-section-card ui-detail-section ui-section-divider ui-detail-title-section">
            <div class="form-group ui-detail-title-group">
              <label for="shopping-store-name" data-i18n-key="shopping.store.name">${escapeHtmlAttr(t('shopping.store.name'))}</label>
              <input class="ui-field ui-detail-title-field" type="text" id="shopping-store-name" required maxlength="120" autocomplete="off" data-i18n-placeholder-key="shopping.store.namePlaceholder" placeholder="${escapeHtmlAttr(t('shopping.store.namePlaceholder'))}">
            </div>
          </section>
          <div class="settings-field-error" id="shopping-store-edit-error" role="alert"></div>
        </form>
    `,
  })}

  ${renderDetailModalFrame({
    id: 'shopping-item-modal',
    rootAttributes: { role: 'dialog', 'aria-modal': 'true', 'aria-hidden': 'true', 'aria-labelledby': 'shopping-item-modal-title' },
    headerHtml: renderEntityDetailHeader({
        icon: 'shopping-cart',
        title: {
          id: 'shopping-item-modal-title',
          key: 'shopping.item.modal.title',
        },
        subtitle: {
          id: 'shopping-item-modal-subtitle',
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
      }),
    bodyHtml: `
        <form id="shopping-item-form" class="entity-modal-form ui-detail-shell">
          ${renderMultiAddModeSwitch({ prefix: 'shopping-item', singleKey: 'shopping.multiAdd.modeSingle', multipleKey: 'shopping.multiAdd.modeMultiple' })}
          <section class="ui-section-card ui-detail-section ui-section-divider ui-detail-title-section ui-multi-add-single">
            <div class="form-group ui-detail-title-group">
              <label for="shopping-item-name" data-i18n-key="shopping.item.name">${escapeHtmlAttr(t('shopping.item.name'))}</label>
              <input class="ui-field ui-detail-title-field" type="text" id="shopping-item-name" required maxlength="500" autocomplete="off" aria-describedby="shopping-item-quick-add-hint shopping-item-quick-add-preview" data-i18n-placeholder-key="shopping.item.namePlaceholder" placeholder="${escapeHtmlAttr(t('shopping.item.namePlaceholder'))}">
              <div class="quick-add-hint" id="shopping-item-quick-add-hint" data-i18n-key="shopping.quickAdd.hint">${escapeHtmlAttr(t('shopping.quickAdd.hint'))}</div>
              <div class="quick-add-preview" id="shopping-item-quick-add-preview" aria-live="polite" hidden></div>
            </div>
          </section>
          <section class="ui-section-card ui-detail-section ui-section-divider ui-multi-add-single">
            <div class="ui-section-heading ui-detail-section-heading">
              <div class="ui-section-icon ui-detail-section-icon" data-icon="sliders-horizontal"></div>
              <div>
                <h4 data-i18n-key="shopping.item.details">${escapeHtmlAttr(t('shopping.item.details'))}</h4>
                <p data-i18n-key="shopping.item.detailsHint">${escapeHtmlAttr(t('shopping.item.detailsHint'))}</p>
              </div>
            </div>
            <div class="ui-field-grid two-columns shopping-item-create-grid">
              <div class="form-group">
                <label for="shopping-item-quantity" data-i18n-key="common.quantity">${escapeHtmlAttr(t('common.quantity'))}</label>
                <input class="ui-field" type="number" id="shopping-item-quantity" min="0" step="any" inputmode="decimal" data-i18n-placeholder-key="shopping.item.quantityPlaceholder" placeholder="${escapeHtmlAttr(t('shopping.item.quantityPlaceholder'))}">
              </div>
              <div class="form-group">
                <label for="shopping-item-unit" data-i18n-key="common.unit">${escapeHtmlAttr(t('common.unit'))}</label>
                <input class="ui-field" type="text" id="shopping-item-unit" maxlength="40" autocomplete="off" data-i18n-placeholder-key="shopping.item.unitPlaceholder" placeholder="${escapeHtmlAttr(t('shopping.item.unitPlaceholder'))}">
              </div>
              <div class="form-group">
                <label for="shopping-item-section" data-i18n-key="common.section">${escapeHtmlAttr(t('common.section'))}</label>
                <select class="ui-field" id="shopping-item-section" data-ui-select></select>
              </div>
              <div class="form-group shopping-item-store-group">
                <label for="shopping-item-store" data-i18n-key="shopping.item.store">${escapeHtmlAttr(t('shopping.item.store'))}</label>
                <select class="ui-field" id="shopping-item-store" data-ui-select></select>
                ${renderShoppingStoreCreator({ prefix: 'shopping-item' })}
              </div>
            </div>
          </section>
          ${renderMultiAddPanel({
            prefix: 'shopping-item',
            quickAddHintKey: 'shopping.multiAdd.quickAddHint',
            defaultsColumns: 2,
            defaultsHtml: `
              <div class="form-group">
                <label for="shopping-item-multi-section" data-i18n-key="common.section">${escapeHtmlAttr(t('common.section'))}</label>
                <select class="ui-field" id="shopping-item-multi-section" data-ui-select></select>
              </div>
              <div class="form-group shopping-item-store-group">
                <label for="shopping-item-multi-store" data-i18n-key="shopping.item.store">${escapeHtmlAttr(t('shopping.item.store'))}</label>
                <select class="ui-field" id="shopping-item-multi-store" data-ui-select></select>
                ${renderShoppingStoreCreator({ prefix: 'shopping-item-multi' })}
              </div>`,
          })}
          <div class="settings-field-error" id="shopping-item-error" role="alert"></div>
        </form>
    `,
  })}
`;

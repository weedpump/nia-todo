import { niaIconSvg } from '../icons/nia-product-icons.js';
import { t } from '../i18n/index.js';
import { renderEntitySidebarAddRow } from '../features/entity-sidebar.js';
import { renderModulePrimaryAction } from '../ui/module-primary-action.js';
import { renderTopbarToggle } from '../ui/topbar-toggle.js';
import { SHOPPING_DIALOGS_HTML } from './shopping-dialogs.js';

export const shoppingModule = Object.freeze({
  id: 'shopping',
  labelKey: 'module.shopping.label',
  descriptionKey: 'module.shopping.description',
  icon: 'shopping',
  searchEnabled: true,
  searchPlaceholderKey: 'shopping.search.placeholder',

  mount({ slots }) {
    slots.sidebar.innerHTML = `
      <nav class="nav-section" aria-label="${t('module.shopping.label')}" data-i18n-aria-label-key="module.shopping.label">
        <div class="nav-title" data-i18n-key="shopping.sidebar.personal">${t('shopping.sidebar.personal')}</div>
        <div id="shopping-list-sidebar"></div>
        ${renderEntitySidebarAddRow({ entityType: 'shopping-list', label: t('shopping.sidebar.add'), labelKey: 'shopping.sidebar.add' })}
      </nav>
      <nav class="nav-section entity-invitations-section" id="shopping-invites-section" hidden>
        <div class="nav-title" data-i18n-key="nav.invitations">${t('nav.invitations')}</div>
        <div id="shopping-invites-list"></div>
      </nav>
    `;
    slots.topbar.innerHTML = `
      ${renderTopbarToggle({
        id: 'shopping-hide-empty-sections-btn',
        icon: 'layers-minus',
        label: t('shopping.preferences.hideEmpty.short'),
        labelKey: 'shopping.preferences.hideEmpty.short',
        title: t('shopping.preferences.hideEmpty.enable'),
      })}
      ${renderTopbarToggle({
        id: 'shopping-completed-visibility-btn',
        icon: 'check-circle',
        label: t('shopping.preferences.showPurchased'),
        title: t('shopping.preferences.showPurchased'),
        attributes: {
          'data-completed-visibility-toggle': 'shopping',
          'data-completed-show-key': 'shopping.preferences.showPurchased',
          'data-completed-hide-key': 'shopping.preferences.hidePurchased',
        },
      })}
    `;
    slots.main.innerHTML = `
      <div id="shopping-navigation-main" class="module-page module-empty-page">
        <div class="module-empty-icon" aria-hidden="true">${niaIconSvg('shopping')}</div>
      </div>
      ${SHOPPING_DIALOGS_HTML}
    `;
    slots.floating.innerHTML = renderModulePrimaryAction({
      actionAttribute: 'data-shopping-item-action',
      action: 'open-create',
      ariaLabel: t('shopping.item.add'),
      ariaLabelKey: 'shopping.item.add',
      title: t('shopping.item.add'),
      titleKey: 'shopping.item.add',
    });
    slots.userMenu.innerHTML = '';
    slots.shortcuts.innerHTML = `
      <section class="ui-section-card ui-detail-section ui-section-divider shortcuts-section" aria-labelledby="shortcuts-shopping-title">
        <div class="ui-section-heading">
          <div class="ui-section-icon" data-icon="shopping-cart"></div>
          <div><h4 id="shortcuts-shopping-title" data-i18n-key="module.shopping.label">${t('module.shopping.label')}</h4></div>
        </div>
        <div class="shortcuts-list">
          <div class="shortcuts-row"><span class="shortcuts-label" data-i18n-key="shortcuts.toggleItemCompletion">${t('shortcuts.toggleItemCompletion')}</span><span class="shortcuts-keys"><kbd>Space</kbd></span></div>
          <div class="shortcuts-row"><span class="shortcuts-label" data-i18n-key="shortcuts.deleteItem">${t('shortcuts.deleteItem')}</span><span class="shortcuts-keys"><kbd>Delete</kbd></span></div>
        </div>
      </section>
    `;
    slots.settingsNav.innerHTML = '';
    slots.settings.innerHTML = '';
    slots.desktopHotkeys.innerHTML = '';
  },
});

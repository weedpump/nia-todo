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
    `;
    slots.topbar.innerHTML = renderTopbarToggle({
      id: 'shopping-hide-empty-sections-btn',
      icon: 'layers-minus',
      label: t('shopping.preferences.hideEmpty.short'),
      labelKey: 'shopping.preferences.hideEmpty.short',
      title: t('shopping.preferences.hideEmpty.enable'),
    });
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
    slots.shortcuts.innerHTML = '';
    slots.settingsNav.innerHTML = '';
    slots.settings.innerHTML = '';
    slots.desktopHotkeys.innerHTML = '';
  },
});

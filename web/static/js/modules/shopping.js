import { niaIconSvg } from '../icons/nia-product-icons.js';
import { t } from '../i18n/index.js';
import { renderEntitySidebarAddRow } from '../features/entity-sidebar.js';

export const shoppingModule = Object.freeze({
  id: 'shopping',
  labelKey: 'module.shopping.label',
  descriptionKey: 'module.shopping.description',
  icon: 'shopping',
  searchEnabled: false,
  searchPlaceholderKey: 'common.search',

  mount({ slots }) {
    slots.sidebar.innerHTML = `
      <nav class="nav-section" aria-label="${t('module.shopping.label')}" data-i18n-aria-label-key="module.shopping.label">
        <div class="nav-title" data-i18n-key="shopping.sidebar.personal">${t('shopping.sidebar.personal')}</div>
        <div id="shopping-list-sidebar"></div>
        ${renderEntitySidebarAddRow({ entityType: 'shopping-list', label: t('shopping.sidebar.add'), labelKey: 'shopping.sidebar.add' })}
      </nav>
    `;
    slots.topbar.innerHTML = '';
    slots.main.innerHTML = `
      <div id="shopping-navigation-main" class="module-page module-empty-page">
        <div class="module-empty-icon" aria-hidden="true">${niaIconSvg('shopping')}</div>
      </div>
    `;
    slots.floating.innerHTML = '';
    slots.userMenu.innerHTML = '';
    slots.shortcuts.innerHTML = '';
    slots.settingsNav.innerHTML = '';
    slots.settings.innerHTML = '';
    slots.desktopHotkeys.innerHTML = '';
  },
});

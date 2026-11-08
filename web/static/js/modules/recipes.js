import { t } from '../i18n/index.js';
import { renderEntitySidebarAddRow } from '../features/entity-sidebar.js';
import { RECIPES_DIALOGS_HTML } from './recipes-dialogs.js';
import { renderModulePrimaryAction } from '../ui/module-primary-action.js';

export const recipesModule = Object.freeze({
  id: 'recipes',
  labelKey: 'module.recipes.label',
  descriptionKey: 'module.recipes.description',
  icon: 'recipes',
  capabilities: Object.freeze({ workspaces: false }),
  searchEnabled: true,
  searchPlaceholderKey: 'recipe.search.placeholder',
  mount({ slots }) {
    slots.sidebar.innerHTML = `
      <nav class="nav-section" aria-label="${t('cookbook.sidebar.title')}" data-i18n-aria-label-key="cookbook.sidebar.title">
        <div class="nav-title" data-i18n-key="cookbook.sidebar.title">${t('cookbook.sidebar.title')}</div>
        <div id="cookbook-sidebar"></div>
        ${renderEntitySidebarAddRow({ entityType: 'cookbook', label: t('cookbook.sidebar.add'), labelKey: 'cookbook.sidebar.add' })}
      </nav>
      <nav class="nav-section entity-invitations-section" id="cookbook-invites-section" hidden>
        <div class="nav-title" data-i18n-key="nav.invitations">${t('nav.invitations')}</div>
        <div id="cookbook-invites-list"></div>
      </nav>`;
    slots.main.innerHTML = `<div id="cookbook-navigation-main" class="module-page module-empty-page"></div>${RECIPES_DIALOGS_HTML}`;
    for (const name of ['topbar', 'floating', 'userMenu', 'shortcuts', 'settingsNav', 'settings', 'desktopHotkeys']) slots[name].innerHTML = '';
    slots.floating.innerHTML = renderModulePrimaryAction({ actionAttribute: 'data-recipe-action', action: 'create', ariaLabel: t('recipe.add'), ariaLabelKey: 'recipe.add', title: t('recipe.add'), titleKey: 'recipe.add' });
    slots.floating.querySelector('button').hidden = true;
  },
});

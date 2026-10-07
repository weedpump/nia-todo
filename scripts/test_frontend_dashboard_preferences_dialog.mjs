#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const indexHtml = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../web/static/js/app.js', import.meta.url), 'utf8');
const renderingSource = readFileSync(new URL('../web/static/js/features/app-rendering.js', import.meta.url), 'utf8');
const dialogSource = readFileSync(new URL('../web/static/js/features/dashboard-preferences-dialog.js', import.meta.url), 'utf8');
const iconsSource = readFileSync(new URL('../web/static/js/icons/lucide-generated.js', import.meta.url), 'utf8');
const dashboardCss = readFileSync(new URL('../web/static/css/12-overview-dashboard.css', import.meta.url), 'utf8');
const de = JSON.parse(readFileSync(new URL('../web/static/i18n/de.json', import.meta.url), 'utf8'));
const en = JSON.parse(readFileSync(new URL('../web/static/i18n/en.json', import.meta.url), 'utf8'));
const localeDictionaries = readdirSync(new URL('../web/static/i18n/', import.meta.url))
  .filter(file => file.endsWith('.json'))
  .map(file => [file, JSON.parse(readFileSync(new URL(`../web/static/i18n/${file}`, import.meta.url), 'utf8'))]);

console.log('🎛️ Running dashboard preferences dialog contract test...');

assert.match(indexHtml, /id="dashboard-preferences-modal"/);
assert.match(indexHtml, /id="dashboard-preferences-menu-btn"[^>]*data-dashboard-preferences-action="open"/, 'dashboard customization must remain accessible through the user menu');
assert.doesNotMatch(renderingSource, /overview-dashboard-customize|data-dashboard-preferences-action="open"/, 'the dashboard widget must not contain a customization button');
assert.match(indexHtml, /class="modal ui-detail-modal ui-detail-view dashboard-preferences-modal"/);
assert.match(indexHtml, /class="modal-content entity-modal-content ui-detail-modal-content dashboard-preferences-modal-content"/);
assert.match(indexHtml, /id="dashboard-preferences-form"/);
assert.doesNotMatch(indexHtml, /id="dashboard-preferences-mode"/);
assert.match(indexHtml, /id="dashboard-preferences-compact-display"/);
assert.doesNotMatch(indexHtml, /id="dashboard-preferences-show-subtitle"/);
assert.match(indexHtml, /id="dashboard-preferences-project-scope"/);
assert.doesNotMatch(indexHtml, /id="dashboard-preferences-include-unassigned"/);
assert.match(indexHtml, /id="dashboard-preferences-projects"/);
assert.match(indexHtml, /class="dashboard-preferences-project-controls"/, 'project scope and project multi-select need a shared responsive row');
assert.match(indexHtml, /data-i18n-key="focus\.projects">Projekte</, 'project multi-select needs a visible localized field label');
assert.match(indexHtml, /id="dashboard-preferences-stats"/);
assert.match(indexHtml, /id="dashboard-preferences-focus-items"/);
assert.match(indexHtml, /id="dashboard-preferences-save"/);
assert.match(indexHtml, /id="dashboard-preferences-reset"[^>]*data-dashboard-preferences-action="reset"/);
assert.match(indexHtml, /data-i18n-aria-label-key="dashboard.preferences.close"/);
assert.match(indexHtml, /class="entity-modal-header dashboard-preferences-modal-header ui-detail-modal-header"/);
assert.match(indexHtml, /<button type="submit" form="dashboard-preferences-form" class="btn btn-primary" id="dashboard-preferences-save"/);
assert.match(indexHtml, /id="dashboard-preferences-save"[\s\S]*id="dashboard-preferences-reset"[\s\S]*data-dashboard-preferences-action="cancel"/, 'reset action must sit between save and close');
assert.doesNotMatch(indexHtml, /class="modal-actions dashboard-preferences-actions"/);

const modalHtml = indexHtml.slice(
  indexHtml.indexOf('id="dashboard-preferences-modal"'),
  indexHtml.indexOf('<!-- Todo Modal -->'),
);
const modalSelects = [...modalHtml.matchAll(/<select\b([^>]*)>/g)];
assert.equal(modalSelects.length, 7, 'dashboard preferences must expose seven select fields');
for (const [, attrs] of modalSelects) {
  assert.match(attrs, /\bdata-ui-select\b/, 'dashboard select fields must use the shared nia-todo select component');
}
assert.match(dialogSource, /hydrateSelect\(/);
assert.doesNotMatch(dialogSource, /getDashboardModeCapabilities/);
assert.match(dialogSource, /focus-project-dropdown/);
assert.match(dialogSource, /focus-project-option/);
assert.match(dialogSource, /ui-select-search-input/);
assert.doesNotMatch(dialogSource, /data-dashboard-project-id[^\n]*:checked/);
assert.doesNotMatch(indexHtml, /data-dashboard-content-option=/);
assert.match(dialogSource, /renderDashboard\?\.\(\)/, 'saving dashboard preferences must refresh the visible dashboard immediately');
assert.match(appSource, /renderDashboard:\s*\(\)\s*=>\s*\{\s*renderStats\(\);\s*renderTodos\(\);\s*\}/s, 'saving or resetting dashboard preferences must refresh dashboard widgets and active todo/drilldown views');
assert.match(dashboardCss, /\.dashboard-preferences-modal \.ui-checkbox-box\s*\{[^}]*width:\s*18px[^}]*height:\s*18px/s, 'dashboard checkboxes must use the compact shared checkbox variant');
assert.match(dashboardCss, /\.dashboard-preferences-layout-controls\s*\{[^}]*display:\s*grid[^}]*gap:/s, 'dashboard display and content options must use a consistent layout');
assert.match(dashboardCss, /\.dashboard-preferences-layout-controls \.dashboard-preferences-toggle-list\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,/s, 'dashboard content options must form their own responsive row');
assert.match(dashboardCss, /\.dashboard-preferences-modal \.dashboard-preferences-project-dropdown\s*\{[^}]*max-width:\s*none/s, 'dashboard project multi-select must override the narrower filter-view width');
assert.match(dashboardCss, /\.dashboard-preferences-modal \.dashboard-preferences-project-trigger\s*\{[^}]*min-height:\s*36px/s, 'project scope and project multi-select triggers must use the same height');
assert.match(dashboardCss, /\.dashboard-preferences-project-controls\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s, 'project controls must sit side by side on desktop');

const layoutCss = [
  '00-base.css',
  '12-overview-dashboard.css',
  '30-buttons-empty.css',
  '31-modals.css',
  '82-entity-modals.css',
  '89-ui-detail-modal.css',
].map(file => readFileSync(new URL(`../web/static/css/${file}`, import.meta.url), 'utf8')).join('\n');
const modalFixture = indexHtml.slice(
  indexHtml.lastIndexOf('<!-- Dashboard Preferences Modal -->'),
  indexHtml.indexOf('<!-- Todo Modal -->'),
);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`<style>${layoutCss}</style>${modalFixture}`);
  await page.locator('#dashboard-preferences-modal').evaluate(modal => modal.classList.add('active'));
  for (const [localeFile, dictionary] of localeDictionaries) {
    await page.locator('#dashboard-preferences-modal-title').evaluate((title, text) => { title.textContent = text; }, dictionary['dashboard.preferences.title']);
    await page.locator('#dashboard-preferences-save').evaluate((button, text) => { button.textContent = text; }, dictionary['common.save']);
    for (const width of [320, 360, 390, 480, 481, 500, 600, 768]) {
      await page.setViewportSize({ width, height: 800 });
      const geometry = await page.evaluate(() => {
        const header = document.querySelector('.dashboard-preferences-modal-header');
        const icon = header.children[0].getBoundingClientRect();
        const title = header.children[1].getBoundingClientRect();
        const actions = header.querySelector('.ui-detail-header-actions').getBoundingClientRect();
        return { icon, title, actions };
      });
      const overlaps = (a, b) => Math.max(a.left, b.left) < Math.min(a.right, b.right)
        && Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom);
      assert.equal(overlaps(geometry.icon, geometry.title), false, `${localeFile} ${width}px header icon and title must remain aligned without overlap`);
      assert.equal(overlaps(geometry.title, geometry.actions), false, `${localeFile} ${width}px title must not overlap Save, Reset, or Close actions`);
      assert.equal(overlaps(geometry.icon, geometry.actions), false, `${localeFile} ${width}px icon must not overlap Save, Reset, or Close actions`);
    }
  }

  const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
  await page.route('http://nia.test/**', async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname === '/dashboard-preferences-test.html') {
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><body>${modalFixture}</body></html>`,
      });
      return;
    }
    const filePath = resolve(webRoot, `.${requestUrl.pathname}`);
    if (!filePath.startsWith(webRoot)) {
      await route.abort();
      return;
    }
    const contentTypes = {
      '.css': 'text/css',
      '.js': 'text/javascript',
      '.json': 'application/json',
    };
    try {
      await route.fulfill({
        contentType: contentTypes[extname(filePath)] || 'application/octet-stream',
        body: readFileSync(filePath),
      });
    } catch {
      await route.fulfill({ status: 404, body: 'Not found' });
    }
  });
  await page.goto('http://nia.test/dashboard-preferences-test.html');
  await page.evaluate(async () => {
    const { setLanguagePreference } = await import('/static/js/i18n/index.js');
    const { createDashboardPreferencesFeature } = await import('/static/js/features/dashboard-preferences-dialog.js');
    await setLanguagePreference('en');
    const persistedPreferences = {
      compactDisplay: false,
      showFocus: true,
      showActiveProjects: true,
      showProjectWidgets: false,
      projectScope: { mode: 'include', projectIds: [1] },
      stats: ['total', 'pending', 'in_progress', 'overdue'],
      focusItems: ['overdue', 'due_today'],
      hideEmptyFocusItems: false,
      activeProjects: { limit: 5, sort: 'activity' },
    };
    const feature = createDashboardPreferencesFeature({
      getPreferences: () => persistedPreferences,
      setPreferences(preferences) { window.__savedDashboardPreferences = preferences; },
      getProjects: () => [
        { id: 1, name: 'Alpha', parent_id: null },
        { id: 2, name: 'Beta', parent_id: null },
        { id: 3, name: 'Gamma', parent_id: null },
      ],
      renderDashboard() {},
    });
    feature.bindDashboardPreferencesActions();
    feature.openDashboardPreferences(document.body);
    window.__dashboardPreferencesFeature = feature;
  });

  const setDraft = async draft => page.evaluate(nextDraft => {
    const setChecked = (selector, checked) => { document.querySelector(selector).checked = checked; };
    setChecked('#dashboard-preferences-compact-display', nextDraft.compactDisplay);
    setChecked('#dashboard-preferences-show-focus', nextDraft.showFocus);
    setChecked('#dashboard-preferences-show-active-projects', nextDraft.showActiveProjects);
    setChecked('#dashboard-preferences-show-project-widgets', nextDraft.showProjectWidgets);
    document.querySelector('#dashboard-preferences-project-scope').value = nextDraft.projectScope;
    document.querySelectorAll('[data-dashboard-preference-project-id]').forEach(option => {
      const selected = nextDraft.projectIds.includes(Number(option.dataset.dashboardPreferenceProjectId));
      option.classList.toggle('is-selected', selected);
      option.setAttribute('aria-checked', selected ? 'true' : 'false');
    });
    document.querySelectorAll('[data-dashboard-stat-slot]').forEach((select, index) => { select.value = nextDraft.stats[index]; });
    document.querySelectorAll('[data-dashboard-focus-item]').forEach(input => { input.checked = nextDraft.focusItems.includes(input.value); });
    setChecked('#dashboard-preferences-hide-empty-focus', nextDraft.hideEmptyFocusItems);
    document.querySelector('#dashboard-preferences-project-limit').value = String(nextDraft.limit);
    document.querySelector('#dashboard-preferences-project-sort').value = nextDraft.sort;
  }, draft);

  const readDraft = async () => page.evaluate(() => ({
    compactDisplay: document.querySelector('#dashboard-preferences-compact-display').checked,
    showFocus: document.querySelector('#dashboard-preferences-show-focus').checked,
    showActiveProjects: document.querySelector('#dashboard-preferences-show-active-projects').checked,
    showProjectWidgets: document.querySelector('#dashboard-preferences-show-project-widgets').checked,
    projectScope: document.querySelector('#dashboard-preferences-project-scope').value,
    projectIds: [...document.querySelectorAll('[data-dashboard-preference-project-id].is-selected')].map(option => Number(option.dataset.dashboardPreferenceProjectId)),
    stats: [...document.querySelectorAll('[data-dashboard-stat-slot]')].map(select => select.value),
    focusItems: [...document.querySelectorAll('[data-dashboard-focus-item]:checked')].map(input => input.value),
    hideEmptyFocusItems: document.querySelector('#dashboard-preferences-hide-empty-focus').checked,
    limit: Number(document.querySelector('#dashboard-preferences-project-limit').value),
    sort: document.querySelector('#dashboard-preferences-project-sort').value,
  }));

  const projectTrigger = page.locator('#dashboard-preferences-projects .dashboard-preferences-project-trigger');
  assert.match(
    await projectTrigger.getAttribute('aria-labelledby') || '',
    /dashboard-preferences-projects-label\s+dashboard-preferences-projects-value/,
    'the project picker trigger must be named by both its visible label and current value',
  );
  assert.equal(
    await page.locator('#dashboard-preferences-projects').getByRole('button', { name: 'Projects Alpha', exact: true }).count(),
    1,
    'Chromium must expose the project picker with its visible label and current selection',
  );

  const sharedSelectTriggers = page.locator('#dashboard-preferences-modal .ui-select > .ui-select-trigger');
  assert.equal(await sharedSelectTriggers.count(), 7, 'the composed-DOM regression must exercise all seven shared select controls');
  for (let index = 0; index < 7; index += 1) {
    const trigger = sharedSelectTriggers.nth(index);
    await trigger.click();
    const menuId = await trigger.getAttribute('aria-controls');
    const escapeResult = await page.locator(`#${menuId}`).evaluate(menu => {
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      menu.dispatchEvent(event);
      return { defaultPrevented: event.defaultPrevented };
    });
    assert.equal(escapeResult.defaultPrevented, true, `Escape must be consumed by shared select ${index + 1}`);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false', `Escape must close shared select ${index + 1}`);
    assert.equal(await page.locator('#dashboard-preferences-modal').evaluate(modal => modal.classList.contains('active')), true, `Escape on shared select ${index + 1} must keep the modal open`);
  }

  await page.locator('#dashboard-preferences-reset').click();
  const resetPreferences = await page.evaluate(() => window.__savedDashboardPreferences);
  assert.equal(resetPreferences.compactDisplay, false, 'Reset must persist the default density immediately');
  assert.deepEqual(resetPreferences.stats, ['total', 'pending', 'in_progress', 'overdue'], 'Reset must persist the default metrics immediately');
  assert.deepEqual(resetPreferences.focusItems, ['overdue', 'due_today', 'due_week', 'high_priority'], 'Reset must persist the default focus groups immediately');
  await page.locator('.modal-close-x[data-dashboard-preferences-action="cancel"]').click();
  assert.equal(await page.locator('#dashboard-preferences-modal').evaluate(modal => modal.classList.contains('active')), false, 'Close must dismiss the modal after an immediate Reset');
  assert.deepEqual(await page.evaluate(() => window.__savedDashboardPreferences), resetPreferences, 'Closing after Reset must not roll back the explicitly persisted defaults');
  await page.evaluate(() => window.__dashboardPreferencesFeature.openDashboardPreferences(document.getElementById('user-menu-button')));

  const validDraft = {
    compactDisplay: true,
    showFocus: false,
    showActiveProjects: false,
    showProjectWidgets: true,
    projectScope: 'include',
    projectIds: [2, 3],
    stats: ['done', 'total', 'overdue', 'pending'],
    focusItems: ['high_priority'],
    hideEmptyFocusItems: true,
    limit: 6,
    sort: 'alphabetical',
  };
  await setDraft(validDraft);
  await page.evaluate(async () => {
    const { setLanguagePreference } = await import('/static/js/i18n/index.js');
    await setLanguagePreference('de');
  });
  assert.deepEqual(await readDraft(), validDraft, 'language changes must preserve every valid unsaved dashboard preference');
  assert.equal(await page.locator('.dashboard-preferences-project-menu .ui-select-search-input').getAttribute('placeholder'), de['focus.projects.search'], 'language changes must refresh custom project-picker labels');

  const invalidDraft = {
    compactDisplay: false,
    showFocus: true,
    showActiveProjects: false,
    showProjectWidgets: true,
    projectScope: 'exclude',
    projectIds: [1, 3],
    stats: ['done', 'done', 'overdue', 'pending'],
    focusItems: [],
    hideEmptyFocusItems: false,
    limit: 2,
    sort: 'open_count',
  };
  await setDraft(invalidDraft);
  assert.equal(await page.evaluate(() => window.__dashboardPreferencesFeature.readForm()), null, 'duplicate metric selections must keep Save validation active');
  await page.evaluate(async () => {
    const { setLanguagePreference } = await import('/static/js/i18n/index.js');
    await setLanguagePreference('en');
  });
  assert.deepEqual(await readDraft(), invalidDraft, 'language changes must preserve temporarily invalid drafts, including duplicate metrics and no focus items');
  assert.equal(await page.locator('#dashboard-preferences-error').textContent(), en['dashboard.preferences.validation.stats'], 'an active validation message must be refreshed in the new language');

  const projectDropdownTrigger = page.locator('.dashboard-preferences-project-trigger');
  await projectDropdownTrigger.focus();
  await page.keyboard.press('Enter');
  assert.equal(await projectDropdownTrigger.getAttribute('aria-expanded'), 'true', 'the custom project dropdown must open from the keyboard');
  const projectSearchInput = page.locator('.dashboard-preferences-project-menu .ui-select-search-input');
  await projectSearchInput.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.activeElement?.matches('.dashboard-preferences-project-menu .ui-select-search-input'));
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.dashboardPreferenceProjectId), '1', 'ArrowDown from search must focus the first visible project');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.dashboardPreferenceProjectId), '2', 'ArrowDown must move to the next visible project');
  const betaCheckedBefore = await page.locator('[data-dashboard-preference-project-id="2"]').getAttribute('aria-checked');
  await page.keyboard.press('Space');
  assert.notEqual(await page.locator('[data-dashboard-preference-project-id="2"]').getAttribute('aria-checked'), betaCheckedBefore, 'Space must toggle the focused project and its aria-checked state');
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.dashboardPreferenceProjectId), '3', 'End must focus the last visible project');
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.dashboardPreferenceProjectId), '1', 'Home must focus the first visible project');
  await projectSearchInput.focus();
  await page.keyboard.type('gam');
  assert.deepEqual(await page.locator('[data-dashboard-preference-project-id]:not([hidden])').evaluateAll(options => options.map(option => option.dataset.dashboardPreferenceProjectId)), ['3'], 'search filtering must leave only matching projects navigable');
  assert.equal(await page.locator('[data-dashboard-preference-project-id="1"]').getAttribute('tabindex'), '-1', 'a hidden project option must leave the roving tab stop');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.dashboardPreferenceProjectId), '3', 'filtered keyboard navigation must skip hidden project options');
  await page.evaluate(() => {
    const option = document.querySelector('[data-dashboard-preference-project-id="3"]');
    option.disabled = true;
    document.querySelector('.dashboard-preferences-project-menu .ui-select-search-input').focus();
  });
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.matches('.ui-select-search-input')), true, 'keyboard navigation must not focus a disabled visible option');
  await page.keyboard.press('Escape');
  assert.equal(await projectDropdownTrigger.getAttribute('aria-expanded'), 'false', 'Escape must close the custom project dropdown');
  assert.equal(await page.locator('#dashboard-preferences-modal').evaluate(modal => modal.classList.contains('active')), true, 'Escape on the custom project dropdown must keep the modal open');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('dashboard-preferences-project-trigger')), true, 'Escape must restore focus to the project trigger');

  const subsequentEscapeState = await projectDropdownTrigger.evaluate(async trigger => {
    const { isDropdownOpen } = await import('/static/js/ui/dropdowns.js');
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    const sharedDropdownWasOpen = isDropdownOpen();
    trigger.dispatchEvent(event);
    return {
      defaultPrevented: event.defaultPrevented,
      modalActive: document.getElementById('dashboard-preferences-modal').classList.contains('active'),
      sharedDropdownWasOpen,
      sharedDropdownIsOpen: isDropdownOpen(),
    };
  });
  assert.equal(subsequentEscapeState.sharedDropdownWasOpen, false, 'no shared select may remain open after its first Escape');
  assert.equal(subsequentEscapeState.defaultPrevented, true, 'the subsequent Escape must be consumed by the modal');
  assert.equal(subsequentEscapeState.modalActive, false, 'a subsequent Escape must close the modal');
} finally {
  await browser.close();
}

for (const icon of ['sliders-horizontal', 'folder-tree', 'folders', 'chart-no-axes-column', 'rotate-ccw']) {
  assert.match(iconsSource, new RegExp(`"${icon}":`), `${icon} must be available in the local Lucide cache`);
}

assert.match(appSource, /createDashboardPreferencesFeature/);
assert.match(appSource, /bindDashboardPreferencesActions/);

const requiredKeys = [
  'dashboard.preferences.open',
  'dashboard.preferences.title',
  'dashboard.preferences.subtitle',
  'dashboard.preferences.close',
  'dashboard.preferences.layout.title',
  'dashboard.preferences.layout.hint',
  'dashboard.preferences.layout.compact',
  'dashboard.preferences.content.title',
  'dashboard.preferences.projects.title',
  'dashboard.preferences.stats.title',
  'dashboard.preferences.focus.title',
  'dashboard.preferences.activeProjects.title',
  'dashboard.preferences.validation.stats',
  'dashboard.preferences.saved',
];

for (const key of requiredKeys) {
  assert.equal(typeof de[key], 'string', `German locale must contain ${key}`);
  assert.equal(typeof en[key], 'string', `English locale must contain ${key}`);
}

assert.equal(de['dashboard.preferences.content.projectWidgets'], 'Projekt-Widgets anzeigen');
assert.equal(en['dashboard.preferences.content.projectWidgets'], 'Show project widgets');

class FakeClassList {
  constructor(values = []) { this.values = new Set(values); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, active) {
    if (active) this.values.add(value);
    else this.values.delete(value);
  }
}

const listeners = new Map();
const focusable = label => ({
  label,
  hidden: false,
  disabled: false,
  isConnected: true,
  closest(selector) { return selector === '[hidden]' ? null : null; },
  focus() { globalThis.document.activeElement = this; },
});
const firstFocusable = focusable('first');
const lastFocusable = focusable('last');
const projectTrigger = focusable('project-trigger');
projectTrigger.disabled = false;
projectTrigger.attributes = new Map([['aria-expanded', 'true']]);
projectTrigger.setAttribute = (name, value) => projectTrigger.attributes.set(name, value);
const projectSearch = focusable('project-search');
const projectMenu = {
  hidden: false,
  querySelector(selector) { return selector === '.ui-select-search-input' ? projectSearch : null; },
};
const projectDropdown = {
  classList: new FakeClassList(['is-open']),
  querySelector(selector) {
    if (selector === '.dashboard-preferences-project-trigger') return projectTrigger;
    if (selector === '.dashboard-preferences-project-menu') return projectMenu;
    return null;
  },
};
const modal = {
  classList: new FakeClassList(),
  attributes: new Map([['aria-hidden', 'true']]),
  setAttribute(name, value) { this.attributes.set(name, value); },
  querySelectorAll(selector) {
    return selector.includes('a[href]') ? [firstFocusable, lastFocusable] : [];
  },
  contains(element) { return element === firstFocusable || element === lastFocusable || element === projectTrigger || element === projectSearch; },
};
const userMenuButton = focusable('user-menu-button');
userMenuButton.attributes = new Map();
userMenuButton.setAttribute = (name, value) => userMenuButton.attributes.set(name, value);
const openButton = focusable('dashboard-preferences-menu-item');
openButton.dataset = { dashboardPreferencesAction: 'open' };
openButton.hidden = false;
const userMenu = { classList: new FakeClassList(['active']) };
const form = { addEventListener() {} };
const scope = { addEventListener() {}, value: 'all' };

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { language: 'en', languages: ['en'] },
});
globalThis.localStorage = { getItem() { return 'en'; }, setItem() {}, removeItem() {} };
globalThis.window = {
  setTimeout(callback) { callback(); },
  addEventListener() {},
};
globalThis.document = {
  activeElement: openButton,
  getElementById(id) {
    if (id === 'dashboard-preferences-modal') return modal;
    if (id === 'user-menu-button') return userMenuButton;
    if (id === 'user-menu') return userMenu;
    if (id === 'dashboard-preferences-form') return form;
    if (id === 'dashboard-preferences-project-scope') return scope;
    return null;
  },
  querySelector(selector) {
    if (selector === '.dashboard-preferences-project-dropdown') return projectDropdown;
    return null;
  },
  querySelectorAll() { return []; },
  addEventListener(type, listener) { listeners.set(type, listener); },
};

const { createDashboardPreferencesFeature } = await import('../web/static/js/features/dashboard-preferences-dialog.js');
const keyboardFeature = createDashboardPreferencesFeature({
  getPreferences: () => ({}),
  setPreferences() {},
  getProjects: () => [],
  renderDashboard() {},
});
keyboardFeature.bindDashboardPreferencesActions();
const clickListener = listeners.get('click');
const keydownListener = listeners.get('keydown');
clickListener({
  target: {
    closest(selector) { return selector === '[data-dashboard-preferences-action]' ? openButton : null; },
  },
  preventDefault() {},
});
assert.equal(modal.classList.contains('active'), true);
openButton.hidden = true;
projectDropdown.classList.add('is-open');
projectTrigger.setAttribute('aria-expanded', 'true');
projectMenu.hidden = false;

let prevented = false;
keydownListener({
  key: 'Escape',
  target: { closest(selector) { return selector === '.dashboard-preferences-project-dropdown' ? projectDropdown : null; } },
  preventDefault() { prevented = true; },
});
assert.equal(prevented, true);
assert.equal(projectDropdown.classList.contains('is-open'), false, 'Escape must close the nested project dropdown first');
assert.equal(modal.classList.contains('active'), true, 'closing the nested dropdown must keep the modal open');
assert.equal(globalThis.document.activeElement, projectTrigger, 'closing the project dropdown must restore focus to its trigger');

prevented = false;
keydownListener({ key: 'Escape', target: modal, preventDefault() { prevented = true; } });
assert.equal(prevented, true);
assert.equal(modal.classList.contains('active'), false, 'a second Escape must close the modal');
assert.equal(globalThis.document.activeElement, userMenuButton, 'closing the modal must restore focus to the visible user-menu button after its menu item is hidden');

modal.classList.add('active');
globalThis.document.activeElement = lastFocusable;
prevented = false;
keydownListener({ key: 'Tab', target: lastFocusable, shiftKey: false, preventDefault() { prevented = true; } });
assert.equal(prevented, true);
assert.equal(globalThis.document.activeElement, firstFocusable, 'Tab must wrap focus to the first modal control');
globalThis.document.activeElement = firstFocusable;
keydownListener({ key: 'Tab', target: firstFocusable, shiftKey: true, preventDefault() {} });
assert.equal(globalThis.document.activeElement, lastFocusable, 'Shift+Tab must wrap focus to the last modal control');

console.log('✅ Dashboard preferences dialog contract passed');

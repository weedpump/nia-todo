#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const entitySidebarUrl = new URL('web/static/js/features/entity-sidebar.js', root);
const shoppingNavigationUrl = new URL('web/static/js/features/shopping-navigation.js', root);

assert(existsSync(entitySidebarUrl), 'the neutral entity sidebar production module must exist');
assert(existsSync(shoppingNavigationUrl), 'shopping navigation must be implemented as a domain adapter');

globalThis.document = {
  createElement() {
    let value = '';
    return {
      set textContent(next) { value = String(next ?? ''); },
      get innerHTML() {
        return value
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#039;');
      },
    };
  },
};

const {
  bindEntitySidebarNavigation,
  classifyEntityOwnership,
  renderEntitySidebarAddRow,
  renderEntitySidebarRow,
  renderEntitySidebarSection,
} = await import(entitySidebarUrl);
const { createShoppingNavigationFeature, renderShoppingSidebar } = await import(shoppingNavigationUrl);

const entities = [
  { id: 1, name: 'Personal', color: '#123456', icon: 'star', ownership_type: 'user', is_shared: false },
  { id: 2, name: 'Household owner', color: '#654321', icon: null, ownership_type: 'household', owner_household_id: 7, is_shared: false },
  { id: 3, name: 'Household member', color: '#abcdef', icon: null, ownership_type: 'household', owner_household_id: 7, is_shared: true },
  { id: 4, name: 'Direct share', color: '#fedcba', icon: 'shopping-cart', ownership_type: 'user', is_shared: true },
];

assert.equal(classifyEntityOwnership(entities[0]), 'personal');
assert.equal(classifyEntityOwnership(entities[1]), 'household');
assert.equal(classifyEntityOwnership(entities[2]), 'household', 'household ownership must win over a stale shared flag');
assert.equal(classifyEntityOwnership(entities[3]), 'shared');

const row = renderEntitySidebarRow({
  entity: entities[0],
  entityType: 'project',
  active: true,
  count: 5,
  depth: 2,
  rowClass: 'project-tree-item',
  selectAttributes: { 'data-filter': '1' },
});
assert.match(row, /class="entity-sidebar-item project-tree-item"/);
assert.match(row, /class="nav-btn ui-nav-pill entity-sidebar-select active"/);
assert.match(row, /aria-current="page"/);
assert.match(row, /data-entity-sidebar-action="select"/);
assert.match(row, /data-entity-type="project"/);
assert.match(row, /data-entity-id="1"/);
assert.match(row, /data-filter="1"/);
assert.match(row, /padding-left: 32px/);
assert.match(row, /class="badge">5</);
assert.match(row, /data-entity-sidebar-action="detail"/);
assert.match(row, /class="nav-edit entity-sidebar-detail"/);
assert.match(row, /aria-label="common\.openDetailsFor"/);

const section = renderEntitySidebarSection({
  section: 'household',
  title: 'Household',
  icon: 'house-heart',
  rows: row,
});
assert.match(section, /data-entity-section="household"/);
assert.match(section, /class="nav-title shared-title household-title entity-sidebar-section-title"/);
assert.match(section, /Household/);

const addRow = renderEntitySidebarAddRow({ entityType: 'shopping-list', label: 'Add list' });
assert.match(addRow, /data-entity-sidebar-action="add"/);
assert.match(addRow, /data-entity-type="shopping-list"/);
assert.match(addRow, /class="entity-icon entity-sidebar-add-icon"/);

const calls = [];
let listener = null;
const rootElement = {
  addEventListener(type, callback) {
    assert.equal(type, 'click');
    listener = callback;
  },
  removeEventListener(type, callback) {
    assert.equal(type, 'click');
    if (listener === callback) listener = null;
  },
};
const controller = bindEntitySidebarNavigation({
  root: rootElement,
  entityType: 'shopping-list',
  onSelect: (id, context) => calls.push(['select', id, context]),
  onDetail: (id, context) => calls.push(['detail', id, context]),
  onAdd: context => calls.push(['add', context]),
  closeSidebar: options => { calls.push(['close', options]); return true; },
});
assert.equal(typeof controller.destroy, 'function');

function click(action, id = '') {
  let prevented = false;
  let stopped = false;
  const target = {
    dataset: { entitySidebarAction: action, entityType: 'shopping-list', entityId: id },
    closest(selector) {
      return selector === '[data-entity-sidebar-action]' ? this : null;
    },
  };
  listener({
    target,
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
  });
  assert.equal(prevented, true);
  assert.equal(stopped, action === 'detail');
}

click('select', '7');
click('detail', '7');
click('add');
assert.deepEqual(calls, [
  ['close', { preserveHistory: true }],
  ['select', '7', { sidebarClosed: true }],
  ['close', { preserveHistory: true }],
  ['detail', '7', { sidebarClosed: true }],
  ['close', { preserveHistory: true }],
  ['add', { sidebarClosed: true }],
]);
controller.destroy();
assert.equal(listener, null);

const shoppingHtml = renderShoppingSidebar({
  lists: [
    { ...entities[0], items: [{ completed: false }, { completed: true }] },
    { ...entities[1], items: [{ completed: false }] },
    { ...entities[2], items: [] },
    { ...entities[3], items: [{ completed: false }, { completed: false }] },
  ],
  activeListId: 4,
  labels: {
    personal: 'My lists',
    household: 'Household',
    shared: 'Shared with me',
    add: 'Add list',
  },
});
assert.equal((shoppingHtml.match(/data-entity-section="personal"/g) || []).length, 1);
assert.equal((shoppingHtml.match(/data-entity-section="household"/g) || []).length, 1);
assert.equal((shoppingHtml.match(/data-entity-section="shared"/g) || []).length, 1);
assert.match(shoppingHtml, /data-entity-id="4"[^>]*>[\s\S]*?class="badge">2</);
assert.match(shoppingHtml, /data-entity-id="4"/);
assert.match(shoppingHtml, /entity-sidebar-select active/);
assert.equal((shoppingHtml.match(/data-entity-sidebar-action="detail"/g) || []).length, 4, 'every visible list must expose the same detail entrypoint');
assert(shoppingHtml.indexOf('data-entity-section="personal"') < shoppingHtml.indexOf('data-entity-section="household"'));
assert(shoppingHtml.indexOf('data-entity-section="household"') < shoppingHtml.indexOf('data-entity-section="shared"'));

const emptyShoppingHtml = renderShoppingSidebar({
  lists: [],
  activeListId: null,
  labels: {
    personal: 'My lists',
    household: 'Household',
    shared: 'Shared with me',
    add: 'Add list',
  },
});
assert.match(emptyShoppingHtml, /data-entity-section="personal"/);
assert.doesNotMatch(emptyShoppingHtml, /data-entity-section="household"/);
assert.doesNotMatch(emptyShoppingHtml, /data-entity-section="shared"/);
assert.doesNotMatch(emptyShoppingHtml, /data-entity-sidebar-action="add"/, 'the add row belongs beside the list container just like in Tasks');

const shoppingModuleSource = readFileSync(new URL('web/static/js/modules/shopping.js', root), 'utf8');
assert(!shoppingModuleSource.includes('createEmptyModule'), 'shopping must mount its real module frame');
const { shoppingModule } = await import(new URL('web/static/js/modules/shopping.js', root));
const mountedSlots = Object.fromEntries(['sidebar', 'topbar', 'main', 'floating', 'userMenu', 'shortcuts', 'settingsNav', 'settings', 'desktopHotkeys'].map(name => [name, { innerHTML: '' }]));
shoppingModule.mount({ slots: mountedSlots });
assert.match(mountedSlots.sidebar.innerHTML, /id="shopping-list-sidebar"/);
assert.match(mountedSlots.sidebar.innerHTML, /data-i18n-key="shopping.sidebar.personal"/);
assert.match(mountedSlots.sidebar.innerHTML, /data-entity-sidebar-action="add"/);
assert.match(mountedSlots.main.innerHTML, /id="shopping-navigation-main"/);
assert.equal(mountedSlots.topbar.innerHTML, '');
assert.equal(mountedSlots.floating.innerHTML, '');

const sidebarTarget = { innerHTML: '' };
const mainTarget = { innerHTML: '', dataset: {} };
const featureCalls = [];
const featureStorage = new Map([['nia-shopping-active-list', '404']]);
const featureHistoryCalls = [];
const featureHistory = {
  state: null,
  replaceState(state, _title, url) { this.state = state; featureHistoryCalls.push(['replace', state.shoppingListId, url]); },
  pushState(state, _title, url) { this.state = state; featureHistoryCalls.push(['push', state.shoppingListId, url]); },
};
let featurePopState = null;
const featureWindow = {
  addEventListener(type, callback) { if (type === 'popstate') featurePopState = callback; },
  removeEventListener(type, callback) { if (type === 'popstate' && featurePopState === callback) featurePopState = null; },
};
const featureRoot = {
  addEventListener() {},
  removeEventListener() {},
};
const navigationFeature = createShoppingNavigationFeature({
  getLists: () => [
    { ...entities[0], id: 10, items: [] },
    { ...entities[1], id: 20, items: [] },
  ],
  root: featureRoot,
  getElementById: id => id === 'shopping-list-sidebar' ? sidebarTarget : id === 'shopping-navigation-main' ? mainTarget : null,
  storage: {
    getItem: key => featureStorage.get(key) ?? null,
    setItem: (key, value) => featureStorage.set(key, value),
    removeItem: key => featureStorage.delete(key),
  },
  historyTarget: featureHistory,
  locationTarget: { pathname: '/', search: '', hash: '' },
  eventTarget: featureWindow,
  closeSidebar: options => { featureCalls.push(['close', options]); return true; },
  onAdd: () => featureCalls.push(['add']),
  onDetail: id => featureCalls.push(['detail', id]),
});
navigationFeature.bind();
navigationFeature.render();
assert.equal(navigationFeature.getActiveListId(), 10, 'an inaccessible stored list must fall back to the first personal list');
assert.equal(featureStorage.get('nia-shopping-active-list'), '10');
assert.match(sidebarTarget.innerHTML, /data-entity-id="10"/);
assert.match(sidebarTarget.innerHTML, /entity-sidebar-select active/);
assert.equal(mainTarget.dataset.shoppingNavigationState, 'selected');
assert.deepEqual(featureHistoryCalls, [], 'background rendering must not mutate browser history');
navigationFeature.activate();
assert.deepEqual(featureHistoryCalls, [['replace', '10', '/?shoppingList=10']], 'module activation must normalize the initially visible list');
navigationFeature.selectList(20);
assert.equal(navigationFeature.getActiveListId(), 20);
assert.equal(featureStorage.get('nia-shopping-active-list'), '20');
assert.deepEqual(featureHistoryCalls.at(-1), ['push', '20', '/?shoppingList=20']);
featurePopState({ state: { niaShoppingList: true, shoppingListId: '10' } });
assert.equal(navigationFeature.getActiveListId(), 10, 'popstate must restore the initially visible shopping list');
navigationFeature.replaceLists([]);
assert.equal(navigationFeature.getActiveListId(), null);
assert.equal(featureStorage.has('nia-shopping-active-list'), false);
assert.equal(mainTarget.dataset.shoppingNavigationState, 'empty');

const appRenderingSource = readFileSync(new URL('web/static/js/features/app-rendering.js', root), 'utf8');
const appSource = readFileSync(new URL('web/static/js/app.js', root), 'utf8');
const shoppingNavigationSource = readFileSync(shoppingNavigationUrl, 'utf8');
const taskNavigationSource = readFileSync(new URL('web/static/js/features/navigation.js', root), 'utf8');
assert.match(appRenderingSource, /from ['"]\.\/entity-sidebar\.js['"]/, 'projects must use the neutral production renderer');
assert.match(appRenderingSource, /renderEntitySidebarRow\(/, 'project rows must call the neutral production renderer');
assert.match(shoppingNavigationSource, /from ['"]\.\/entity-sidebar\.js['"]/, 'shopping must use the same neutral production renderer');
assert.match(shoppingNavigationSource, /renderEntitySidebarRow\(/, 'shopping rows must call the neutral production renderer');
assert(!shoppingNavigationSource.includes('class="nav-item-with-action"'), 'shopping must not copy the shared row markup');
assert.match(taskNavigationSource, /bindEntitySidebarNavigation\(/, 'project navigation must use the neutral interaction controller');
assert.match(shoppingNavigationSource, /bindEntitySidebarNavigation\(/, 'shopping navigation must use the same neutral interaction controller');
assert.match(appSource, /createShoppingNavigationFeature/, 'the app must create the shopping navigation controller');
assert.match(appSource, /let shoppingLists = \[\]/, 'the app must own the live shopping-list projection');
assert.match(appSource, /setShoppingLists:/, 'cached and synchronized shopping lists must enter app state');
assert.match(appSource, /moduleShell\.registerController\('shopping'/, 'shopping navigation must participate in module activation');

const requiredKeys = [
  'common.household',
  'common.sharedWithMe',
  'common.openDetailsFor',
  'shopping.sidebar.personal',
  'shopping.sidebar.add',
  'shopping.sidebar.emptyTitle',
  'shopping.sidebar.emptyHint',
];
for (const locale of ['cs', 'de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'zh-CN']) {
  const dictionary = JSON.parse(readFileSync(new URL(`web/static/i18n/${locale}.json`, root), 'utf8'));
  for (const key of requiredKeys) {
    assert.equal(typeof dictionary[key], 'string', `${locale} must contain ${key}`);
    assert(dictionary[key].trim(), `${locale} ${key} must not be empty`);
  }
  assert.equal(dictionary['menu.household'], undefined, `${locale} must not keep a menu-specific household synonym`);
  assert.equal(dictionary['project.sharedProjects'], undefined, `${locale} must not keep a project-specific shared-group synonym`);
  assert.equal(dictionary['shopping.sidebar.household'], undefined, `${locale} must reuse the general household key`);
  assert.equal(dictionary['shopping.sidebar.shared'], undefined, `${locale} must reuse the general shared key`);
}

console.log('✅ Shared entity sidebar rendering, navigation, grouping, and i18n contracts passed');

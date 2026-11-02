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
assert.match(mountedSlots.topbar.innerHTML, /id="shopping-hide-empty-sections-btn"/, 'shopping must mount its shared topbar preference control');
assert.match(mountedSlots.floating.innerHTML, /data-shopping-item-action="open-create"/, 'shopping must mount its primary add-item action');

const sidebarTarget = { innerHTML: '' };
const mainTarget = { innerHTML: '', dataset: {}, className: '' };
const featureCalls = [];
const primaryActionStates = [];
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
  activeElement: null,
  remappedFocusId: null,
  addFocused: false,
  addEventListener() {},
  removeEventListener() {},
  querySelectorAll() {
    return [10, 77, 88].map(id => ({
      dataset: { entityId: String(id) },
      focus: () => { this.remappedFocusId = String(id); },
    }));
  },
  querySelector(selector) {
    if (selector !== '[data-entity-sidebar-action="add"][data-entity-type="shopping-list"]') return null;
    return { focus: () => { this.addFocused = true; } };
  },
};
const navigationFeature = createShoppingNavigationFeature({
  getLists: () => [
    { ...entities[0], id: 10, can_edit: true, items: [] },
    { ...entities[1], id: 20, can_edit: false, items: [] },
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
  onListIdRemap: (fromId, toId) => featureCalls.push(['remap', fromId, toId]),
  onPrimaryActionAvailabilityChange: available => primaryActionStates.push(available),
});
navigationFeature.bind();
navigationFeature.render();
assert.equal(navigationFeature.getActiveListId(), 10, 'an inaccessible stored list must fall back to the first personal list');
assert.equal(featureStorage.get('nia-shopping-active-list'), '10');
assert.match(sidebarTarget.innerHTML, /data-entity-id="10"/);
assert.match(sidebarTarget.innerHTML, /entity-sidebar-select active/);
assert.equal(mainTarget.dataset.shoppingNavigationState, 'selected');
assert.equal(mainTarget.dataset.shoppingContentState, 'empty');
assert.equal(mainTarget.className, 'module-page shopping-list-content-page');
assert.equal(primaryActionStates.at(-1), true, 'the add-item action is available for the active editable list');
assert.match(mainTarget.innerHTML, /class="shopping-list-content-header"/);
assert.match(mainTarget.innerHTML, /class="shopping-list-content-body"/);
assert.match(mainTarget.innerHTML, /class="empty-state shopping-list-empty-state"/);
assert.doesNotMatch(mainTarget.innerHTML, /class="section-header section-unsorted"/, 'a completely empty list must retain the accepted empty-state instead of a zero-count fallback section');
assert.doesNotMatch(mainTarget.innerHTML, /data-shopping-list-action=/, 'the content header must not introduce list actions');
assert.deepEqual(featureHistoryCalls, [], 'background rendering must not mutate browser history');
navigationFeature.activate();
assert.deepEqual(featureHistoryCalls, [['replace', '10', '/']], 'module activation must normalize the initially visible list while keeping the app base URL');
navigationFeature.selectList(20);
assert.equal(navigationFeature.getActiveListId(), 20);
assert.equal(primaryActionStates.at(-1), false, 'the add-item action is unavailable for a read-only list');
assert.equal(featureStorage.get('nia-shopping-active-list'), '20');
assert.deepEqual(featureHistoryCalls.at(-1), ['push', '20', '/'], 'list navigation must keep identity in history state without exposing it in the URL');
const deleteFallbackHistoryCount = featureHistoryCalls.length;
navigationFeature.replaceLists([{ ...entities[0], id: 10, items: [] }]);
assert.equal(navigationFeature.getActiveListId(), 10, 'deleting the active list must select the deterministic fallback');
navigationFeature.normalizeActiveListNavigation();
assert.deepEqual(featureHistoryCalls.at(-1), ['replace', '10', '/'], 'automatic delete fallback must replace the stale list state at the app base URL');
assert.deepEqual(featureHistoryCalls.slice(deleteFallbackHistoryCount), [['replace', '10', '/']], 'delete fallback must add exactly one replaceState and no pushState');
assert.equal(navigationFeature.focusActiveListAction(), true);
assert.equal(featureRoot.remappedFocusId, '10', 'fallback focus must target the live active-list detail action');
navigationFeature.replaceLists([
  { ...entities[0], id: 10, items: [] },
  { ...entities[1], id: 20, items: [] },
]);
navigationFeature.selectList(20);
const popStateHistoryCount = featureHistoryCalls.length;
featurePopState({ state: { niaShoppingList: true, shoppingListId: '10' } });
assert.equal(navigationFeature.getActiveListId(), 10, 'popstate must restore the initially visible shopping list');
assert.equal(featureHistoryCalls.length, popStateHistoryCount, 'popstate restoration must not create or replace history entries');
navigationFeature.replaceLists([{ ...entities[0], id: 'temp-shopping-list-1', items: [] }]);
navigationFeature.selectList('temp-shopping-list-1');
featureRoot.activeElement = {
  dataset: { entityType: 'shopping-list', entityId: 'temp-shopping-list-1' },
  matches: selector => selector === '[data-entity-sidebar-action="detail"][data-entity-type="shopping-list"]',
};
const remapHistoryCount = featureHistoryCalls.length;
navigationFeature.replaceLists([{ ...entities[0], id: 77, client_mutation_id: 'temp-shopping-list-1', items: [] }]);
assert.equal(navigationFeature.getActiveListId(), 77, 'temporary shopping-list selection must follow the server ID remap');
assert.equal(featureStorage.get('nia-shopping-active-list'), '77');
assert.deepEqual(featureHistoryCalls.at(-1), ['replace', '77', '/'], 'ID remapping must replace temporary history state without adding another entry or URL parameter');
assert.deepEqual(featureHistoryCalls.slice(remapHistoryCount), [['replace', '77', '/']], 'Temp-ID remapping must add exactly one replaceState and no pushState');
assert.deepEqual(featureCalls.at(-1), ['remap', 'temp-shopping-list-1', 77], 'ID remapping must notify an open details editor');
assert.equal(featureRoot.remappedFocusId, '77', 'ID remapping must restore focus to the live server-ID detail button');
navigationFeature.replaceLists([
  { ...entities[0], id: 77, items: [] },
  { ...entities[0], id: 'temp-shopping-list-older', name: 'Older', items: [] },
]);
featureRoot.activeElement = {
  dataset: { entityType: 'shopping-list', entityId: 'temp-shopping-list-older' },
  matches: selector => selector === '[data-entity-sidebar-action="detail"][data-entity-type="shopping-list"]',
};
featureRoot.remappedFocusId = null;
navigationFeature.replaceLists([
  { ...entities[0], id: 77, items: [] },
  { ...entities[0], id: 88, name: 'Older', client_mutation_id: 'temp-shopping-list-older', items: [] },
]);
assert.deepEqual(featureCalls.at(-1), ['remap', 'temp-shopping-list-older', 88], 'non-active Temp-ID remaps must also notify an open details editor');
assert.equal(featureRoot.remappedFocusId, '88', 'a focused non-active Temp-ID row must regain focus on its server-ID replacement');
navigationFeature.replaceLists([{ ...entities[0], id: 77, items: [{ id: 1, name: 'Milk', completed: false }] }]);
assert.equal(mainTarget.dataset.shoppingContentState, 'populated');
assert.match(mainTarget.innerHTML, /class="shopping-item-title">Milk</);
navigationFeature.replaceLists([]);
assert.equal(navigationFeature.getActiveListId(), null);
assert.equal(featureStorage.has('nia-shopping-active-list'), false);
assert.equal(mainTarget.dataset.shoppingNavigationState, 'empty');
assert.equal(mainTarget.dataset.shoppingContentState, 'no-list');
assert.equal(mainTarget.className, 'module-page module-empty-page');
assert.equal(primaryActionStates.at(-1), false, 'the add-item action is unavailable when no shopping list exists');
const finalDeleteHistoryCount = featureHistoryCalls.length;
navigationFeature.normalizeActiveListNavigation();
assert.deepEqual(featureHistoryCalls.at(-1), ['replace', null, '/'], 'deleting the final list must remove shoppingList from history and URL');
assert.deepEqual(featureHistoryCalls.slice(finalDeleteHistoryCount), [['replace', null, '/']], 'final-list deletion must add exactly one replaceState and no pushState');
assert.equal(navigationFeature.focusActiveListAction(), true);
assert.equal(featureRoot.addFocused, true, 'the empty state must focus the add-list action');

const deepLinkHistoryCalls = [];
const deepLinkHistory = {
  state: { niaModuleRoute: true, moduleId: 'shopping' },
  replaceState(state, _title, url) { this.state = state; deepLinkHistoryCalls.push(['replace', state, url]); },
  pushState(state, _title, url) { this.state = state; deepLinkHistoryCalls.push(['push', state, url]); },
};
const deepLinkFeature = createShoppingNavigationFeature({
  getLists: () => [
    { ...entities[0], id: 10, items: [] },
    { ...entities[1], id: 20, items: [] },
  ],
  root: featureRoot,
  getElementById: id => id === 'shopping-list-sidebar' ? { innerHTML: '' } : id === 'shopping-navigation-main' ? { innerHTML: '', dataset: {}, className: '' } : null,
  storage: { getItem: () => null, setItem() {}, removeItem() {} },
  historyTarget: deepLinkHistory,
  locationTarget: { pathname: '/shopping', search: '?share=abc&shoppingList=20', hash: '#fragment' },
  eventTarget: { addEventListener() {}, removeEventListener() {} },
});
deepLinkFeature.activate();
assert.equal(deepLinkFeature.getActiveListId(), 20, 'legacy shoppingList query must select the requested list before URL normalization');
assert.equal(deepLinkHistoryCalls.length, 1, 'legacy deep-link activation must normalize one existing history entry');
assert.equal(deepLinkHistoryCalls[0][0], 'replace');
assert.equal(deepLinkHistoryCalls[0][2], '/?share=abc', 'normalization must remove module path, shoppingList and hash while preserving unrelated query deep-links');
assert.deepEqual(
  deepLinkHistory.state,
  { niaModuleRoute: true, moduleId: 'shopping', niaShoppingList: true, shoppingListId: '20' },
  'normalization must retain module state and add shopping-list identity to the same history entry',
);

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
  'shopping.list.emptyTitle',
  'shopping.list.emptyHint',
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

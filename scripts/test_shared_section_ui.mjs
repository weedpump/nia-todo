#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.location = { origin: 'http://localhost' };
globalThis.document = {
  createElement() {
    return {
      _text: '',
      set textContent(value) {
        this._text = String(value ?? '');
        this.innerHTML = this._text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
      },
      get textContent() { return this._text; },
      innerHTML: '',
    };
  },
};
globalThis.CSS = { escape: value => String(value).replaceAll('"', '\\"') };
const {
  createSectionController,
  createSectionRootRegistry,
  renderSectionCollection,
  resolveSectionDragSourceAdapter,
  resolveSectionDropAdapter,
} = await import('../web/static/js/features/section-ui.js');
const { sectionDragSourceMatches } = await import('../web/static/js/features/drag-drop.js');

const sections = [
  { id: 'same-id', name: '<Produce>', sort_order: 0 },
  { id: 'empty-id', name: 'Empty', sort_order: 1 },
];
const items = [
  { id: 'a', section_id: 'same-id', name: '<Milk>' },
  { id: 'b', section_id: 'missing-id', name: 'Bread' },
  { id: 'c', section_id: null, name: 'Eggs' },
];
const html = renderSectionCollection({
  sections,
  items,
  canManage: true,
  unsortedLabel: 'Ohne Abschnitt',
  deleteLabel: 'Delete',
  newLabel: 'Add section',
  renderItem: item => `<div class="section-item-name">${item.name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div>`,
});
assert.match(html, /class="section-dropzone" data-drop-index="0"/);
assert.match(html, /class="section-header" data-section-id="same-id" draggable="true"/);
assert.match(html, /class="section-name" data-section-action="edit" data-section-id="same-id"/);
assert.match(html, /&lt;Produce&gt;/);
assert.match(html, /class="section-count">1</);
assert.match(html, /data-section-id="empty-id"[\s\S]*class="section-count">0</, 'empty sections remain visible');
assert.match(html, /class="section-header section-unsorted" data-section-id="null"[\s\S]*Ohne Abschnitt[\s\S]*class="section-count">2</, 'null, missing and unknown section IDs share the final unsorted group');
assert.match(html, /&lt;Milk&gt;/);
assert.match(html, /data-section-action="show-add"/);

const stableTieHtml = renderSectionCollection({
  sections: [
    { id: 'z-last-by-id', name: 'First from Tasks', sort_order: 0 },
    { id: 'a-first-by-id', name: 'Second from Tasks', sort_order: 0 },
  ],
  items: [],
  canManage: true,
  unsortedLabel: 'Ohne Abschnitt',
});
assert(stableTieHtml.indexOf('First from Tasks') < stableTieHtml.indexOf('Second from Tasks'), 'equal sort orders preserve the existing Tasks-visible section order');

const readonlyHtml = renderSectionCollection({
  sections,
  items,
  canManage: false,
  unsortedLabel: 'Ohne Abschnitt',
  deleteLabel: 'Delete',
  newLabel: 'Add section',
  renderItem: item => `<div>${item.name}</div>`,
});
assert.doesNotMatch(readonlyHtml, /data-section-action=/, 'read-only sections expose no mutation controls');
assert.doesNotMatch(readonlyHtml, /draggable="true"/, 'read-only sections cannot be reordered');
assert.doesNotMatch(readonlyHtml, /section-dropzone/, 'read-only sections expose no reorder targets');

function root(scope) {
  return {
    dataset: { sectionRoot: scope },
    closest(selector) { return selector === '[data-section-root]' ? this : null; },
  };
}
const tasksRoot = root('tasks');
const shoppingRoot = root('shopping');
const tasksAdapter = { name: 'tasks', canManage: () => true, resolveSectionId: id => `task:${id}` };
const shoppingAdapter = { name: 'shopping', canManage: () => true, resolveSectionId: id => `shop:${id}` };
const readonlyShoppingAdapter = { name: 'shopping-readonly', canManage: () => false, resolveSectionId: id => `readonly:${id}` };
const registry = createSectionRootRegistry();
registry.register(tasksRoot, tasksAdapter);
registry.register(shoppingRoot, shoppingAdapter);
assert.equal(registry.resolve(tasksRoot), tasksAdapter);
assert.equal(registry.resolve(shoppingRoot), shoppingAdapter);
assert.equal(registry.resolveSectionId(tasksRoot, 'same-id'), 'task:same-id');
assert.equal(registry.resolveSectionId(shoppingRoot, 'same-id'), 'shop:same-id');
assert.equal(resolveSectionDragSourceAdapter({ registry, taskAdapter: tasksAdapter, target: shoppingRoot }), shoppingAdapter);
registry.register(shoppingRoot, readonlyShoppingAdapter);
assert.equal(resolveSectionDragSourceAdapter({ registry, taskAdapter: tasksAdapter, target: shoppingRoot }), null, 'read-only roots cannot start desktop or long-press section DnD');
registry.register(shoppingRoot, shoppingAdapter);
assert.equal(resolveSectionDropAdapter({ registry, taskAdapter: tasksAdapter, sourceAdapter: tasksAdapter, target: tasksRoot }), tasksAdapter);
assert.equal(resolveSectionDropAdapter({ registry, taskAdapter: tasksAdapter, sourceAdapter: shoppingAdapter, target: shoppingRoot }), shoppingAdapter);
assert.equal(resolveSectionDropAdapter({ registry, taskAdapter: tasksAdapter, sourceAdapter: shoppingAdapter, target: tasksRoot }), null, 'section DnD must reject a target owned by another mounted root even when IDs collide');
assert.equal(sectionDragSourceMatches({ currentId: 'second', currentAdapter: shoppingAdapter, completedId: 'first', completedAdapter: shoppingAdapter }), false, 'a completed pointer drag cannot clear a newer drag from the same root');
assert.equal(sectionDragSourceMatches({ currentId: 'first', currentAdapter: shoppingAdapter, completedId: 'first', completedAdapter: shoppingAdapter }), true);
registry.unregister(tasksRoot);
assert.equal(registry.resolve(tasksRoot), null);

const controllerListeners = {};
const controllerEvents = {
  addEventListener(type, listener) { controllerListeners[type] = listener; },
};
let focusedControl = null;
const focusable = name => ({ name, focus() { focusedControl = this; } });
let liveControllerRoot = null;
let confirmOptions = null;
const controllerAdapter = {
  getRoot: () => liveControllerRoot,
  getSections: () => [{ id: 'opaque-controller', name: 'Before' }],
  canManage: () => true,
  resolveSectionId: id => id,
  render: () => {},
  createSection: async () => ({ id: 'created-controller' }),
  renameSection: async () => ({ id: 'opaque-controller', name: 'After' }),
  deleteSection: async () => ({ id: 'opaque-controller' }),
  labels: { deleteMessage: 'Shopping items move to Without section' },
};
const controllerRoot = root('controller');
registry.register(controllerRoot, controllerAdapter);
const controller = createSectionController({
  registry,
  root: controllerEvents,
  confirmDanger: async options => { confirmOptions = options; return false; },
  labels: { deleteTitle: 'Delete', deleteMessage: 'Confirm', deleteConfirm: 'Delete' },
});
controller.bind();
function actionTarget(action, sectionId) {
  return {
    dataset: { sectionAction: action, sectionId },
    closest(selector) {
      if (selector === '[data-section-action]') return this;
      if (selector === '[data-section-root]') return controllerRoot;
      return null;
    },
  };
}
async function clickController(action, sectionId) {
  await controllerListeners.click({
    target: actionTarget(action, sectionId),
    preventDefault() {},
    stopPropagation() {},
  });
  await Promise.resolve();
}

const createdFocus = focusable('created');
liveControllerRoot = { querySelector: selector => selector === '[data-section-input="new"]' ? { value: 'Created' } : null };
controllerAdapter.render = () => { liveControllerRoot = { querySelector: selector => selector.includes('created-controller') ? createdFocus : null }; };
await clickController('save-new');
assert.equal(focusedControl, createdFocus, 'create resolves focus against the live rerendered root');

const renamedFocus = focusable('renamed');
liveControllerRoot = { querySelector: selector => selector.includes('[data-section-input="edit"]') ? { value: 'Renamed' } : null };
controllerAdapter.render = () => { liveControllerRoot = { querySelector: selector => selector.includes('opaque-controller') ? renamedFocus : null }; };
await clickController('save-edit', 'opaque-controller');
assert.equal(focusedControl, renamedFocus, 'rename restores focus to the live section name');

const failedCreateFocus = focusable('failed-create');
liveControllerRoot = { querySelector: selector => selector === '[data-section-input="new"]' ? { value: 'Fails' } : null };
controllerAdapter.createSection = async () => { throw new Error('storage failed'); };
controllerAdapter.onError = () => {};
controllerAdapter.render = () => { liveControllerRoot = { querySelector: selector => selector === '[data-section-action="show-add"]' ? failedCreateFocus : null }; };
await clickController('save-new');
assert.equal(focusedControl, failedCreateFocus, 'storage failure restores focus to a live retry control');

const replacementDelete = focusable('replacement-delete');
liveControllerRoot = { querySelectorAll: () => [] };
await clickController('delete', 'opaque-controller');
assert.equal(confirmOptions.message, 'Shopping items move to Without section', 'domain adapters override only the delete copy that is not semantically shared');
liveControllerRoot = { querySelectorAll: () => [{ dataset: { sectionId: 'opaque-controller' }, ...replacementDelete }] };
assert.equal(confirmOptions.returnFocus().name, 'replacement-delete', 'delete confirmation resolves its return focus lazily after rerender');

controllerAdapter.createSection = async () => ({ id: 'created-controller' });
controllerAdapter.deleteSection = async () => ({ id: 'opaque-controller' });
const deleteFocus = focusable('delete-complete');
controllerAdapter.render = () => { liveControllerRoot = { querySelector: selector => selector === '[data-section-action="show-add"]' ? deleteFocus : null }; };
confirmOptions = null;
const confirmingController = createSectionController({
  registry,
  root: { addEventListener(type, listener) { controllerListeners[`confirm-${type}`] = listener; } },
  confirmDanger: async options => { confirmOptions = options; return true; },
});
confirmingController.bind();
await controllerListeners['confirm-click']({ target: actionTarget('delete', 'opaque-controller'), preventDefault() {}, stopPropagation() {} });
await Promise.resolve();
assert.equal(focusedControl, deleteFocus, 'delete completion restores focus inside the live section root');

const { createSectionActionsFeature } = await import('../web/static/js/features/section-actions.js');
let taskSections = [];
let taskRenderCount = 0;
let releaseTaskSync;
const taskSyncPending = new Promise(resolve => { releaseTaskSync = resolve; });
const taskActions = createSectionActionsFeature({
  getTodos: () => [],
  setTodos: () => {},
  getSections: () => taskSections,
  setSections: next => { taskSections = next; },
  getCurrentProjectId: () => 1,
  dbPut: async () => {},
  deleteFromDB: async () => {},
  addToSyncQueue: async () => {},
  isOnlineForSync: () => true,
  syncWithServer: () => taskSyncPending,
  renderTodos: () => { taskRenderCount += 1; },
  confirmDanger: async () => false,
  sectionsFeature: { renderSectionHeader: () => '' },
  sectionRegistry: createSectionRootRegistry(),
});
const pendingTaskCreate = taskActions.adapter.createSection('Immediate');
await Promise.resolve();
await Promise.resolve();
assert.equal(taskSections.length, 1, 'Tasks publish the durable local projection before online sync completes');
assert.equal(taskRenderCount, 1, 'Tasks rerender immediately while online sync is still pending');
releaseTaskSync();
await pendingTaskCreate;

const sectionActionsSource = readFileSync(new URL('../web/static/js/features/section-actions.js', import.meta.url), 'utf8');
const sectionsSource = readFileSync(new URL('../web/static/js/features/sections.js', import.meta.url), 'utf8');
const dragDropSource = readFileSync(new URL('../web/static/js/features/drag-drop.js', import.meta.url), 'utf8');
assert.match(dragDropSource, /classList\.toggle\('section-dragging', active\)/, 'shared DnD must expose section-drag state for enlarged drop targets');
assert.match(dragDropSource, /setSectionDragActive\(true\)/, 'section drag start must enlarge shared drop targets');
assert.match(dragDropSource, /setSectionDragActive\(false\)/, 'section drag cleanup must restore normal drop target spacing');
const shoppingNavigationSource = readFileSync(new URL('../web/static/js/features/shopping-navigation.js', import.meta.url), 'utf8');
const appRenderingSource = readFileSync(new URL('../web/static/js/features/app-rendering.js', import.meta.url), 'utf8');
const testAllSource = readFileSync(new URL('./test_all.sh', import.meta.url), 'utf8');
const addSectionLabels = {
  cs: 'Přidat sekci', de: 'Abschnitt hinzufügen', en: 'Add section', es: 'Añadir sección',
  fr: 'Ajouter une section', it: 'Aggiungi sezione', nl: 'Sectie toevoegen', pl: 'Dodaj sekcję',
  'pt-BR': 'Adicionar seção', ru: 'Добавить раздел', sv: 'Lägg till avsnitt', 'zh-CN': '添加分区',
};
for (const locale of Object.keys(addSectionLabels)) {
  const messages = JSON.parse(readFileSync(new URL(`../web/static/i18n/${locale}.json`, import.meta.url), 'utf8'));
  assert.equal(messages['section.new'], addSectionLabels[locale], `${locale} must use the action label for adding a section`);
  assert(messages['shopping.section.unsorted'], `${locale} must localize the final Shopping unsorted group`);
  assert(messages['shopping.section.deleteMessage'], `${locale} must localize the Shopping-specific delete consequence`);
}
assert.match(sectionActionsSource, /createSectionController/, 'Tasks CRUD must use the shared controller');
assert.match(sectionsSource, /renderSectionHeader/, 'Tasks headers must use the shared renderer');
assert.match(appRenderingSource, /renderSectionCollection/, 'Tasks and Shopping must use the same section collection renderer');
assert.doesNotMatch(dragDropSource, /parseInt\(section\.dataset\.sectionId/, 'section IDs are opaque in desktop and pointer DnD');
assert.match(shoppingNavigationSource, /renderSectionCollection/, 'Shopping must use the shared section renderer');
assert.doesNotMatch(shoppingNavigationSource, /shopping-section-/, 'Shopping must not introduce parallel section UI classes');
assert.match(testAllSource, /test_shared_section_ui\.mjs/, 'the shared section contract must run in the normal repository gate');
assert.match(testAllSource, /test_shopping_sections\.mjs/, 'the Shopping section adapter contract must run in the normal repository gate');

console.log('✅ Shared Tasks/Shopping section renderer and root registry contracts passed');

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);
const appSource = readFileSync(new URL('web/static/js/app.js', root), 'utf8');
assert.match(appSource, /shoppingListDetailsFeature\?\.reconcileListsChanged\?\.\(\)/, 'the production app must reconcile an open shopping-list editor after authoritative list replacement');
assert.match(appSource, /moduleShell\?\.getActiveModule\?\.\(\) === 'shopping'[\s\S]*normalizeActiveListNavigation\(\)[\s\S]*focusActiveListAction\(\)/, 'authoritative deletion in the active Shopping module must normalize navigation and focus');
const localeDictionaries = {};
const deleteKeys = [
  'shopping.list.delete.title',
  'shopping.list.delete.message',
  'shopping.list.delete.confirm',
  'shopping.list.error.deleteFailed',
];
for (const locale of ['cs', 'de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'zh-CN']) {
  const dictionary = JSON.parse(readFileSync(new URL(`web/static/i18n/${locale}.json`, root), 'utf8'));
  localeDictionaries[locale] = dictionary;
  for (const key of deleteKeys) {
    assert.equal(typeof dictionary[key], 'string', `${locale} must contain ${key}`);
    assert(dictionary[key].trim(), `${locale} ${key} must not be empty`);
  }
}

const fixtureSource = `
  import { SHOPPING_DIALOGS_HTML } from '/static/js/modules/shopping-dialogs.js';
  import { createConfirmDialogFeature } from '/static/js/features/confirm-dialog.js';
  import { createShoppingListDetailsFeature } from '/static/js/features/shopping-list-details.js';
  import { createUiShell } from '/static/js/features/ui-shell.js';
  import { createProjectsFeature } from '/static/js/features/projects.js';

  let lists = [
    { id: 101, name: 'Personal', color: '#2563eb', icon: 'shopping-cart', can_manage: true, can_edit: true, items: [], sections: [], preferences: {} },
    { id: 102, name: 'Household manager', color: '#16a34a', icon: 'house-heart', can_manage: true, can_edit: true, owner_household_id: 7, items: [], sections: [], preferences: {} },
    { id: 103, name: 'Household member', color: '#ca8a04', icon: 'users', can_manage: false, can_edit: true, owner_household_id: 7, items: [], sections: [], preferences: {} },
    { id: 104, name: 'Direct recipient', color: '#9333ea', icon: 'share-2', can_manage: false, can_edit: true, is_shared: true, items: [], sections: [], preferences: {} },
  ];
  let activeListId = 101;
  const mutations = [];
  let failNextMutation = false;
  let holdNextMutation = false;
  let mutationWaiting = false;
  let releaseHeldMutation = null;
  let normalizedNavigationCount = 0;
  let projectConfirmOptions = null;

  document.body.innerHTML = '<nav id="rows"></nav>' + SHOPPING_DIALOGS_HTML + \`
    <input id="project-id" value="501">
    <details id="project-detail-header-menu"><summary id="project-detail-header-menu-trigger">Project menu</summary></details>
    <div class="modal confirm-modal" id="confirm-modal">
      <div class="modal-overlay" id="confirm-modal-overlay"></div>
      <div class="modal-content confirm-modal-content">
        <div class="confirm-icon" aria-hidden="true" data-icon="trash-2"></div>
        <h3 id="confirm-title"></h3>
        <p id="confirm-message" class="confirm-message"></p>
        <div class="modal-actions confirm-actions">
          <button type="button" class="btn btn-secondary" id="confirm-cancel-btn">Cancel</button>
          <button type="button" class="btn btn-danger" id="confirm-confirm-btn">Delete</button>
        </div>
      </div>
    </div>
  \`;

  function renderRows() {
    document.getElementById('rows').innerHTML = [
      '<button type="button" data-entity-sidebar-action="add" data-entity-type="shopping-list">Add</button>',
      ...lists.map(list => '<button type="button" data-entity-sidebar-action="detail" data-entity-type="shopping-list" data-entity-id="' + list.id + '">' + list.name + '</button>'),
    ].join('');
  }

  function normalizeActiveList() {
    if (!lists.some(list => String(list.id) === String(activeListId))) activeListId = lists[0]?.id ?? null;
  }

  function setLists(next) {
    lists = next;
    normalizeActiveList();
    renderRows();
  }

  function applyAuthoritativeLists(next) {
    const previousActiveListId = activeListId;
    setLists(next);
    const detailsOwnTransition = feature.reconcileListsChanged();
    if (String(previousActiveListId ?? '') !== String(activeListId ?? '') && !detailsOwnTransition) {
      normalizeActiveListNavigation();
      focusActiveListAction();
    }
  }

  function focusActiveListAction() {
    const selector = activeListId == null
      ? '[data-entity-sidebar-action="add"][data-entity-type="shopping-list"]'
      : '[data-entity-sidebar-action="detail"][data-entity-type="shopping-list"][data-entity-id="' + activeListId + '"]';
    const target = document.querySelector(selector);
    target?.focus();
    return Boolean(target);
  }

  function normalizeActiveListNavigation() {
    normalizedNavigationCount += 1;
    const id = activeListId == null ? null : String(activeListId);
    const url = id == null ? '/' : '/?shoppingList=' + encodeURIComponent(id);
    history.replaceState({ niaShoppingList: true, shoppingListId: id }, '', url);
  }

  renderRows();
  const uiShell = createUiShell({ renderMarkdown: value => value, showTodoModal: () => {} });
  uiShell.bindKeyboardShortcuts();
  const confirmFeature = createConfirmDialogFeature();
  confirmFeature.bindConfirmDialog();
  const feature = createShoppingListDetailsFeature({
    getLists: () => lists,
    setLists,
    commitMutation: async buildMutation => {
      if (holdNextMutation) {
        holdNextMutation = false;
        mutationWaiting = true;
        await new Promise(resolve => { releaseHeldMutation = resolve; });
        mutationWaiting = false;
        releaseHeldMutation = null;
      }
      const mutation = typeof buildMutation === 'function' ? buildMutation() : buildMutation;
      if (!mutation) return null;
      if (failNextMutation) {
        failNextMutation = false;
        throw new Error('simulated delete IndexedDB failure');
      }
      mutations.push(structuredClone(mutation));
      return mutation;
    },
    confirmDanger: options => confirmFeature.confirmDanger(options),
    normalizeActiveListNavigation,
    focusActiveListAction,
    isOnlineForSync: () => false,
    syncWithServer: async () => { throw new Error('offline delete test must not sync'); },
    selectList: id => { activeListId = id; return true; },
    onError: error => { window.__errors.push(String(error?.stack || error)); },
  });
  window.__errors = [];
  feature.bind();
  const projectFeature = createProjectsFeature({
    getProjects: () => [{ id: 501, name: 'Project', is_owner: true }],
    getTodos: () => [],
    setTodos: () => {},
    getCurrentProjectId: () => 501,
    getCurrentWorkspaceId: () => 1,
    getWorkspaces: () => [],
    setProjects: () => {},
    dbPut: async () => {},
    addToSyncQueue: async () => {},
    deleteFromDB: async () => {},
    isOnlineForSync: () => false,
    syncWithServer: async () => {},
    renderProjects: () => {},
    renderStats: () => {},
    renderTodos: () => {},
    closeModal: () => {},
    confirmDanger: async options => { projectConfirmOptions = options; return false; },
    showToast: () => {},
    showBatchToast: () => {},
    projectsApi: {},
    getCurrentUser: () => ({ id: 1 }),
  });

  document.addEventListener('click', event => {
    const action = event.target.closest('[data-entity-sidebar-action]');
    if (action?.dataset.entitySidebarAction === 'add') {
      window.dispatchEvent(new CustomEvent('nia:shopping-list-add-request'));
    }
    if (action?.dataset.entitySidebarAction === 'detail') {
      activeListId = action.dataset.entityId;
      window.dispatchEvent(new CustomEvent('nia:shopping-list-detail-request', { detail: { id: action.dataset.entityId } }));
    }
    if (event.target.closest('[data-close-modal="shopping-list-modal"]')) feature.closeModal();
  });

  window.test = {
    getLists: () => structuredClone(lists),
    getMutations: () => structuredClone(mutations),
    getActiveListId: () => activeListId,
    getNormalizedNavigationCount: () => normalizedNavigationCount,
    projectDeleteReturnFocusId: async () => {
      projectConfirmOptions = null;
      projectFeature.deleteProjectFromModal();
      await new Promise(resolve => setTimeout(resolve, 0));
      return projectConfirmOptions?.returnFocus?.()?.id || null;
    },
    failNextMutation: () => { failNextMutation = true; },
    holdNextMutation: () => { holdNextMutation = true; },
    isMutationWaiting: () => mutationWaiting,
    releaseMutation: () => releaseHeldMutation?.(),
    revokeCurrentManagement: () => {
      const id = document.getElementById('shopping-list-id')?.value;
      lists = lists.map(list => String(list.id) === String(id) ? { ...list, can_manage: false } : list);
      renderRows();
    },
    addTemporaryList: () => {
      const temp = { id: 'temp-shopping-list-delete', name: 'Temporary delete', color: '#6366f1', icon: 'shopping-cart', can_manage: true, can_edit: true, items: [], sections: [], preferences: {}, client_mutation_id: 'temp-shopping-list-delete' };
      lists = [...lists, temp];
      activeListId = temp.id;
      renderRows();
      normalizeActiveListNavigation();
    },
    remapCurrentList: () => {
      const fromId = document.getElementById('shopping-list-id')?.value;
      lists = lists.map(list => String(list.id) === String(fromId) ? { ...list, id: 700, client_mutation_id: fromId } : list);
      activeListId = 700;
      renderRows();
      feature.remapListId(fromId, 700);
    },
    removeCurrentListExternally: () => {
      const id = document.getElementById('shopping-list-id')?.value;
      applyAuthoritativeLists(lists.filter(list => String(list.id) !== String(id)));
    },
    removeCurrentListExternallyAndSubmit: () => {
      const id = document.getElementById('shopping-list-id')?.value;
      applyAuthoritativeLists(lists.filter(list => String(list.id) !== String(id)));
      document.getElementById('shopping-list-form')?.requestSubmit();
    },
    keepOnlyManagedList: () => {
      lists = [{ id: 999, name: 'Final managed list', color: '#6366f1', icon: 'shopping-cart', can_manage: true, can_edit: true, items: [], sections: [], preferences: {} }];
      activeListId = 999;
      renderRows();
      normalizeActiveListNavigation();
    },
  };
`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error?.stack || error)));

try {
  await page.route('http://nia.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><head><link rel="stylesheet" href="/static/style.css"></head><body><script type="module" src="/fixture.js"></script></body></html>',
      });
      return;
    }
    if (url.pathname === '/fixture.js') {
      await route.fulfill({ contentType: 'text/javascript', body: fixtureSource });
      return;
    }
    if (url.pathname.startsWith('/static/')) {
      try {
        const body = readFileSync(new URL(`../web${url.pathname}`, import.meta.url), 'utf8');
        await route.fulfill({
          contentType: url.pathname.endsWith('.json') ? 'application/json' : (url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript'),
          body,
        });
      } catch {
        await route.fulfill({ status: 404, contentType: 'text/plain', body: `Missing fixture asset: ${url.pathname}` });
      }
      return;
    }
    await route.fulfill({ status: 404, contentType: 'text/plain', body: `Unexpected fixture request: ${url.pathname}` });
  });

  await page.goto('http://nia.test/?shoppingList=101');
  await page.waitForFunction(() => Boolean(window.test));
  assert.equal(await page.evaluate(() => window.test.projectDeleteReturnFocusId()), 'project-detail-header-menu-trigger', 'project deletion must use the shared live return-focus resolver');

  const modal = page.locator('#shopping-list-modal');
  const menu = page.locator('#shopping-list-detail-header-menu');
  const menuTrigger = page.locator('#shopping-list-detail-header-menu-trigger');
  const deleteAction = page.locator('[data-shopping-list-action="delete-from-modal"]');
  const confirmModal = page.locator('#confirm-modal');
  const confirmButton = page.locator('#confirm-confirm-btn');
  const cancelButton = page.locator('#confirm-cancel-btn');

  await page.getByRole('button', { name: 'Add' }).click();
  assert.equal(await menu.isHidden(), true, 'create mode must not expose delete actions');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('shopping-list-modal')?.classList.contains('active'));

  for (const name of ['Household member', 'Direct recipient']) {
    await page.getByRole('button', { name }).click();
    assert.equal(await menu.isHidden(), true, `${name} must not receive list deletion controls`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('shopping-list-modal')?.classList.contains('active'));
  }

  await page.getByRole('button', { name: 'Personal' }).click();
  assert.equal(await menu.isVisible(), true, 'personal managers must receive the overflow menu');
  await menuTrigger.click();
  await deleteAction.click();
  await confirmModal.waitFor({ state: 'visible' });
  assert.equal(await modal.getAttribute('aria-hidden'), 'false');
  await cancelButton.click();
  await page.waitForFunction(() => !document.getElementById('confirm-modal')?.classList.contains('active'));
  assert.equal(await modal.isVisible(), true, 'cancel must keep list details open');
  await page.waitForFunction(() => document.activeElement?.id === 'shopping-list-detail-header-menu-trigger');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'shopping-list-detail-header-menu-trigger', 'cancel must restore focus to the overflow trigger');

  await menuTrigger.click();
  await deleteAction.click();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('confirm-modal')?.classList.contains('active'));
  assert.equal(await modal.isVisible(), true, 'Escape must close only the topmost confirmation layer');
  await page.waitForFunction(() => document.activeElement?.id === 'shopping-list-detail-header-menu-trigger');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'shopping-list-detail-header-menu-trigger');

  await menuTrigger.click();
  await deleteAction.click();
  await page.goBack();
  await page.waitForFunction(() => !document.getElementById('confirm-modal')?.classList.contains('active'));
  assert.equal(await modal.isVisible(), true, 'Back must close only the confirmation layer');
  await page.waitForFunction(() => document.activeElement?.id === 'shopping-list-detail-header-menu-trigger');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'shopping-list-detail-header-menu-trigger', 'Back must restore focus to the overflow trigger');

  await page.evaluate(() => window.test.failNextMutation());
  await menuTrigger.click();
  await deleteAction.click();
  await confirmButton.click();
  await page.waitForFunction(() => document.getElementById('shopping-list-error')?.textContent?.length > 0);
  assert.equal(await modal.isVisible(), true, 'failed local deletion must keep details open');
  assert.equal((await page.evaluate(() => window.test.getLists())).some(list => list.id === 101), true, 'failed local deletion must keep the list projection');
  assert.equal((await page.evaluate(() => window.test.getMutations())).length, 0);
  await page.waitForFunction(() => document.activeElement?.id === 'shopping-list-detail-header-menu-trigger');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'shopping-list-detail-header-menu-trigger', 'failed deletion must return focus inside the still-open detail dialog');

  await menuTrigger.click();
  await deleteAction.click();
  await confirmButton.dblclick();
  await page.waitForFunction(() => !document.getElementById('shopping-list-modal')?.classList.contains('active'));
  const deleted = await page.evaluate(() => ({
    lists: window.test.getLists(),
    mutations: window.test.getMutations(),
    active: window.test.getActiveListId(),
    focusId: document.activeElement?.dataset.entityId,
  }));
  assert.equal(deleted.lists.some(list => list.id === 101), false);
  assert.deepEqual(deleted.mutations, [{ deleteListId: 101, action: 'DELETE_SHOPPING_LIST', data: { id: 101 } }]);
  assert.equal(String(deleted.active), '102');
  assert.equal(deleted.focusId, '102', 'successful delete must focus the fallback list detail action');
  assert.equal(await page.evaluate(() => location.search), '?shoppingList=102', 'successful delete must replace the stale list URL');
  assert.deepEqual(await page.evaluate(() => history.state), { niaShoppingList: true, shoppingListId: '102' });

  await page.getByRole('button', { name: 'Household manager' }).click();
  await page.evaluate(() => window.test.holdNextMutation());
  await menuTrigger.click();
  await deleteAction.click();
  await confirmButton.click();
  await page.waitForFunction(() => window.test.isMutationWaiting());
  await page.evaluate(() => window.test.revokeCurrentManagement());
  await page.evaluate(() => window.test.releaseMutation());
  await page.waitForFunction(() => !window.test.isMutationWaiting());
  assert.equal((await page.evaluate(() => window.test.getMutations())).length, 1, 'permission loss must not enqueue deletion');
  assert.equal(await modal.isVisible(), true);
  assert.equal(await page.locator('#shopping-list-name').isDisabled(), true, 'permission loss must transition details to read-only');
  assert.equal(await menu.isHidden(), true, 'permission loss must remove delete controls');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('shopping-list-modal')?.classList.contains('active'));

  await page.evaluate(() => window.test.addTemporaryList());
  await page.getByRole('button', { name: 'Temporary delete' }).click();
  await menuTrigger.click();
  await deleteAction.click();
  await page.evaluate(() => window.test.remapCurrentList());
  await confirmButton.click();
  await page.waitForFunction(() => !document.getElementById('shopping-list-modal')?.classList.contains('active'));
  const remappedDelete = (await page.evaluate(() => window.test.getMutations())).at(-1);
  assert.deepEqual(remappedDelete, { deleteListId: 700, action: 'DELETE_SHOPPING_LIST', data: { id: 700 } }, 'confirmation must delete the current server ID after remap');

  await page.evaluate(() => window.test.addTemporaryList());
  await page.getByRole('button', { name: 'Temporary delete' }).click();
  await page.fill('#shopping-list-name', 'Stale local edit');
  const mutationCountBeforeRealtimeDelete = (await page.evaluate(() => window.test.getMutations())).length;
  await page.evaluate(() => window.test.removeCurrentListExternallyAndSubmit());
  await page.waitForFunction(() => !document.getElementById('shopping-list-modal')?.classList.contains('active'));
  const realtimeDeleteState = await page.evaluate(() => ({
    mutationCount: window.test.getMutations().length,
    activeListId: window.test.getActiveListId(),
    search: location.search,
    historyListId: history.state?.shoppingListId,
    focusedEntityId: document.activeElement?.dataset.entityId || null,
  }));
  assert.equal(realtimeDeleteState.mutationCount, mutationCountBeforeRealtimeDelete, 'realtime deletion must not turn a stale edit into CREATE');
  assert.equal(String(realtimeDeleteState.historyListId), String(realtimeDeleteState.activeListId));
  assert.equal(realtimeDeleteState.search, `?shoppingList=${realtimeDeleteState.activeListId}`);
  assert.equal(String(realtimeDeleteState.focusedEntityId), String(realtimeDeleteState.activeListId), 'realtime deletion must focus the live fallback list');

  for (const dismissal of ['cancel', 'escape', 'back']) {
    await page.evaluate(() => window.test.addTemporaryList());
    await page.getByRole('button', { name: 'Temporary delete' }).click();
    await menuTrigger.click();
    await deleteAction.click();
    const mutationCountBeforeDismissedExternalDelete = (await page.evaluate(() => window.test.getMutations())).length;
    await page.evaluate(() => window.test.removeCurrentListExternally());
    if (dismissal === 'cancel') await cancelButton.click();
    else if (dismissal === 'escape') await page.keyboard.press('Escape');
    else await page.goBack();
    await page.waitForFunction(() => !document.getElementById('shopping-list-modal')?.classList.contains('active'));
    assert.equal(
      (await page.evaluate(() => window.test.getMutations())).length,
      mutationCountBeforeDismissedExternalDelete,
      `external removal followed by ${dismissal} must not enqueue another mutation`,
    );
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'shopping-list-save-btn', `external removal followed by ${dismissal} must not leave the stale editor operable`);
    const dismissedState = await page.evaluate(() => ({
      activeListId: window.test.getActiveListId(),
      search: location.search,
      historyListId: history.state?.shoppingListId,
      focusedEntityId: document.activeElement?.dataset.entityId || null,
    }));
    assert.equal(String(dismissedState.historyListId), String(dismissedState.activeListId), `${dismissal}: history must target the fallback list`);
    assert.equal(dismissedState.search, `?shoppingList=${dismissedState.activeListId}`, `${dismissal}: URL must target the fallback list`);
    assert.equal(String(dismissedState.focusedEntityId), String(dismissedState.activeListId), `${dismissal}: focus must target the fallback list`);
  }

  await page.evaluate(() => window.test.addTemporaryList());
  await page.getByRole('button', { name: 'Temporary delete' }).click();
  await menuTrigger.click();
  await deleteAction.click();
  const mutationCountBeforeExternalDelete = (await page.evaluate(() => window.test.getMutations())).length;
  await page.evaluate(() => window.test.removeCurrentListExternally());
  await confirmButton.click();
  await page.waitForFunction(() => !document.getElementById('shopping-list-modal')?.classList.contains('active'));
  assert.equal((await page.evaluate(() => window.test.getMutations())).length, mutationCountBeforeExternalDelete, 'external removal during confirmation must not enqueue another delete');

  await page.evaluate(() => window.test.keepOnlyManagedList());
  await page.getByRole('button', { name: 'Final managed list' }).click();
  await menuTrigger.click();
  await deleteAction.click();
  await confirmButton.click();
  await page.waitForFunction(() => !document.getElementById('shopping-list-modal')?.classList.contains('active'));
  assert.equal(await page.evaluate(() => location.search), '', 'deleting the final list must remove shoppingList from the URL');
  assert.deepEqual(await page.evaluate(() => history.state), { niaShoppingList: true, shoppingListId: null });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.entitySidebarAction), 'add', 'deleting the final list must focus Add');

  await page.evaluate(() => window.test.addTemporaryList());
  await page.setViewportSize({ width: 390, height: 844 });
  const managerName = (await page.evaluate(() => window.test.getLists())).find(list => list.can_manage)?.name;
  await page.getByRole('button', { name: managerName }).click();
  await page.evaluate(() => {
    const save = document.getElementById('shopping-list-save-btn');
    save.hidden = false;
    save.style.display = '';
  });
  for (const [locale, dictionary] of Object.entries(localeDictionaries)) {
    const headerGeometry = await page.evaluate(({ locale, title }) => {
      const header = document.querySelector('#shopping-list-modal .ui-detail-modal-header');
      const titleElement = header.querySelector('h3');
      titleElement.textContent = title;
      const titleRect = titleElement.getBoundingClientRect();
      const textRange = document.createRange();
      textRange.selectNodeContents(titleElement);
      const textRect = textRange.getBoundingClientRect();
      const actionsRect = header.querySelector('.ui-detail-header-actions')?.getBoundingClientRect();
      return {
        locale,
        titleRight: titleRect.right,
        textRight: textRect.right,
        actionsLeft: actionsRect?.left ?? 0,
        titleOverflow: getComputedStyle(titleElement).overflowX,
      };
    }, { locale, title: dictionary['shopping.list.modal.editTitle'] });
    assert(headerGeometry.titleRight <= headerGeometry.actionsLeft, `${locale}: mobile title and Save/Menu/Close actions must not overlap`);
    assert(
      headerGeometry.textRight <= headerGeometry.actionsLeft || headerGeometry.titleOverflow === 'hidden',
      `${locale}: overflowing localized title text must be clipped before the header actions`,
    );
  }

  assert.deepEqual(pageErrors, []);
  console.log('✅ Shopping deletion roles, confirmation, races, history, focus, and offline commit passed');
} finally {
  await browser.close();
}

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);
const fixtureSource = `
  import { SHOPPING_DIALOGS_HTML } from '/static/js/modules/shopping-dialogs.js';
  import { TASK_DIALOGS_HTML } from '/static/js/modules/tasks-dialogs.js';
  import { createShoppingListDetailsFeature } from '/static/js/features/shopping-list-details.js';
  import { createUiShell } from '/static/js/features/ui-shell.js';

  let lists = [
    { id: 101, name: 'Personal', color: '#2563eb', icon: 'shopping-cart', can_manage: true, can_edit: true, items: [], sections: [], preferences: {} },
    { id: 102, name: 'Household manager', color: '#16a34a', icon: 'house-heart', can_manage: true, can_edit: true, owner_household_id: 7, items: [], sections: [], preferences: {} },
    { id: 103, name: 'Household member', color: '#ca8a04', icon: 'users', can_manage: false, can_edit: true, owner_household_id: 7, items: [], sections: [], preferences: {} },
    { id: 104, name: 'Direct recipient', color: '#9333ea', icon: 'share-2', can_manage: false, can_edit: true, is_shared: true, items: [], sections: [], preferences: {} },
  ];
  const mutations = [];
  const selections = [];
  let failNextMutation = false;
  let holdNextMutation = false;
  let mutationWaiting = false;
  let releaseHeldMutation = null;

  document.body.innerHTML = '<nav id="rows"></nav>' + TASK_DIALOGS_HTML + SHOPPING_DIALOGS_HTML;

  function renderRows() {
    document.getElementById('rows').innerHTML = [
      '<button type="button" data-entity-sidebar-action="add" data-entity-type="shopping-list">Add</button>',
      ...lists.map(list => '<button type="button" data-entity-sidebar-action="detail" data-entity-type="shopping-list" data-entity-id="' + list.id + '">' + list.name + '</button>'),
    ].join('');
  }

  renderRows();
  const uiShell = createUiShell({ renderMarkdown: value => value, showTodoModal: () => {} });
  uiShell.bindKeyboardShortcuts();
  const feature = createShoppingListDetailsFeature({
    getLists: () => lists,
    setLists: next => { lists = next; renderRows(); },
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
        throw new Error('simulated IndexedDB failure');
      }
      mutations.push(structuredClone(mutation));
      return mutation;
    },
    isOnlineForSync: () => false,
    syncWithServer: async () => { throw new Error('offline test must not sync'); },
    selectList: id => {
      selections.push({ id, modalOpen: document.getElementById('shopping-list-modal')?.classList.contains('active') });
      return true;
    },
    onError: error => { window.__errors.push(String(error?.stack || error)); },
  });
  window.__errors = [];
  feature.bind();

  document.addEventListener('click', event => {
    const action = event.target.closest('[data-entity-sidebar-action]');
    if (action?.dataset.entitySidebarAction === 'add') {
      window.dispatchEvent(new CustomEvent('nia:shopping-list-add-request'));
    }
    if (action?.dataset.entitySidebarAction === 'detail') {
      window.dispatchEvent(new CustomEvent('nia:shopping-list-detail-request', { detail: { id: action.dataset.entityId } }));
    }
    if (event.target.closest('[data-close-modal="shopping-list-modal"]')) feature.closeModal();
  });

  window.test = {
    feature,
    closeProjectModal: () => uiShell.closeModal('project-modal', { fromHistory: true }),
    getLists: () => structuredClone(lists),
    getMutations: () => structuredClone(mutations),
    getSelections: () => structuredClone(selections),
    failNextMutation: () => { failNextMutation = true; },
    holdNextMutation: () => { holdNextMutation = true; },
    isMutationWaiting: () => mutationWaiting,
    releaseMutation: () => releaseHeldMutation?.(),
    remapLatestList: () => {
      const current = lists.at(-1);
      const remapped = { ...current, id: 700, client_mutation_id: current.id };
      lists = [...lists.slice(0, -1), remapped];
      renderRows();
      feature.remapListId(current.id, remapped.id);
    },
    revokeLatestListManagement: () => {
      const current = lists.at(-1);
      lists = [...lists.slice(0, -1), { ...current, can_manage: false }];
      renderRows();
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
      const fileUrl = new URL(`../web${url.pathname}`, import.meta.url);
      try {
        const body = readFileSync(fileUrl, 'utf8');
        const contentType = url.pathname.endsWith('.json')
          ? 'application/json'
          : (url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
        await route.fulfill({ contentType, body });
      } catch {
        await route.fulfill({ status: 404, contentType: 'text/plain', body: `Missing fixture asset: ${url.pathname}` });
      }
      return;
    }
    await route.fulfill({ status: 404, contentType: 'text/plain', body: `Unexpected fixture request: ${url.pathname}` });
  });

  await page.goto('http://nia.test/');
  await page.waitForFunction(() => Boolean(window.test));

  const modal = page.locator('#shopping-list-modal');
  const save = page.locator('#shopping-list-save-btn');
  const name = page.locator('#shopping-list-name');
  const color = page.locator('#shopping-list-color');
  const icon = page.locator('#shopping-list-icon');

  const desktopParity = await page.evaluate(() => {
    const project = document.getElementById('project-modal');
    const shopping = document.getElementById('shopping-list-modal');
    project.classList.add('active');
    shopping.classList.add('active');
    const metrics = prefix => {
      const modal = document.getElementById(prefix === 'project' ? 'project-modal' : 'shopping-list-modal');
      const content = modal.querySelector('.ui-detail-modal-content');
      const header = modal.querySelector('.ui-detail-modal-header');
      const title = document.getElementById(prefix + '-name');
      const grid = modal.querySelector('.entity-appearance-grid');
      const pick = element => {
        const style = getComputedStyle(element);
        return {
          display: style.display,
          width: style.width,
          maxWidth: style.maxWidth,
          borderRadius: style.borderRadius,
          padding: style.padding,
          fontSize: style.fontSize,
          gridTemplateColumns: style.gridTemplateColumns,
          gap: style.gap,
        };
      };
      return { content: pick(content), header: pick(header), title: pick(title), grid: pick(grid) };
    };
    const result = { project: metrics('project'), shopping: metrics('shopping-list') };
    project.classList.remove('active');
    shopping.classList.remove('active');
    return result;
  });
  assert.deepEqual(desktopParity.shopping, desktopParity.project, 'project and shopping appearance surfaces must share identical desktop computed styles');

  await page.evaluate(() => {
    const project = document.getElementById('project-modal');
    project.classList.add('active');
    project.setAttribute('aria-hidden', 'false');
    window.test.closeProjectModal();
  });
  assert.equal(await page.locator('#project-modal').getAttribute('aria-hidden'), 'true', 'the shared modal close path must restore project aria-hidden state');

  await page.getByRole('button', { name: 'Household member' }).click();
  await modal.waitFor({ state: 'visible' });
  assert.equal(await modal.getAttribute('aria-hidden'), 'false');
  assert.equal(await name.isDisabled(), true, 'household members must see metadata read-only');
  assert.equal(await color.isDisabled(), true, 'read-only state must disable the color input');
  assert.equal(await page.locator('#shopping-list-icon-picker .icon-picker-current').isDisabled(), true, 'read-only state must disable the icon picker');
  assert.equal(await save.isHidden(), true, 'read-only metadata must not expose Save');
  await page.waitForFunction(() => document.activeElement?.classList?.contains('modal-close-x'));
  await page.goBack();
  await page.waitForFunction(() => !document.getElementById('shopping-list-modal')?.classList.contains('active'));
  assert.equal(await modal.getAttribute('aria-hidden'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.entityId), '103', 'history close must restore focus to the current detail button');

  await page.getByRole('button', { name: 'Direct recipient' }).click();
  assert.equal(await name.isDisabled(), true, 'direct recipients with item edit rights must not manage metadata');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('shopping-list-modal')?.classList.contains('active'));

  await page.getByRole('button', { name: 'Household manager' }).click();
  assert.equal(await name.isEnabled(), true, 'household managers must edit metadata');
  assert.equal(await save.isHidden(), true, 'unchanged metadata must hide Save');
  await name.fill('Household weekend');
  assert.equal(await save.isVisible(), true, 'dirty valid metadata must show Save');
  await page.locator('#shopping-list-icon-picker .icon-picker-current').click();
  await page.locator('#shopping-list-icon-picker .icon-picker-option[data-value=""]').click();
  assert.equal(await icon.inputValue(), '', 'the shared picker must support removing the optional icon');
  await save.click();
  await page.waitForFunction(() => !document.getElementById('shopping-list-modal')?.classList.contains('active'));
  assert.deepEqual((await page.evaluate(() => window.test.getMutations()))[0], {
    list: {
      id: 102,
      name: 'Household weekend',
      color: '#16a34a',
      icon: null,
      can_manage: true,
      can_edit: true,
      owner_household_id: 7,
      items: [],
      sections: [],
      preferences: {},
      updated_at: (await page.evaluate(() => window.test.getMutations()))[0].list.updated_at,
      is_pending: true,
    },
    action: 'UPDATE_SHOPPING_LIST',
    data: { id: 102, changes: { name: 'Household weekend', color: '#16a34a', icon: null } },
  });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.entityId), '102', 'save must restore focus after the sidebar row rerenders');

  await page.getByRole('button', { name: 'Add' }).click();
  await name.fill('Must not persist');
  await page.evaluate(() => window.test.failNextMutation());
  await save.click();
  await page.waitForFunction(() => document.getElementById('shopping-list-error')?.textContent?.length > 0);
  assert.equal(await modal.getAttribute('aria-hidden'), 'false', 'a failed durable write must keep the editor open');
  assert.equal(await save.isEnabled(), true, 'a failed durable write must make Save retryable');
  assert.equal((await page.evaluate(() => window.test.getLists())).length, 4, 'a failed durable write must not publish an optimistic list');
  await page.goBack();
  await page.waitForFunction(() => !document.getElementById('shopping-list-modal')?.classList.contains('active'));

  await page.getByRole('button', { name: 'Add' }).click();
  assert.equal(await icon.inputValue(), 'shopping-cart', 'new lists must start with shopping-cart');
  assert.equal(await save.isHidden(), true, 'an empty create form must not be savable');
  await name.fill('Offline list');
  await page.locator('#shopping-list-icon-picker .icon-picker-current').click();
  await page.locator('#shopping-list-icon-picker .icon-picker-option[data-value=""]').click();
  await save.click();
  await page.waitForFunction(() => !document.getElementById('shopping-list-modal')?.classList.contains('active'));

  const state = await page.evaluate(() => ({
    mutations: window.test.getMutations(),
    lists: window.test.getLists(),
    selections: window.test.getSelections(),
    errors: window.__errors,
  }));
  assert.equal(state.mutations.length, 2);
  assert.equal(state.mutations[1].action, 'CREATE_SHOPPING_LIST');
  assert.match(state.mutations[1].data.temp_id, /^temp-shopping-list-/);
  assert.equal(state.mutations[1].data.icon, null, 'explicitly removing the default icon must persist null');
  assert.equal(state.lists.at(-1).name, 'Offline list');
  assert.equal(state.lists.at(-1).icon, null);
  assert.equal(state.lists.at(-1).is_pending, true);
  assert.deepEqual(state.selections.at(-1), { id: state.lists.at(-1).id, modalOpen: false }, 'new-list selection must run only after the modal history layer closes');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.entityId), state.lists.at(-1).id, 'create must focus the live detail button after list selection rerenders the sidebar');
  assert.equal(state.errors.length, 1);
  assert.match(state.errors[0], /simulated IndexedDB failure/);
  assert.deepEqual(pageErrors, []);

  await page.getByRole('button', { name: 'Offline list' }).click();
  await page.evaluate(() => window.test.holdNextMutation());
  await name.fill('Synced list');
  await save.click();
  await page.waitForFunction(() => window.test.isMutationWaiting());
  await page.evaluate(() => window.test.remapLatestList());
  assert.equal(await page.locator('#shopping-list-id').inputValue(), '700', 'an open editor must follow the Temp-ID to server-ID remap');
  await page.evaluate(() => window.test.releaseMutation());
  await page.waitForFunction(() => !document.getElementById('shopping-list-modal')?.classList.contains('active'));
  const remappedState = await page.evaluate(() => ({
    mutations: window.test.getMutations(),
    lists: window.test.getLists(),
  }));
  assert.equal(remappedState.mutations.length, 3, 'editing a remapped list must add exactly one mutation');
  assert.equal(remappedState.mutations.at(-1).action, 'UPDATE_SHOPPING_LIST', 'an open remapped editor must update instead of creating a duplicate');
  assert.equal(remappedState.mutations.at(-1).data.id, 700);
  assert.equal(remappedState.lists.length, 5, 'Temp-ID remapping must not duplicate the list projection');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.entityId), '700', 'remapped editor close must restore focus to the server-ID detail button');

  await page.getByRole('button', { name: 'Synced list' }).click();
  await page.evaluate(() => window.test.holdNextMutation());
  await name.fill('Must stay unchanged');
  await save.click();
  await page.waitForFunction(() => window.test.isMutationWaiting());
  await page.evaluate(() => window.test.revokeLatestListManagement());
  await page.evaluate(() => window.test.releaseMutation());
  await page.waitForFunction(() => !window.test.isMutationWaiting());
  assert.equal(await modal.getAttribute('aria-hidden'), 'false', 'permission loss must keep the details surface available read-only');
  assert.equal(await name.isDisabled(), true, 'permission loss during save must immediately disable metadata fields');
  assert.equal(await save.isHidden(), true, 'permission loss during save must clear the stale dirty action');
  assert.equal((await page.evaluate(() => window.test.getMutations())).length, 3, 'permission loss during save must not enqueue a mutation');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('modal-close-x')), true, 'permission loss must focus the first operable dialog control');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('shopping-list-modal')?.classList.contains('active'));

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileParity = await page.evaluate(() => {
    const project = document.getElementById('project-modal');
    const shopping = document.getElementById('shopping-list-modal');
    project.classList.add('active');
    shopping.classList.add('active');
    const measure = modal => {
      const content = modal.querySelector('.ui-detail-modal-content');
      const grid = modal.querySelector('.entity-appearance-grid');
      const contentStyle = getComputedStyle(content);
      const gridStyle = getComputedStyle(grid);
      return {
        width: contentStyle.width,
        maxWidth: contentStyle.maxWidth,
        height: contentStyle.height,
        borderRadius: contentStyle.borderRadius,
        gridTemplateColumns: gridStyle.gridTemplateColumns,
        gridGap: gridStyle.gap,
      };
    };
    const result = { project: measure(project), shopping: measure(shopping) };
    project.classList.remove('active');
    shopping.classList.remove('active');
    return result;
  });
  assert.deepEqual(mobileParity.shopping, mobileParity.project, 'project and shopping appearance surfaces must share identical mobile computed styles');
  await page.getByRole('button', { name: 'Personal' }).click();
  assert.equal(await modal.isVisible(), true, 'details must open at the mobile viewport');
  assert.equal(await name.isEnabled(), true, 'personal list metadata stays editable on mobile');
  await page.goBack();
  await page.waitForFunction(() => !document.getElementById('shopping-list-modal')?.classList.contains('active'));

  console.log('✅ Shopping appearance browser roles, history, dirty state, and offline mutations passed');
} finally {
  await browser.close();
}

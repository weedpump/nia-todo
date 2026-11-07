#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withFreshDb, launchPage, waitForPageCondition } from './frontend_test_lib.mjs';

// Real app, HTTP API, IndexedDB and WebSocket connections throughout. Run only
// through the suite's isolated service/database environment, serially.
const suffix = `${process.pid}-${Date.now()}`;
const names = {
  list: `Shopping E2E ${suffix}`,
  section: `Chilled E2E ${suffix}`,
  store: `Market E2E ${suffix}`,
  onlineItem: `Milk E2E ${suffix}`,
  offlineItem: `Apples E2E ${suffix}`,
};
const screenshotDirectory = process.env.NIA_TODO_TEST_OUTPUT_DIR;

async function waitUntil(check, description, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function pollBrowser(page, predicate, argument, description, timeout = 20_000) {
  try {
    return await waitForPageCondition(page, predicate, argument, { timeout });
  } catch (error) {
    error.message = `${description}: ${error.message}`;
    throw error;
  }
}

function assertCanonicalId(entity, label) {
  assert.ok(Number.isSafeInteger(entity?.id) && entity.id > 0,
    `${label} must have a positive canonical server ID: ${JSON.stringify(entity)}`);
}

function observeRealtime(page) {
  const messages = [];
  page.on('websocket', socket => {
    socket.on('framereceived', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload));
        messages.push({ type: message.type, id: message.payload?.id });
      } catch { /* Ignore non-JSON transport frames. */ }
    });
  });
  return messages;
}

async function switchModule(page, moduleId) {
  await page.locator('#module-switcher-button').click();
  await page.locator(`[data-module-action="select"][data-module-id="${moduleId}"]`).click();
  await pollBrowser(page, id => document.getElementById('app')?.dataset.activeModule === id, moduleId, `${moduleId} module activation`);
}

async function waitForList(page) {
  const list = await pollBrowser(page, async name => {
    if (typeof window.dbGetAll !== 'function') return false;
    return (await window.dbGetAll('shoppingLists')).find(list => list.name === name && typeof list.id === 'number');
  }, names.list, 'canonical Shopping list in IndexedDB');
  assertCanonicalId(list, 'Shopping list');
  return list;
}

async function waitForItem(page, name, { canonical = true } = {}) {
  const item = await pollBrowser(page, async ({ listName, name, canonical }) => {
    if (typeof window.dbGetAll !== 'function') return false;
    const list = (await window.dbGetAll('shoppingLists')).find(list => list.name === listName);
    return (list?.items || []).find(item => item.name === name && (!canonical || typeof item.id === 'number'));
  }, { listName: names.list, name, canonical }, `${canonical ? 'canonical' : 'local'} item ${name} in IndexedDB`);
  if (canonical) assertCanonicalId(item, 'Shopping item');
  else assert.ok(item?.id != null, 'the local Shopping item must have an ID');
  return item;
}

async function waitForShoppingQueue(page, empty) {
  await pollBrowser(page, async empty => {
    if (typeof window.dbGetAll !== 'function') return false;
    const pending = (await window.dbGetAll('syncQueue')).filter(item => String(item.action).includes('SHOPPING'));
    return empty ? pending.length === 0 : pending.length > 0;
  }, empty, `${empty ? 'empty' : 'nonempty'} durable Shopping queue`);
}

async function serverList(page, id) {
  return page.evaluate(async id => {
    const { http } = await import('/static/js/api/http.js');
    return http.get(`/api/shopping/lists/${encodeURIComponent(id)}`);
  }, id);
}

async function createItem(page, name, { sectionId, storeId, quantity = '2', unit = 'l' }) {
  await page.locator('[data-shopping-item-action="open-create"]').click();
  await page.locator('#shopping-item-modal').waitFor({ state: 'visible' });
  await page.locator('#shopping-item-name').fill(name);
  await page.locator('#shopping-item-quantity').fill(quantity);
  await page.locator('#shopping-item-unit').fill(unit);
  // Use the actual form's native selects; the custom dropdown delegates to
  // these same change events. Its keyboard/pointer behavior has focused tests.
  await page.locator('#shopping-item-section').selectOption(String(sectionId), { force: true });
  await page.locator('#shopping-item-store').selectOption(String(storeId), { force: true });
  await assertNoOverflow(page, 'Shopping item editor');
  await page.locator('#shopping-item-save-btn').click();
  await page.locator('#shopping-item-modal').waitFor({ state: 'hidden' });
  await page.locator('.shopping-item-card').filter({ hasText: name }).waitFor({ state: 'visible' });
}

async function assertNoOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(dimensions.document <= dimensions.viewport + 1 && dimensions.body <= dimensions.viewport + 1,
    `${label} must not overflow horizontally: ${JSON.stringify(dimensions)}`);
}

async function screenshot(page, name) {
  if (!screenshotDirectory) return;
  const directory = resolve(screenshotDirectory);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `shopping-e2e-${name}.png`), fullPage: true });
}

async function run() {
  console.log('🛒 Running real-service Shopping UI, realtime and offline end-to-end test...');
  const clientA = await launchPage();
  let clientB;
  let framesB = [];
  const framesA = observeRealtime(clientA.page);
  const pageA = clientA.page;
  let offlineErrorStart = -1;
  let offlineErrorEnd = -1;
  try {
    clientB = await launchPage();
    const pageB = clientB.page;
    framesB = observeRealtime(pageB);
    await clientA.loginApp();
    await clientB.loginApp();
    for (const [label, page, frames] of [['A', pageA, framesA], ['B', pageB, framesB]]) {
      await waitUntil(() => frames.some(message => message.type === 'auth_ok') && frames.some(message => message.type === 'sync_response'), `${label} real WebSocket authentication and access snapshot`);
      assert.equal(await page.evaluate(() => navigator.onLine), true, `${label} browser must report online before the real-service Shopping flow`);
      await switchModule(page, 'shopping');
    }

    await pageA.locator('[data-entity-sidebar-action="add"][data-entity-type="shopping-list"]').click();
    await pageA.locator('#shopping-list-modal').waitFor({ state: 'visible' });
    await pageA.locator('#shopping-list-name').fill(names.list);
    await pageA.locator('#shopping-list-save-btn').click();
    await pageA.locator('#shopping-list-modal').waitFor({ state: 'hidden' });
    const list = await waitForList(pageA);
    const remoteList = await waitForList(pageB);
    assert.equal(remoteList.id, list.id, 'both browsers must observe the same canonical list ID');
    for (const page of [pageA, pageB]) {
      await page.locator('#shopping-list-sidebar .entity-sidebar-select').filter({ hasText: names.list }).click();
      await page.locator('#shopping-navigation-main h1').filter({ hasText: names.list }).waitFor({ state: 'visible' });
    }

    await pageA.locator('#shopping-navigation-main [data-section-action="show-add"]').click();
    await pageA.locator('#shopping-new-section-name').fill(names.section);
    await pageA.locator('#shopping-new-section-name').press('Enter');
    const section = await pollBrowser(pageA, async ({ id, name }) => {
      const list = (await window.dbGetAll('shoppingLists')).find(list => list.id === id);
      return list?.sections?.find(section => section.name === name && typeof section.id === 'number');
    }, { id: list.id, name: names.section }, 'canonical Shopping section');
    assertCanonicalId(section, 'Shopping section');
    await pageB.locator('#shopping-navigation-main .section-header').filter({ hasText: names.section }).waitFor({ state: 'visible', timeout: 20_000 });

    await pageA.locator('[data-select-id="shopping-store-filter"] .ui-select-trigger').click();
    await pageA.locator('#shopping-store-filter-ui-menu .ui-select-action').click();
    await pageA.locator('#shopping-filter-store-new-store-name').fill(names.store);
    await pageA.locator('#shopping-filter-store-new-store-name').press('Enter');
    const store = await pollBrowser(pageA, async ({ id, name }) => (await window.dbGetAll('shoppingStores'))
      .find(store => store.shopping_list_id === id && store.name === name && typeof store.id === 'number'),
    { id: list.id, name: names.store }, 'canonical Shopping store');
    assertCanonicalId(store, 'Shopping store');
    await pollBrowser(pageB, async id => (await window.dbGetAll('shoppingStores')).some(store => store.id === id), store.id, 'store realtime projection in browser B');
    await waitForShoppingQueue(pageA, true);

    const target = { sectionId: section.id, storeId: store.id };
    await createItem(pageA, names.onlineItem, target);
    const onlineItem = await waitForItem(pageA, names.onlineItem);
    const remoteItem = await waitForItem(pageB, names.onlineItem);
    await pageB.locator('.shopping-item-card').filter({ hasText: names.onlineItem }).waitFor({ state: 'visible' });
    assert.equal(remoteItem.id, onlineItem.id, 'the second browser must observe the actual canonical item');
    assert.equal(remoteItem.section_id, section.id);
    assert.deepEqual(remoteItem.store_ids, [store.id]);
    assert.equal(remoteItem.quantity_value, 2);
    assert.equal(remoteItem.quantity_unit, 'l');
    assert.ok(framesB.some(message => message.type === 'shopping_item_create' && message.id === onlineItem.id), 'the second browser must receive the real item-create WebSocket frame');
    await waitForShoppingQueue(pageA, true);
    await assertNoOverflow(pageA, 'desktop Shopping');
    await screenshot(pageA, 'desktop');

    // Completion is also a real browser-to-browser mutation, including the
    // shared completed-visibility control used by Tasks and Shopping.
    await pageB.locator('#shopping-completed-visibility-btn').click();
    await pageA.locator('.shopping-item-card').filter({ hasText: names.onlineItem }).locator('.shopping-item-check').click();
    await pollBrowser(pageB, async ({ listName, name }) => {
      const list = (await window.dbGetAll('shoppingLists')).find(list => list.name === listName);
      return list?.items?.find(item => item.name === name)?.completed === true;
    }, { listName: names.list, name: names.onlineItem }, 'item completion realtime projection in browser B');
    await pageB.locator('.shopping-item-card.is-completed').filter({ hasText: names.onlineItem }).waitFor({ state: 'visible' });
    await waitForShoppingQueue(pageA, true);

    await pageA.setViewportSize({ width: 390, height: 844 });
    offlineErrorStart = clientA.consoleErrors.length;
    await pageA.context().setOffline(true);
    await pollBrowser(pageA, () => navigator.onLine === false, undefined, 'browser offline state');
    await createItem(pageA, names.offlineItem, { ...target, quantity: '3', unit: 'kg' });
    await waitForShoppingQueue(pageA, false);
    const localItem = await waitForItem(pageA, names.offlineItem, { canonical: false });
    const queuedCreate = await pageA.evaluate(async name => (await window.dbGetAll('syncQueue'))
      .find(entry => entry.action === 'CREATE_SHOPPING_ITEM' && entry.data?.item?.name === name), names.offlineItem);
    assert.ok(queuedCreate, 'offline item creation must commit a durable IndexedDB queue entry');
    assert.equal(queuedCreate.data.temp_id, localItem.id);
    assert.equal(queuedCreate.data.client_mutation_id, localItem.client_mutation_id);
    assert.equal(queuedCreate.data.shopping_list_id, list.id);
    assert.equal(queuedCreate.data.item.section_id, section.id);
    assert.deepEqual(queuedCreate.data.item.store_ids, [store.id]);
    const beforeReconnect = await serverList(pageB, list.id);
    assert.equal(beforeReconnect.items.filter(item => item.name === names.offlineItem).length, 0, 'offline writes must not already exist on the real server');

    await assertNoOverflow(pageA, 'mobile Shopping with pending item');
    await screenshot(pageA, 'mobile-offline');
    await pageA.context().setOffline(false);
    await pollBrowser(pageA, () => navigator.onLine === true, undefined, 'browser online state');
    await waitForShoppingQueue(pageA, true);
    const synchronized = await waitForItem(pageA, names.offlineItem);
    await waitForItem(pageB, names.offlineItem);
    assert.equal(synchronized.client_mutation_id, localItem.client_mutation_id, 'reconnect must retain mutation identity across temporary-ID remapping');
    const savedList = await serverList(pageB, list.id);
    const serverMatches = savedList.items.filter(item => item.name === names.offlineItem);
    assert.equal(serverMatches.length, 1, 'reconnect must create exactly one server item');
    assert.equal(serverMatches[0].id, synchronized.id);
    assert.equal(serverMatches[0].quantity_value, 3);
    assert.equal(serverMatches[0].quantity_unit, 'kg');
    offlineErrorEnd = clientA.consoleErrors.length;

    // Reload online after the offline commit/reconnect. The deterministic core
    // test blocks service workers; offline navigation is covered separately.
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await pageA.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 15_000 });
    await pollBrowser(pageA, () => document.getElementById('app')?.dataset.activeModule === 'shopping', undefined, 'Shopping module after reload');
    await waitForItem(pageA, names.offlineItem);
    await pageA.locator('.shopping-item-card').filter({ hasText: names.offlineItem }).waitFor({ state: 'visible' });
    await assertNoOverflow(pageA, 'mobile Shopping after reload');
    await screenshot(pageA, 'mobile-synchronized');
    await pageA.setViewportSize({ width: 1440, height: 1000 });
    await switchModule(pageA, 'tasks');
    await pageA.locator('#todo-list').waitFor({ state: 'visible' });
    await switchModule(pageA, 'shopping');
    await pageA.locator('.shopping-item-card').filter({ hasText: names.offlineItem }).waitFor({ state: 'visible' });

    for (const client of [clientA, clientB]) {
      const errors = client.dumpErrors();
      const unexpected = errors.consoleErrors.filter((message, index) => {
        const duringForcedOffline = client === clientA && index >= offlineErrorStart && index < offlineErrorEnd;
        const transportFailure = /net::ERR_INTERNET_DISCONNECTED|WebSocket connection .* failed|\[WS\].*Error: Event|^WS: message handler failed TypeError: Failed to fetch/.test(message);
        return !(duringForcedOffline && transportFailure);
      });
      assert.deepEqual(errors.pageErrors, [], 'the real app must not throw browser exceptions');
      assert.deepEqual(unexpected, [], 'only expected transport errors during forced offline mode are permitted');
    }
    console.log('✅ Real-service Shopping module, list/section/store/item creation, realtime and offline reconnect passed');
  } catch (error) {
    console.error('Shopping E2E client A errors:', JSON.stringify(clientA.dumpErrors()));
    if (clientB) console.error('Shopping E2E client B errors:', JSON.stringify(clientB.dumpErrors()));
    for (const [label, client] of [['A', clientA], ['B', clientB]]) {
      if (!client) continue;
      const diagnostic = await client.page.evaluate(async () => ({
        online: navigator.onLine,
        module: document.getElementById('app')?.dataset.activeModule,
        sidebar: document.getElementById('shopping-list-sidebar')?.outerHTML,
        heading: document.querySelector('#shopping-navigation-main h1')?.textContent,
        lists: typeof window.dbGetAll !== 'function' ? null : (await window.dbGetAll('shoppingLists')).map(list => ({
          id: list.id, idType: typeof list.id, name: list.name, clientMutationId: list.client_mutation_id,
          sectionIds: (list.sections || []).map(section => section.id), itemIds: (list.items || []).map(item => item.id),
        })),
        queue: typeof window.dbGetAll !== 'function' ? null : (await window.dbGetAll('syncQueue')).map(entry => ({
          id: entry.id, action: entry.action, listId: entry.data?.shopping_list_id,
          temporaryId: entry.data?.temp_id, mutationId: entry.data?.client_mutation_id,
        })),
      })).catch(diagnosticError => `State unavailable: ${diagnosticError.message}`);
      console.error(`Shopping E2E ${label} state:`, JSON.stringify(diagnostic));
      await screenshot(client.page, `failure-${label}`).catch(() => {});
    }
    console.error('Shopping E2E real WebSocket frames A:', JSON.stringify(framesA));
    console.error('Shopping E2E real WebSocket frames B:', JSON.stringify(framesB));
    await screenshot(pageA, 'failure').catch(() => {});
    throw error;
  } finally {
    await pageA.context().setOffline(false).catch(() => {});
    await clientB?.browser.close();
    await clientA.browser.close();
  }
}

await withFreshDb(run);

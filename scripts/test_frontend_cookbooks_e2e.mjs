#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withFreshDb, launchPage, waitForPageCondition } from './frontend_test_lib.mjs';

// Real HTTP, IndexedDB and WebSocket traffic. Serial isolated service only.
const name = `Cookbook ${process.pid}-${Date.now()}`;
const offlineName = `${name} offline`;
const poll = (page, predicate, arg) => waitForPageCondition(page, predicate, arg, { timeout: 25_000 });
async function activate(page, id = 'recipes') {
  await page.click('#module-switcher-button');
  await page.click(`[data-module-action="select"][data-module-id="${id}"]`);
  await poll(page, id => document.getElementById('app')?.dataset.activeModule === id, id);
}
async function book(page, name, canonical = true) {
  return poll(page, async ({ name, canonical }) => typeof window.dbGetAll === 'function'
    && (await window.dbGetAll('cookbooks')).find(book => book.name === name && (!canonical || typeof book.id === 'number')),
  { name, canonical });
}
async function queueEmpty(page) {
  await poll(page, async () => typeof window.dbGetAll === 'function'
    && !(await window.dbGetAll('syncQueue')).some(entry => /_COOKBOOK$/.test(entry.action)));
}
async function sidebar(page) {
  if (page.viewportSize().width <= 768 && !(await page.locator('#sidebar').evaluate(node => node.classList.contains('open')))) await page.click('#sidebar-toggle-btn');
}
async function open(page, id) {
  await sidebar(page);
  await page.locator(`#cookbook-sidebar [data-entity-sidebar-action="detail"][data-entity-id="${id}"]`).click();
  await page.locator('#cookbook-modal').waitFor({ state: 'visible' });
}
async function save(page, newName, description) {
  await page.fill('#cookbook-name', newName);
  await page.fill('#cookbook-description', description);
  await page.click('#cookbook-save-btn');
  await page.locator('#cookbook-modal').waitFor({ state: 'hidden' });
}
async function noOverflow(page) {
  assert.equal(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
    <= document.documentElement.clientWidth + 1), true, 'desktop and mobile must not overflow horizontally');
}
async function screenshot(page, label) {
  if (!process.env.NIA_TODO_TEST_OUTPUT_DIR) return;
  await mkdir(process.env.NIA_TODO_TEST_OUTPUT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(process.env.NIA_TODO_TEST_OUTPUT_DIR, `cookbooks-${label}.png`), fullPage: true });
}
async function run() {
  const clients = [];
  let offlineStart = 0, offlineEnd = 0;
  try {
    for (let index = 0; index < 2; index++) {
      const client = await launchPage(); clients.push(client);
      await client.loginApp(); await activate(client.page); await queueEmpty(client.page);
    }
    const [a, b] = clients.map(client => client.page);
    await sidebar(a);
    await a.locator('[data-entity-sidebar-action="add"][data-entity-type="cookbook"]').first().click();
    await save(a, name, 'Family & recipes\nPlain text description');
    const first = await book(a, name), remote = await book(b, name);
    assert.equal(first.id, remote.id, 'second browser receives the canonical cookbook through real sync');
    assert.equal(first.description, 'Family & recipes\nPlain text description');
    await queueEmpty(a);
    await open(a, first.id);
    await a.fill('#cookbook-description', 'Updated through the shared editor');
    await a.click('#cookbook-save-btn');
    await a.locator('#cookbook-modal').waitFor({ state: 'hidden' });
    await poll(b, async id => (await window.dbGetAll('cookbooks')).find(book => book.id === id)?.description === 'Updated through the shared editor', first.id);
    await noOverflow(a); await screenshot(a, 'desktop');

    // Create and edit without a network, then reconcile exactly one server
    // entity and active temporary selection; verify a real reload afterward.
    await a.setViewportSize({ width: 390, height: 844 });
    offlineStart = clients[0].consoleErrors.length;
    await a.context().setOffline(true);
    await poll(a, () => navigator.onLine === false);
    await sidebar(a);
    await a.locator('[data-entity-sidebar-action="add"][data-entity-type="cookbook"]').first().click();
    await save(a, offlineName, 'Offline draft');
    const local = await book(a, offlineName, false);
    assert.equal(typeof local.id, 'string');
    await open(a, local.id);
    await save(a, offlineName, 'Durable offline update');
    const queued = await a.evaluate(async () => (await window.dbGetAll('syncQueue')).filter(entry => entry.action === 'CREATE_COOKBOOK'));
    assert.equal(queued.length, 1);
    assert.equal(queued[0].data.client_mutation_id, local.client_mutation_id);
    assert.equal(queued[0].data.description, 'Durable offline update');
    await noOverflow(a); await screenshot(a, 'mobile-offline');
    await a.context().setOffline(false);
    await queueEmpty(a);
    const synchronized = await book(a, offlineName), remoteOffline = await book(b, offlineName);
    assert.equal(synchronized.id, remoteOffline.id);
    assert.equal(synchronized.client_mutation_id, local.client_mutation_id);
    assert.equal(synchronized.description, 'Durable offline update');
    assert.equal(await a.evaluate(() => localStorage.getItem('nia-recipes-active-cookbook')), String(synchronized.id));
    offlineEnd = clients[0].consoleErrors.length;
    const server = await b.evaluate(async () => (await (await import('/static/js/api/recipes.js')).recipesApi.snapshot()).cookbooks);
    assert.equal(server.filter(book => book.client_mutation_id === local.client_mutation_id).length, 1);
    await a.reload({ waitUntil: 'domcontentloaded' });
    await a.locator('#login-overlay').waitFor({ state: 'hidden' });
    await book(a, offlineName);
    await poll(a, () => document.getElementById('app')?.dataset.activeModule === 'recipes');
    await noOverflow(a); await screenshot(a, 'mobile-synchronized');
    await a.setViewportSize({ width: 1440, height: 1000 });
    await activate(a, 'tasks'); await a.locator('#todo-list').waitFor({ state: 'visible' });
    await activate(a, 'shopping'); await a.locator('#shopping-navigation-main').waitFor({ state: 'visible' });
    await activate(a);
    await open(a, synchronized.id);
    await a.click('#cookbook-detail-header-menu-trigger'); await a.click('#cookbook-delete-btn');
    await a.click('#confirm-confirm-btn'); await a.locator('#cookbook-modal').waitFor({ state: 'hidden' });
    await queueEmpty(a);
    await poll(b, async id => !(await window.dbGetAll('cookbooks')).some(book => book.id === id), synchronized.id);
    for (const [index, client] of clients.entries()) {
      const errors = client.dumpErrors();
      assert.deepEqual(errors.pageErrors, []);
      assert.deepEqual(errors.consoleErrors.filter((message, position) => !(index === 0 && position >= offlineStart && position < offlineEnd
        && /net::ERR_INTERNET_DISCONNECTED|WebSocket connection .* failed|\[WS\].*Error: Event|^WS: message handler failed TypeError: Failed to fetch/.test(message))), []);
    }
    console.log('✅ Cookbooks real-service CRUD, two-browser realtime, mobile offline reconnect, CMID, reload and module switching passed');
  } catch (error) {
    for (const [index, client] of clients.entries()) {
      console.error(`Cookbook client ${index}:`, JSON.stringify(client.dumpErrors()));
      console.error(await client.page.evaluate(async () => ({
        heading: document.querySelector('#cookbook-navigation-main')?.innerText,
        books: typeof window.dbGetAll === 'function' ? await window.dbGetAll('cookbooks') : null,
        queue: typeof window.dbGetAll === 'function' ? await window.dbGetAll('syncQueue') : null,
      })).catch(() => null));
      await screenshot(client.page, `failure-${index}`).catch(() => {});
    }
    throw error;
  } finally {
    for (const client of clients) { await client.page.context().setOffline(false).catch(() => {}); await client.browser.close(); }
  }
}
await withFreshDb(run);

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withFreshDb, launchPage, waitForPageCondition } from './frontend_test_lib.mjs';

// Real app, API, private-image delivery, IndexedDB and WebSocket traffic.
// Run serially against the coordinator's isolated service/database only.
const suffix = `${process.pid}-${Date.now()}`;
const bookName = `Recipes ${suffix}`, recipeName = `Pasta ${suffix}`;
const stepText = 'Pasta kochen.\nEtwas Nudelwasser aufheben.';
const poll = (page, predicate, value) => waitForPageCondition(page, predicate, value, { timeout: 30_000 });
async function activate(page, moduleId = 'recipes') {
  await sidebar(page);
  await page.click('#module-switcher-button');
  await page.click(`[data-module-action="select"][data-module-id="${moduleId}"]`);
  await poll(page, id => document.getElementById('app')?.dataset.activeModule === id, moduleId);
}
async function sidebar(page) {
  if (page.viewportSize().width <= 768 && !await page.locator('#sidebar').evaluate(node => node.classList.contains('open'))) await page.click('#sidebar-toggle-btn');
}
async function makeBook(page, name) {
  await sidebar(page);
  await page.locator('[data-entity-sidebar-action="add"][data-entity-type="cookbook"]').first().click();
  await page.fill('#cookbook-name', name); await page.click('#cookbook-save-btn');
  await page.locator('#cookbook-modal').waitFor({ state: 'hidden' });
}
async function recipe(page, title, canonical = true) {
  return poll(page, async ({ title, canonical }) => typeof window.dbGetAll === 'function'
    && (await window.dbGetAll('cookbooks')).flatMap(book => book.recipes || []).find(recipe => recipe.title === title && (!canonical || typeof recipe.id === 'number')),
  { title, canonical });
}
async function queueEmpty(page) {
  await poll(page, async () => !(await window.dbGetAll('syncQueue')).some(row => /_(RECIPE|COOKBOOK)$/.test(row.action)));
}
async function create(page) {
  await page.locator('#module-floating-slot [data-recipe-action="create"]').click();
  await page.locator('#recipe-modal').waitFor({ state: 'visible' });
}
async function save(page) {
  await page.click('#recipe-save-btn');
  await page.locator('#recipe-modal').waitFor({ state: 'hidden' });
}
async function open(page, id) {
  await page.locator(`.recipe-list-row[data-recipe-id="${id}"]`).click();
  await page.locator('.recipe-reading').waitFor({ state: 'visible' });
}
async function edit(page) {
  await page.locator('.recipe-reading [data-recipe-action="edit"]').click();
  await page.locator('#recipe-modal').waitFor({ state: 'visible' });
}
async function noOverflow(page, label) {
  assert.equal(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= document.documentElement.clientWidth + 1), true, `${label} must not overflow`);
}
async function screenshot(page, name) {
  if (!process.env.NIA_TODO_TEST_OUTPUT_DIR) return;
  await mkdir(process.env.NIA_TODO_TEST_OUTPUT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(process.env.NIA_TODO_TEST_OUTPUT_DIR, `recipes-${name}.png`), fullPage: true });
}
async function addIngredient(page, groupIndex, fields) {
  const group = page.locator('.recipe-editor-group').nth(groupIndex);
  await group.locator('[data-recipe-editor-action="ingredient-add"]').click();
  const item = group.locator('.recipe-editor-ingredient').last();
  for (const [key, value] of Object.entries(fields)) await item.locator(`[data-field="${key}"]`).fill(String(value));
}
async function run() {
  const clients = []; const expectedErrorRanges = []; let expectedErrorStart = -1, expectedErrorEnd = -1;
  try {
    for (let i = 0; i < 2; i++) { const client = await launchPage(); clients.push(client); await client.loginApp(); await activate(client.page); }
    const [a, b] = clients.map(client => client.page);
    await makeBook(a, bookName); await queueEmpty(a);
    const book = await poll(b, async name => (await window.dbGetAll('cookbooks')).find(book => book.name === name), bookName);
    await b.locator(`#cookbook-sidebar [data-entity-sidebar-action="select"][data-entity-id="${book.id}"]`).click();
    await create(a);
    await a.fill('#recipe-name', recipeName); await a.fill('#recipe-description', 'A shared family recipe');
    await a.fill('#recipe-base-servings', '2'); await a.fill('#recipe-prep-minutes', '10'); await a.fill('#recipe-cook-minutes', '15');
    await a.click('[data-recipe-editor-action="tag-add"]'); await a.locator('#recipe-editor-tags input').last().fill('Vegetarisch');
    await a.click('[data-recipe-editor-action="tag-add"]'); await a.locator('#recipe-editor-tags input').last().fill('Schnell');
    await a.click('[data-recipe-editor-action="group-add"]'); await a.locator('[data-field="group-name"]').last().fill('Pasta');
    await addIngredient(a, 0, { name: 'Pasta', quantity_value: '200', quantity_unit: 'Gramm' });
    await a.click('[data-recipe-editor-action="group-add"]'); await a.locator('[data-field="group-name"]').last().fill('Sauce');
    await addIngredient(a, 1, { name: 'Tomatensauce', quantity_value: '2', quantity_unit: 'Liter', note: 'Frische Tomaten verwenden' });
    await addIngredient(a, 1, { name: 'Basilikum', quantity_text: 'nach Geschmack' });
    await a.click('[data-recipe-editor-action="step-add"]'); await a.locator('.recipe-editor-step textarea').last().fill(stepText);
    await a.click('[data-recipe-editor-action="step-add"]'); await a.locator('.recipe-editor-step textarea').last().fill('Alles vermengen.');
    const png = await a.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 100; canvas.getContext('2d').fillRect(0, 0, 160, 100); return canvas.toDataURL('image/png').split(',')[1]; });
    await a.locator('#recipe-image-file').setInputFiles({ name: 'recipe.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await a.locator('#recipe-image-preview').waitFor({ state: 'visible' });
    await noOverflow(a, 'recipe editor'); await screenshot(a, 'editor-desktop');
    await save(a); await queueEmpty(a);
    const first = await recipe(a, recipeName), remote = await recipe(b, recipeName);
    assert.equal(first.id, remote.id); assert.equal(first.revision, 1);
    assert.deepEqual(first.tags, ['Vegetarisch', 'Schnell']);
    assert.equal(first.steps.length, 2); assert.equal(first.steps[0].text, stepText);
    assert.deepEqual(first.ingredient_groups.map(group => group.name), ['Pasta', 'Sauce']);
    assert.equal(first.ingredient_groups[0].ingredients[0].quantity_unit, 'g');
    assert.equal(first.ingredient_groups[1].ingredients[0].quantity_unit, 'l');
    assert.ok(first.image_version && first.image_url);
    await open(b, first.id);
    await poll(a, () => document.querySelector('.recipe-title-image img')?.naturalWidth > 0);
    await poll(b, () => document.querySelector('.recipe-title-image img')?.naturalWidth > 0);
    await a.fill('#recipe-view-servings', '4'); await a.locator('#recipe-view-servings').press('Tab');
    assert.equal(await a.locator('[data-recipe-amount]').first().innerText(), '400 g');
    assert.equal(await a.locator('[data-recipe-amount]').last().innerText(), 'nach Geschmack');
    await noOverflow(a, 'desktop recipe'); await screenshot(a, 'reading-desktop');

    await edit(a); await a.fill('#recipe-description', 'Realtime description');
    await a.locator('.recipe-editor-step').nth(1).locator('[data-recipe-editor-action="step-up"]').click();
    await save(a); await queueEmpty(a);
    await poll(b, async id => (await window.dbGetAll('cookbooks')).flatMap(book => book.recipes || []).find(recipe => recipe.id === id)?.description === 'Realtime description', first.id);
    const reordered = await recipe(a, recipeName);
    assert.equal(reordered.steps[0].id, first.steps[1].id, 'reordering retains child record identity');

    // A genuine cross-device edit conflict must retain the offline draft until
    // the user explicitly chooses its overwrite action and confirms it.
    await a.setViewportSize({ width: 390, height: 844 }); expectedErrorStart = clients[0].consoleErrors.length;
    await a.context().setOffline(true); await poll(a, () => navigator.onLine === false);
    await edit(a); await a.fill('#recipe-description', 'Offline draft retained');
    await a.click('[data-recipe-editor-action="step-add"]'); await a.locator('.recipe-editor-step textarea').last().fill('Offline ergänzter Schritt.\nMit zweiter Zeile.');
    await save(a);
    await poll(a, async () => (await window.dbGetAll('syncQueue')).some(row => row.action === 'UPDATE_RECIPE'));
    await poll(a, () => document.querySelector('.recipe-title-image img')?.naturalWidth > 0);
    await edit(b); await b.fill('#recipe-description', 'Other device changed the recipe'); await save(b); await queueEmpty(b);
    await a.context().setOffline(false); await a.locator('.recipe-reading .recipe-conflict').waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal((await recipe(a, recipeName)).description, 'Offline draft retained');
    await noOverflow(a, 'mobile conflict'); await screenshot(a, 'mobile-conflict');
    await a.locator('.recipe-reading [data-recipe-action="keep-local"]').click(); await a.click('#confirm-confirm-btn');
    await queueEmpty(a); await a.locator('.recipe-reading .recipe-conflict').waitFor({ state: 'hidden' });
    await poll(b, async id => (await window.dbGetAll('cookbooks')).flatMap(book => book.recipes || []).find(recipe => recipe.id === id)?.description === 'Offline draft retained', first.id);
    assert.equal((await recipe(b, recipeName)).steps.length, 3);
    expectedErrorEnd = clients[0].consoleErrors.length; expectedErrorRanges.push([expectedErrorStart, expectedErrorEnd]);
    await screenshot(a, 'mobile-synchronized');
    await a.reload({ waitUntil: 'domcontentloaded' }); await a.locator('#login-overlay').waitFor({ state: 'hidden' });
    await recipe(a, recipeName); await a.locator('.recipe-reading').waitFor({ state: 'visible' });
    await poll(a, () => document.querySelector('.recipe-title-image img')?.naturalWidth > 0);
    await noOverflow(a, 'mobile reload');
    await activate(a, 'tasks'); await activate(a);
    await a.locator('.recipe-reading').waitFor({ state: 'visible' });

    // A completely local cookbook and recipe must survive parent-ID remapping.
    const pendingBookName = `${bookName} offline`, pendingRecipeName = `${recipeName} offline`;
    expectedErrorStart = clients[0].consoleErrors.length;
    await a.context().setOffline(true);
    await makeBook(a, pendingBookName); await create(a); await a.fill('#recipe-name', pendingRecipeName); await save(a);
    const pending = await recipe(a, pendingRecipeName, false);
    const pendingQueue = await a.evaluate(async () => (await window.dbGetAll('syncQueue')).map(row => row.action));
    assert.ok(pendingQueue.includes('CREATE_COOKBOOK') && pendingQueue.includes('CREATE_RECIPE'));
    await a.context().setOffline(false); await queueEmpty(a);
    const synchronized = await recipe(a, pendingRecipeName); await recipe(b, pendingRecipeName);
    assert.equal(synchronized.client_mutation_id, pending.client_mutation_id);
    assert.equal(typeof synchronized.cookbook_id, 'number');
    expectedErrorEnd = clients[0].consoleErrors.length; expectedErrorRanges.push([expectedErrorStart, expectedErrorEnd]);
    await edit(a); await a.click('#recipe-detail-header-menu-trigger'); await a.click('#recipe-delete-btn');
    await a.click('#confirm-confirm-btn'); await a.locator('#recipe-modal').waitFor({ state: 'hidden' }); await queueEmpty(a);
    await poll(b, async id => !(await window.dbGetAll('cookbooks')).flatMap(book => book.recipes || []).some(recipe => recipe.id === id), synchronized.id);
    for (const [index, client] of clients.entries()) {
      const errors = client.dumpErrors(); assert.deepEqual(errors.pageErrors, []);
      const expected = /net::ERR_INTERNET_DISCONNECTED|WebSocket connection .* failed|\[WS\].*Error: Event|the server responded with a status of 409|^WS: message handler failed TypeError: Failed to fetch/;
      assert.deepEqual(errors.consoleErrors.filter((message, position) => !(index === 0 && expectedErrorRanges.some(([start, end]) => position >= start && position < end) && expected.test(message))), []);
    }
    console.log('✅ Recipe real-service structured editor/tags/images, two-browser realtime, scaling, offline conflict, parent remap, reload and delete passed');
  } catch (error) {
    for (const [index, client] of clients.entries()) {
      console.error(`Recipe client ${index} errors:`, JSON.stringify(client.dumpErrors()));
      console.error(await client.page.evaluate(async () => ({
        module: document.getElementById('app')?.dataset.activeModule, heading: document.getElementById('cookbook-navigation-main')?.innerText,
        dialog: document.getElementById('recipe-error')?.textContent,
        books: typeof window.dbGetAll === 'function' ? (await window.dbGetAll('cookbooks')).map(book => ({ id: book.id, name: book.name, recipes: (book.recipes || []).map(recipe => ({ id: recipe.id, title: recipe.title, revision: recipe.revision, conflict: Boolean(recipe.conflict) })) })) : [],
        queue: typeof window.dbGetAll === 'function' ? (await window.dbGetAll('syncQueue')).map(({ action, data }) => ({ action, id: data.id, cookbook_id: data.cookbook_id, expected_revision: data.expected_revision })) : [],
      })).catch(() => null));
      await screenshot(client.page, `failure-${index}`).catch(() => {});
    }
    throw error;
  } finally { for (const client of clients) { await client.page.context().setOffline(false).catch(() => {}); await client.browser.close(); } }
}
await withFreshDb(run);

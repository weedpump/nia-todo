#!/usr/bin/env node
// One private FastAPI child, fresh full migrations and the actual web app.
// This script never controls an installed service or opens an installed DB.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForPageCondition } from './browser_page_condition.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const python = process.env.NIA_TODO_TEST_PYTHON || (existsSync(join(root, '.venv/bin/python')) ? join(root, '.venv/bin/python') : 'python3');
const privateDir = await mkdtemp(join(tmpdir(), 'nia-recipe-transfer-e2e-'));
const infoFile = join(privateDir, 'server.json');
const setupTokenFile = join(privateDir, 'setup-token');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let child, client, phase = 'starting private service';

async function stopChild() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  let timer;
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await exited;
}

async function waitForPrivateService() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Private FastAPI child exited during startup');
    try {
      const { port } = JSON.parse(await readFile(infoFile, 'utf8'));
      assert(Number.isInteger(port) && port > 0);
      const base = `http://127.0.0.1:${port}`;
      const response = await fetch(`${base}/api/setup/status`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return base;
    } catch { /* Startup is not ready yet; never print setup credentials. */ }
    await sleep(100);
  }
  throw new Error('Private FastAPI child did not become ready within 45 seconds');
}

try {
  if (python !== 'python3') await access(python);
  const childCode = `
import asyncio, json, os, socket, sys
os.umask(0o077)
import uvicorn
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(('127.0.0.1', 0))
with open(sys.argv[1], 'w', encoding='utf-8') as handle:
    json.dump({'port': sock.getsockname()[1]}, handle)
config = uvicorn.Config('main:app', host='127.0.0.1', log_level='error', access_log=False, lifespan='on')
asyncio.run(uvicorn.Server(config).serve(sockets=[sock]))
`;
  child = spawn(python, ['-c', childCode, infoFile], {
    cwd: join(root, 'api'), stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, PYTHONPATH: join(root, 'api'),
      NIA_TODO_DATA_DIR: privateDir, NIA_TODO_DB: join(privateDir, 'e2e.db'),
      NIA_TODO_ATTACHMENT_DIR: join(privateDir, 'attachments'), NIA_TODO_AVATAR_DIR: join(privateDir, 'avatars'),
      NIA_TODO_BACKUP_DIR: join(privateDir, 'backups'), NIA_TODO_VAPID_KEYS: join(privateDir, 'vapid.json'),
      NIA_TODO_SETUP_TOKEN_FILE: setupTokenFile, NIA_TODO_UPDATE_STATUS_FILE: join(privateDir, 'update-status.json'),
      NIA_TODO_UPDATE_PRIMARY_URL: 'http://127.0.0.1:9/disabled',
      NIA_TODO_UPDATE_RELEASE_API_URL: 'http://127.0.0.1:9/disabled',
      NIA_TODO_UPDATE_RELEASES_URL: 'http://127.0.0.1:9/disabled',
      NIA_TODO_UPDATE_UMAMI_URL: 'http://127.0.0.1:9/disabled', NIA_TODO_UPDATE_UMAMI_WEBSITE_ID: '',
      NIA_TODO_INSTALLATION_TYPE: 'dev',
    },
  });
  let spawnFailure = null;
  child.on('error', error => { spawnFailure = error; });
  const base = await waitForPrivateService();
  if (spawnFailure) throw spawnFailure;
  const token = (await readFile(setupTokenFile, 'utf8')).trim();
  assert(token, 'Private setup token must exist');
  process.env.NIA_TODO_URL = base;
  process.env.NIA_TODO_DEV_DIR = root;
  process.env.NIA_TODO_DATA_DIR = privateDir;
  process.env.NIA_TODO_DB_NAME = 'e2e.db';
  // This fixture's real transport is entirely loopback. Reuse the existing
  // explicit helper hook so NIC-less namespaces still track setOffline().
  process.env.NIA_TODO_TEST_ISOLATED_NETWORK = '1';
  // Import only browser/login helpers after binding their URL to this child.
  // No backupDb, withFreshDb, service or installed-service helpers are called.
  const { launchPage, USERNAME, USER_PASSWORD, ADMIN_PASSWORD, BASE_URL } = await import('./frontend_test_lib.mjs');
  assert.equal(BASE_URL, base, 'Browser helpers must be bound to the private child, never an installed service');
  phase = 'setting up private accounts';
  async function setup(path, data) {
    const response = await fetch(`${base}${path}`, { method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', 'X-Setup-Token': token }, body: JSON.stringify(data) });
    assert.equal(response.status, 200, `Private setup request failed: ${path} (${response.status})`);
  }
  await setup('/api/setup/admin', { admin_password: ADMIN_PASSWORD });
  await setup('/api/setup/first-user', { username: USERNAME, password: USER_PASSWORD,
    email: 'recipe-transfer-e2e@example.invalid', display_name: 'Recipe transfer E2E' });

  phase = 'logging into actual web app';
  client = await launchPage({ serviceWorkers: 'allow' });
  const { page } = client;
  let injectedOffline = false, networkTransition = 'online', diagnosticSequence = 0;
  const requestFailures = [], socketFailures = [], consoleFailures = [];
  const requestExposure = new WeakMap(), inFlightRequests = new Set(), openSockets = new Map();

  const diagnosticUrl = value => {
    try { const url = new URL(value); return `${url.origin}${url.pathname}`; }
    catch { return ''; }
  };
  const diagnosticText = value => value.replace(/(?:https?|wss?):\/\/[^\s'"<>]+/g, diagnosticUrl);
  page.context().on('request', request => {
    requestExposure.set(request, { started: ++diagnosticSequence, exposedOffline: injectedOffline });
    inFlightRequests.add(request);
  });
  page.context().on('requestfinished', request => inFlightRequests.delete(request));
  page.context().on('requestfailed', request => {
    const exposure = requestExposure.get(request) || {};
    requestFailures.push({ url: diagnosticUrl(request.url()), method: request.method(),
      errorText: request.failure()?.errorText || '', ...exposure,
      sequence: ++diagnosticSequence, injectedOffline, networkTransition, phase });
    inFlightRequests.delete(request);
  });
  page.on('websocket', socket => {
    const exposure = { started: ++diagnosticSequence, exposedOffline: injectedOffline };
    openSockets.set(socket, exposure);
    socket.on('socketerror', errorText => socketFailures.push({ url: diagnosticUrl(socket.url()),
      errorText: diagnosticText(String(errorText)), ...exposure,
      sequence: ++diagnosticSequence, injectedOffline, networkTransition, phase }));
    socket.on('close', () => openSockets.delete(socket));
  });
  page.on('console', message => {
    if (message.type() === 'error') consoleFailures.push({ message: diagnosticText(message.text()),
      url: diagnosticUrl(message.location().url), sequence: ++diagnosticSequence,
      injectedOffline, networkTransition, phase });
  });
  await page.context().route('**/*', route => new URL(route.request().url()).origin === base
    ? route.continue() : route.abort('blockedbyclient'));
  await client.loginApp();
  const poll = (predicate, arg) => waitForPageCondition(page, predicate, arg, { timeout: 30000 });
  phase = 'seeding through authenticated application APIs';
  const seeded = await page.evaluate(async () => {
    const { recipesApi } = await import('/static/js/api/recipes.js');
    const { shoppingApi } = await import('/static/js/api/shopping.js');
    const book = await recipesApi.createCookbook({ name: 'Transfer E2E cookbook', client_mutation_id: 'e2e-book' });
    const recipe = await recipesApi.createRecipe(book.id, { title: 'Transfer E2E meal', base_servings: 2,
      client_mutation_id: 'e2e-recipe', ingredient_groups: [{ client_key: 'main', name: 'Ingredients', ingredients: [
        { client_key: 'milk', name: 'Milk', quantity_value: 250, quantity_unit: 'ml', note: 'Keep cold' },
        { client_key: 'salt', name: 'Salt', quantity_text: 'to taste', note: 'Do not scale' },
        { client_key: 'powder', name: 'Baking powder', quantity_value: .25, quantity_unit: 'Packung' },
        { client_key: 'custom', name: 'Custom ingredient', quantity_value: .25, quantity_unit: 'Hansdampf' },
        { client_key: 'tiny', name: 'Tiny spice', quantity_value: .1, quantity_unit: 'g' },
      ] }], steps: [
        { client_key: 'mix', text: 'Mix carefully.\nStir until combined.', ingredients: [
          { ingredient_client_key: 'milk', show_quantity: true }, { ingredient_client_key: 'salt', show_quantity: true },
          { ingredient_client_key: 'powder', show_quantity: true },
        ] },
        { client_key: 'finish', text: 'Serve gently.\nAdd the spice.', ingredients: [
          { ingredient_client_key: 'milk', show_quantity: true, quantity_value: 100 }, { ingredient_client_key: 'tiny', show_quantity: true },
        ] },
      ] });
    const list = await shoppingApi.createList({ name: 'Transfer E2E groceries', client_mutation_id: 'e2e-list' });
    const section = await shoppingApi.createSection(list.id, { name: 'Ingredients', client_mutation_id: 'e2e-section' });
    const store = await shoppingApi.createStore({ shopping_list_id: list.id, name: 'E2E market', client_mutation_id: 'e2e-store' });
    const milk = await shoppingApi.createItem(list.id, { name: 'Milk', quantity_value: .5, quantity_unit: 'l', note: 'Keep cold',
      section_id: section.id, store_ids: [store.id], client_mutation_id: 'e2e-milk' });
    const completed = await shoppingApi.createItem(list.id, { name: 'Milk', quantity_value: 5, quantity_unit: 'l', note: 'Keep cold',
      section_id: section.id, store_ids: [store.id], client_mutation_id: 'e2e-completed' });
    const completedSnapshot = await shoppingApi.updateItem(completed.id, { completed: true });
    return { book: book.id, recipe: recipe.id, list: list.id, section: section.id, store: store.id,
      milk: milk.id, completed: completedSnapshot };
  });
  await poll(async expected => typeof window.dbGetAll === 'function'
    && (await window.dbGetAll('cookbooks')).some(book => book.id === expected.book && book.recipes.some(recipe => recipe.id === expected.recipe))
    && (await window.dbGetAll('shoppingLists')).some(list => list.id === expected.list)
    && (await window.dbGetAll('shoppingStores')).some(store => store.id === expected.store), seeded);
  await page.click('#module-switcher-button');
  await page.click('[data-module-action="select"][data-module-id="recipes"]');
  await page.locator(`#cookbook-sidebar [data-entity-sidebar-action="select"][data-entity-id="${seeded.book}"]`).click();
  await page.locator(`.recipe-card[data-recipe-id="${seeded.recipe}"]`).click();
  await page.locator('.recipe-reading').waitFor({ state: 'visible' });
  const locale = await page.evaluate(async () => (await import('/static/js/i18n/index.js')).getActiveLocale());
  const packLabel = await page.evaluate(async locale => (await import('/static/js/core/quantity-units.js')).formatQuantityUnit('pack', locale), locale);
  phase = 'saving a step assignment through the actual shared editor';
  await page.locator('[data-recipe-action="edit"]').click();
  const recipeModal = page.locator('#recipe-modal');
  await recipeModal.waitFor({ state: 'visible' });
  const editorStep = recipeModal.locator('.recipe-editor-step[data-key="mix"]');
  await editorStep.locator('[data-recipe-editor-action="step-ingredients-toggle"]').click();
  await editorStep.locator('[data-step-group="main"] > summary').click();
  await editorStep.locator('[data-step-ingredient="custom"]').check();
  const customChoice = editorStep.locator('[data-step-choice="custom"]');
  await customChoice.locator('.recipe-editor-step-quantity > summary').click();
  await customChoice.locator('[data-step-quantity-value]').fill('0.125');
  await page.click('#recipe-save-btn');
  await recipeModal.waitFor({ state: 'hidden' });
  await poll(async id => (await window.dbGetAll('cookbooks')).flatMap(book => book.recipes || []).some(recipe => recipe.id === id && recipe.revision === 2 && !recipe.pending), seeded.recipe);
  const savedLinks = await page.evaluate(async id => (await (await import('/static/js/api/recipes.js')).recipesApi.getRecipe(id)).steps[0].ingredients, seeded.recipe);
  assert.deepEqual(savedLinks.at(-1), { ingredient_client_key: 'custom', show_quantity: true, quantity_value: .125, quantity_text: null });
  phase = 'reading step ingredients and entering actual cooking mode';
  assert.equal(await page.locator('.recipe-steps>li[data-recipe-step-key="mix"] .recipe-step-ingredient').count(), 4);
  assert.deepEqual(await page.locator('[data-step-ingredient-amount="milk"]').allTextContents(), ['250 ml', '100 ml'], 'full and custom step amounts remain visible for repeated ingredients');
  assert.equal(await page.locator('[data-step-ingredient-amount="custom"]').textContent(), `${new Intl.NumberFormat(locale).format(.125)} Hansdampf`);
  assert.equal(await page.locator('[data-step-ingredient-amount="powder"]').textContent(), `¼ ${packLabel}`);
  await page.locator('[data-recipe-action="cook"]').click();
  await page.locator('.recipe-cooking-step[data-recipe-step-key="mix"]').waitFor({ state: 'visible' });
  await page.fill('#recipe-view-servings', '4');
  assert.equal(await page.locator('[data-step-ingredient-amount="powder"]').textContent(), `½ ${packLabel}`);
  await page.locator('[data-recipe-action="next-step"]').click();
  await page.locator('.recipe-cooking-step[data-recipe-step-key="finish"]').waitFor({ state: 'visible' });
  phase = 'restoring current cooking step and portions after reload';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.recipe-cooking-step[data-recipe-step-key="finish"]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#recipe-view-servings').inputValue(), '4');
  assert.equal(await page.locator('[data-step-ingredient-amount="milk"]').textContent(), '200 ml', 'custom step amount scales and survives cooking reload');
  await client.dismissWhatsNewIfVisible();
  await page.goBack();
  await page.locator('.recipe-reading').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.recipe-cooking').count(), 0, 'Back exits cooking before leaving the recipe');
  assert.equal(await page.locator('#recipe-view-servings').inputValue(), '4');
  const modal = page.locator('#recipe-transfer-modal');
  async function applyThroughUi(servings) {
    await page.locator('.recipe-reading [data-recipe-action="transfer"]').click();
    await modal.waitFor({ state: 'visible' });
    await poll(() => document.getElementById('recipe-transfer-form')?.getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#recipe-transfer-list').inputValue(), String(seeded.list));
    await page.fill('#recipe-transfer-servings', String(servings));
    await page.locator('#recipe-transfer-defaults > summary').click();
    await page.locator('#recipe-transfer-section').selectOption(String(seeded.section), { force: true });
    await page.locator('#recipe-transfer-store').selectOption(String(seeded.store), { force: true });
    assert.equal(await page.locator('[data-transfer-ingredient]:checked').count(), 5);
    assert.equal(await page.locator('[data-transfer-amount="salt"]').textContent(), 'to taste');
    assert.equal(await page.locator('[data-transfer-amount="powder"]').textContent(), `${servings === 4 ? '½' : '¼'} ${packLabel}`);
    assert.equal(await page.locator('[data-transfer-amount="custom"]').textContent(), servings === 4 ? '½ Hansdampf' : '¼ Hansdampf');
    await page.click('#recipe-transfer-save-btn');
    await modal.waitFor({ state: 'hidden' });
  }
  async function transferQueueEmpty() {
    await poll(async () => !(await window.dbGetAll('syncQueue')).some(row => row.action === 'TRANSFER_RECIPE_TO_SHOPPING'));
  }
  const serverList = () => page.evaluate(async id => (await import('/static/js/api/shopping.js')).shoppingApi.getList(id), seeded.list);
  phase = 'desktop UI transfer';
  await applyThroughUi(4); await transferQueueEmpty();
  const first = await serverList();
  const milk = first.items.find(item => item.id === seeded.milk);
  assert.equal(first.items.length, 6);
  assert.equal(milk.quantity_value, 1); assert.equal(milk.quantity_unit, 'l');
  assert.equal(milk.note, 'Keep cold'); assert.equal(milk.recipe_sources_count, 1);
  assert.equal(milk.recipe_sources[0].recipe_id, seeded.recipe);
  assert.equal(milk.recipe_sources[0].recipe_title, 'Transfer E2E meal');
  assert.equal(milk.recipe_sources[0].quantity_value, 500);
  const salt = first.items.find(item => item.name === 'Salt');
  assert.equal(salt.quantity_value, null); assert.equal(salt.quantity_text, 'to taste'); assert.equal(salt.note, 'Do not scale');
  assert.deepEqual(first.items.find(item => item.id === seeded.completed.id), seeded.completed);

  phase = 'mobile offline enqueue and real PWA reload';
  await page.setViewportSize({ width: 390, height: 844 });
  await poll(() => navigator.serviceWorker?.controller?.state === 'activated');
  networkTransition = 'going-offline'; injectedOffline = true;
  // Requests/sockets already open when transport is disabled were also exposed.
  for (const request of inFlightRequests) requestExposure.get(request).exposedOffline = true;
  for (const exposure of openSockets.values()) exposure.exposedOffline = true;
  await page.context().setOffline(true); await poll(() => navigator.onLine === false);
  networkTransition = 'offline';
  await applyThroughUi(2);
  const queued = await page.evaluate(async () => (await window.dbGetAll('syncQueue')).filter(row => row.action === 'TRANSFER_RECIPE_TO_SHOPPING'));
  assert.equal(queued.length, 1); assert.equal(queued[0].attempted, undefined);
  const mutationId = queued[0].data.client_mutation_id;
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#login-overlay').waitFor({ state: 'hidden' });
  await poll(async cmi => typeof window.dbGetAll === 'function'
    && (await window.dbGetAll('syncQueue')).some(row => row.action === 'TRANSFER_RECIPE_TO_SHOPPING' && row.data.client_mutation_id === cmi), mutationId);
  const afterReload = await page.evaluate(async () => (await window.dbGetAll('syncQueue')).filter(row => row.action === 'TRANSFER_RECIPE_TO_SHOPPING'));
  assert.equal(afterReload.length, 1); assert.deepEqual(afterReload[0].data, queued[0].data);
  assert.equal(await page.evaluate(() => navigator.onLine), false);
  phase = 'reconnecting durable transfer';
  networkTransition = 'reconnecting';
  // setOffline() dispatches transport failures while changing network state.
  // The offline exposure ends after that transition, never before its await.
  await page.context().setOffline(false);
  injectedOffline = false; networkTransition = 'online';
  await transferQueueEmpty();
  const second = await serverList();
  assert.equal(second.items.length, 7, 'free amounts remain separate on a new transfer');
  const finalMilk = second.items.find(item => item.id === seeded.milk);
  assert.equal(finalMilk.quantity_value, 1.25); assert.equal(finalMilk.quantity_unit, 'l'); assert.equal(finalMilk.quantity_display_mode, 'kitchen'); assert.equal(finalMilk.recipe_sources_count, 2);
  assert.deepEqual(finalMilk.recipe_sources.map(source => source.quantity_value), [500, 250]);
  assert.deepEqual(second.items.find(item => item.id === seeded.completed.id), seeded.completed);
  const unchangedRecipe = await page.evaluate(async id => (await import('/static/js/api/recipes.js')).recipesApi.getRecipe(id), seeded.recipe);
  assert.equal(unchangedRecipe.revision, 2); assert.equal(unchangedRecipe.base_servings, 2);
  assert.equal(unchangedRecipe.ingredient_groups[0].ingredients[0].quantity_value, 250);
  assert.deepEqual(unchangedRecipe.steps[0].ingredients.map(link => link.ingredient_client_key), ['milk', 'salt', 'powder', 'custom']);
  const powder = second.items.find(item => item.name === 'Baking powder');
  const custom = second.items.find(item => item.name === 'Custom ingredient');
  const tiny = second.items.find(item => item.name === 'Tiny spice');
  assert.equal(powder.quantity_value, .75); assert.equal(powder.quantity_unit, 'pack');
  assert.equal(custom.quantity_value, .75); assert.equal(custom.quantity_unit, 'Hansdampf');
  assert(Math.abs(tiny.quantity_value - .3) < 1e-12, 'small raw quantities never inflate to half a gram');
  phase = 'checking actual Shopping display after reconnect';
  await page.setViewportSize({ width: 1440, height: 1000 });
  await client.dismissWhatsNewIfVisible();
  await page.click('#module-switcher-button');
  await page.click('[data-module-action="select"][data-module-id="shopping"]');
  await page.locator(`[data-entity-sidebar-action="select"][data-entity-type="shopping-list"][data-entity-id="${seeded.list}"]`).first().click();
  for (const [id, label] of [[seeded.milk, `${new Intl.NumberFormat(locale).format(1250)} ml`], [powder.id, `¾ ${packLabel}`], [custom.id, '¾ Hansdampf'], [tiny.id, `${new Intl.NumberFormat(locale).format(.3)} g`]]) {
    const quantity = page.locator(`[data-shopping-item-key="${id}"] .shopping-item-quantity`);
    await quantity.waitFor({ state: 'visible' });
    assert.equal(await quantity.textContent(), label);
  }
  phase = 'consolidating matching source ingredients across recipe groups';
  const flourRecipe = await page.evaluate(async book => (await import('/static/js/api/recipes.js')).recipesApi.createRecipe(book, {
    title: 'Grouped flour recipe', base_servings: 4, client_mutation_id: 'e2e-grouped-flour',
    ingredient_groups: [
      {client_key:'dough',name:'Dough',ingredients:[{client_key:'dough-flour',name:'Wheat flour',quantity_value:250,quantity_unit:'g',note:'For dough'}]},
      {client_key:'filling',name:'Filling',ingredients:[{client_key:'filling-flour',name:'Wheat flour',quantity_value:100,quantity_unit:'g',note:'For filling'}]},
    ], steps:[{client_key:'prepare',text:'Prepare dough',ingredients:[{ingredient_client_key:'dough-flour',show_quantity:true,quantity_value:125}]}],
  }), seeded.book);
  await poll(async id => (await window.dbGetAll('cookbooks')).some(book=>book.recipes?.some(recipe=>recipe.id===id)), flourRecipe.id);
  await page.click('#module-switcher-button');
  await page.click('[data-module-action="select"][data-module-id="recipes"]');
  await page.locator(`#cookbook-sidebar [data-entity-sidebar-action="select"][data-entity-id="${seeded.book}"]`).click();
  await page.locator(`.recipe-card[data-recipe-id="${flourRecipe.id}"]`).click();
  await page.locator('.recipe-reading [data-recipe-action="transfer"]').click();
  await modal.waitFor({state:'visible'});
  await poll(()=>document.getElementById('recipe-transfer-form')?.getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('#recipe-transfer-servings').inputValue(),'4');
  assert.equal(await page.locator('#recipe-transfer-preview .recipe-transfer-summary-row').count(),1,'compatible ingredients with differing notes combine by default');
  assert.equal(await page.locator('[data-transfer-separate]').count(),1,'separation remains an explicit per-product option');
  assert.equal(await page.locator('#recipe-transfer-preview .recipe-transfer-summary-row').count(),1);
  assert.equal(await page.locator('#recipe-transfer-preview .recipe-transfer-summary-amount').textContent(),'350 g','preview sums both original source totals, not the custom step amount');
  await page.click('#recipe-transfer-save-btn');await modal.waitFor({state:'hidden'});await transferQueueEmpty();
  const groupedRows=(await serverList()).items.filter(item=>item.name==='Wheat flour');
  assert.equal(groupedRows.length,1,'one Shopping item across two recipe groups');
  assert.equal(groupedRows[0].quantity_value,350);assert.equal(groupedRows[0].quantity_unit,'g');
  assert.equal(groupedRows[0].recipe_sources_count,2);
  assert.deepEqual(groupedRows[0].recipe_sources.map(source=>source.quantity_value),[250,100]);
  assert.deepEqual(groupedRows[0].recipe_sources.map(source=>source.note),['For dough','For filling']);

  assert.deepEqual(client.pageErrors, []);
  const nearestFailure = (failures, error, predicate) => failures
    .filter(failure => failure.started <= error.sequence && predicate(failure))
    .sort((left, right) => Math.abs(left.sequence - error.sequence) - Math.abs(right.sequence - error.sequence))[0];
  const expectedOfflineError = error => {
    if (/^Failed to load resource: net::ERR_(?:FAILED|INTERNET_DISCONNECTED)$/.test(error.message)) {
      // Console delivery and requestfailed callbacks may arrive on either side
      // of the awaited reconnect. Correlate to the actual request lifetime,
      // not the network flag at callback time. A fresh online failure at the
      // same URL must not inherit an earlier offline failure's exemption.
      const failure = nearestFailure(requestFailures, error, request => request.url === error.url
        && /^net::ERR_(?:FAILED|INTERNET_DISCONNECTED)$/.test(request.errorText));
      return Boolean(error.url) && failure?.exposedOffline === true;
    }
    const socketUrl = error.message.match(/^WebSocket connection to '([^']+)' failed/);
    if (socketUrl) return nearestFailure(socketFailures, error,
      socket => socket.url === diagnosticUrl(socketUrl[1]))?.exposedOffline === true;
    if (!error.injectedOffline) return false;
    if (/^\[WS\].*Error: Event$/.test(error.message)) return socketFailures.some(socket => socket.exposedOffline);
    if (/^WS: message handler failed TypeError: Failed to fetch$/.test(error.message)) {
      return requestFailures.some(request => request.exposedOffline
        && /^net::ERR_(?:FAILED|INTERNET_DISCONNECTED)$/.test(request.errorText));
    }
    return false;
  };
  const unexpectedErrors = consoleFailures.filter(error => !expectedOfflineError(error));
  assert.deepEqual(unexpectedErrors, [], `Unexpected browser errors: ${JSON.stringify({ unexpectedErrors, requestFailures, socketFailures })}`);
  console.log('✅ Private real-app Recipe→Shopping login, scaled merge, provenance, mobile offline reload and reconnect passed');
} catch (error) {
  console.error(`Recipe transfer E2E failed during: ${phase}`);
  throw error;
} finally {
  try { await client?.browser.close(); }
  finally { await stopChild(); await rm(privateDir, { recursive: true, force: true }); }
}

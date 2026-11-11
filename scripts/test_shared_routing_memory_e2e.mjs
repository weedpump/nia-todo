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
const typoOnly = process.argv.includes('--typos');
const python = process.env.NIA_TODO_TEST_PYTHON || (existsSync(join(root, '.venv/bin/python')) ? join(root, '.venv/bin/python') : 'python3');
const privateDir = await mkdtemp(join(tmpdir(), 'nia-shared-routing-e2e-'));
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
    email: 'routing-memory-e2e@example.invalid', display_name: 'Routing memory E2E' });

  phase = 'logging into actual web app';
  client = await launchPage({ serviceWorkers: 'allow' });
  const { page } = client;
  const consoleErrors = [], sent = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.context().on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && (path === '/api/todos' || /shopping-transfer$/.test(path) || /\/api\/shopping\/lists\/[^/]+\/items$/.test(path))) {
      try { sent.push({path,body:request.postDataJSON()}); } catch { /* Not JSON. */ }
    }
  });
  let nextApiRequestAt = 0;
  await page.context().route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    // Automated full-feature flows exceed human interaction speed. Respect the
    // unchanged production per-IP limit instead of disabling it in the fixture.
    if (url.pathname.startsWith('/api/')) {
      const now = Date.now(), scheduled = Math.max(now, nextApiRequestAt);
      nextApiRequestAt = scheduled + 250;
      if (scheduled > now) await sleep(scheduled - now);
    }
    return route.continue();
  });
  await client.loginApp();
  const poll = (predicate,arg) => waitForPageCondition(page,predicate,arg,{timeout:30000});
  const memoryState = () => page.evaluate(async () => (await import('/static/js/api/routing-memory.js')).routingMemoryApi.read());
  const queueEmpty = () => poll(async () => !(await window.dbGetAll('syncQueue')).length);
  phase = 'seeding private entities through authenticated APIs';
  const seeded = await page.evaluate(async () => {
    const {shoppingApi} = await import('/static/js/api/shopping.js');
    const {recipesApi} = await import('/static/js/api/recipes.js');
    const list=await shoppingApi.createList({name:'Routing groceries',client_mutation_id:'routing-list'});
    const cold=await shoppingApi.createSection(list.id,{name:'Cold shelf',client_mutation_id:'routing-cold'});
    const dry=await shoppingApi.createSection(list.id,{name:'Dry shelf',client_mutation_id:'routing-dry'});
    const first=await shoppingApi.createStore({shopping_list_id:list.id,name:'First market',client_mutation_id:'routing-first'});
    const second=await shoppingApi.createStore({shopping_list_id:list.id,name:'Second market',client_mutation_id:'routing-second'});
    const book=await recipesApi.createCookbook({name:'Routing recipes',client_mutation_id:'routing-book'});
    const recipe=await recipesApi.createRecipe(book.id,{title:'Butter and oil',base_servings:2,client_mutation_id:'routing-recipe',ingredient_groups:[{client_key:'group',name:'Ingredients',ingredients:[
      {client_key:'butter',name:'Butter',quantity_value:100,quantity_unit:'g'},
      {client_key:'oil',name:'Oil',quantity_value:20,quantity_unit:'ml'},
    ]}],steps:[{client_key:'mix',text:'Mix together.'}]});
    const {http}=await import('/static/js/api/http.js');
    const user=await http.get('/api/me');
    return {list:list.id,cold:cold.id,dry:dry.id,first:first.id,second:second.id,book:book.id,recipe:recipe.id,user:user.id,braindump:user.braindump_enabled};
  });
  assert.equal(seeded.braindump,false,'ordinary Shopping routing must work without a BrainDump entitlement');
  assert.equal((await memoryState()).enabled,true);
  phase='ordinary account opens the shared Memory settings';
  await page.click('#user-menu-button');await page.click('#menu-settings-btn');
  const settingsModal=page.locator('#settings-modal');await settingsModal.waitFor({state:'visible'});
  assert.equal(await page.locator('#settings-nav-braindump').isVisible(),true,'the Memory navigation entry is visible without BrainDump rights');
  await page.locator('#settings-nav-braindump').click();
  await page.locator('#settings-section-braindump').waitFor({state:'visible'});
  const memoryTitle=await page.evaluate(async()=>{const {t}=await import('/static/js/i18n/index.js');return t('settings.routingMemory.title');});
  assert.match(await page.locator('#settings-nav-braindump').textContent(),new RegExp(memoryTitle));
  assert.equal(await page.locator('#settings-braindump-learning').isVisible(),true,'ordinary accounts can inspect the shared learning toggle');
  assert.equal(await page.locator('#settings-braindump-learning').isChecked(),true);
  await settingsModal.locator('button.modal-close-x[data-close-modal="settings-modal"]').click();await settingsModal.waitFor({state:'hidden'});

  await poll(async expected => typeof window.dbGetAll==='function'
    && (await window.dbGetAll('shoppingLists')).some(list=>list.id===expected.list)
    && (await window.dbGetAll('shoppingStores')).some(store=>store.id===expected.second)
    && (await window.dbGetAll('cookbooks')).some(book=>book.id===expected.book&&book.recipes.some(recipe=>recipe.id===expected.recipe)),seeded);
  async function selectModule(id) {
    await client.dismissWhatsNewIfVisible();
    await page.click('#module-switcher-button');
    await page.click(`[data-module-action="select"][data-module-id="${id}"]`);
  }
  async function shopping() {
    await selectModule('shopping');
    await page.locator(`[data-entity-sidebar-action="select"][data-entity-type="shopping-list"][data-entity-id="${seeded.list}"]`).first().click();
  }
  async function recipe(recipeId=seeded.recipe) {
    await selectModule('recipes');
    await page.locator(`#cookbook-sidebar [data-entity-sidebar-action="select"][data-entity-id="${seeded.book}"]`).click();
    await page.locator(`.recipe-card[data-recipe-id="${recipeId}"]`).click();
    await page.locator('.recipe-reading').waitFor({state:'visible'});
  }
  const itemModal=page.locator('#shopping-item-modal'),transferModal=page.locator('#recipe-transfer-modal');
  async function createItem() {
    await page.locator('[data-shopping-item-action="open-create"]').click();
    await itemModal.waitFor({state:'visible'});
    await page.fill('#shopping-item-name','Butter');
  }
  async function openTransfer() {
    await page.locator('.recipe-reading [data-recipe-action="transfer"]').click();
    await transferModal.waitFor({state:'visible'});
    await poll(()=>document.getElementById('recipe-transfer-form')?.getAttribute('aria-busy')==='false');
  }
  async function applyTransfer() {
    await page.click('#recipe-transfer-save-btn');await transferModal.waitFor({state:'hidden'});await queueEmpty();
  }
  phase='teaching a destination through the real Shopping editor';
  await shopping();await createItem();
  await page.locator('#shopping-item-section').selectOption(String(seeded.cold),{force:true});
  await page.locator('#shopping-item-store').selectOption(String(seeded.first),{force:true});
  await page.click('#shopping-item-save-btn');await itemModal.waitFor({state:'hidden'});await queueEmpty();
  const manual=sent.filter(row=>/\/items$/.test(row.path)).at(-1).body;
  assert.deepEqual([...manual.routing_feedback.fields].sort(),['list','section','stores']);
  let state=await memoryState(),butter=state.entries.find(row=>row.name_key==='butter');
  assert.equal(butter.section_id,seeded.cold);assert.deepEqual(butter.store_ids,[seeded.first]);
  phase='a single known product routes an unfamiliar added word in normal Shopping';
  await createItem();await page.fill('#shopping-item-name','Bio Butter');
  await poll(expected=>document.getElementById('shopping-item-section')?.value===String(expected.cold)&&document.getElementById('shopping-item-store')?.value===String(expected.first),seeded);
  assert.equal(await page.locator('#shopping-item-quick-add-preview [data-source="memory"] .quick-add-memory-icon svg').count(),2,'personal phrase matching uses the existing AI source badges from one complete remembered product');
  await page.click('#shopping-item-save-btn');await itemModal.waitFor({state:'hidden'});await queueEmpty();
  const baseWrite=sent.filter(row=>/\/items$/.test(row.path)).at(-1).body;
  assert.deepEqual(baseWrite.routing_feedback.fields,['list'],'phrase-derived children do not confirm themselves');
  const baseSaved=(await memoryState()).entries.find(row=>row.name_key==='bio butter');
  assert.equal(baseSaved.evidence.section.observations,0);assert.equal(baseSaved.evidence.stores.observations,0);
  phase='a learned word matches an unfamiliar qualifier, without vocabulary';
  await page.evaluate(async expected=>{
    const {routingMemoryApi}=await import('/static/js/api/routing-memory.js');
    const {shoppingApi}=await import('/static/js/api/shopping.js');
    const state=await routingMemoryApi.read();
    await shoppingApi.createItem(expected.list,{name:'Margerine',section_id:expected.cold,store_ids:[expected.first],
      client_mutation_id:'personal-margerine-example',routing_feedback:{event_id:'personal-margerine-example',generation:state.generation,fields:['list','section','stores']}});
  },seeded);
  await createItem();await page.fill('#shopping-item-name','pflanzliche Margerine');
  await poll(expected=>document.getElementById('shopping-item-section')?.value===String(expected.cold)
    &&document.getElementById('shopping-item-store')?.value===String(expected.first),seeded);
  assert.equal(await page.locator('#shopping-item-quick-add-preview [data-source="memory"] .quick-add-memory-icon svg').count(),2,'same remembered word, unknown modifier, existing automatic AI badges');
  await itemModal.locator('button[data-close-modal="shopping-item-modal"]').click();await itemModal.waitFor({state:'hidden'});
  if (typoOnly) {
  phase='single-edit personal routing applies without renaming or self-learning';
  const typoSeed=(await memoryState()).entries.find(row=>row.name_key==='margerine');
  await createItem();await page.fill('#shopping-item-name','Pflanzliche Margarine');
  await poll(expected=>document.getElementById('shopping-item-section')?.value===String(expected.cold)
    &&document.getElementById('shopping-item-store')?.value===String(expected.first),seeded);
  assert.equal(await page.locator('#shopping-item-quick-add-preview [data-source="memory"] .quick-add-memory-icon svg').count(),2,'typo routes use the existing automatic AI badges');
  await page.click('#shopping-item-save-btn');await itemModal.waitFor({state:'hidden'});await queueEmpty();
  const typoWrite=sent.filter(row=>/\/items$/.test(row.path)).at(-1).body;
  assert.equal(typoWrite.name,'Pflanzliche Margarine','routing never rewrites the entered spelling');
  assert.deepEqual(typoWrite.routing_feedback.fields,['list'],'inferred child destinations do not teach themselves');
  const listOnlyVariant=(await memoryState()).entries.find(row=>row.name_key==='pflanzliche margarine');
  assert.equal(listOnlyVariant.evidence.section.observations,0);assert.equal(listOnlyVariant.evidence.stores.observations,0);
  await createItem();await page.fill('#shopping-item-name','Pflanzliche Margarine');
  await poll(expected=>document.getElementById('shopping-item-section')?.value===String(expected.cold)
    &&document.getElementById('shopping-item-store')?.value===String(expected.first),seeded);
  await itemModal.locator('button[data-close-modal="shopping-item-modal"]').click();await itemModal.waitFor({state:'hidden'});
  phase='a recipe uses the same typo route for consolidated ingredients';
  const typoRecipe=await page.evaluate(async expected=>{
    const {recipesApi}=await import('/static/js/api/recipes.js');
    return recipesApi.createRecipe(expected.book,{title:'Single-edit recipe example',base_servings:2,client_mutation_id:'typo-recipe-example',
      ingredient_groups:[{client_key:'typo-first',name:'Filling',ingredients:[{client_key:'typo-fat-first',name:'Pflanzliche Margarine',quantity_value:40,quantity_unit:'g'}]},
        {client_key:'typo-second',name:'Glaze',ingredients:[{client_key:'typo-fat-second',name:'Pflanzliche Margarine',quantity_value:20,quantity_unit:'g'}]}],
      steps:[{client_key:'typo-step',text:'Combine the ingredients.'}]});
  },seeded);
  await poll(async expected=>(await window.dbGetAll('cookbooks')).some(book=>book.id===expected.book&&book.recipes.some(recipe=>recipe.id===expected.recipe)),{book:seeded.book,recipe:typoRecipe.id});
  await recipe(typoRecipe.id);await openTransfer();
  const typoProduct=page.locator('.recipe-transfer-product').filter({hasText:'Pflanzliche Margarine'});
  await poll(()=>[...document.querySelectorAll('.recipe-transfer-product')].some(node=>node.textContent.includes('Pflanzliche Margarine')&&node.textContent.includes('Cold shelf')&&node.textContent.includes('First market')));
  assert.equal(await typoProduct.locator('.recipe-transfer-summary-row').count(),1,'combined source quantities have one destination');
  assert.equal(await typoProduct.locator('[data-source="memory"] .quick-add-memory-icon svg').count(),2);
  if(process.env.NIA_TYPO_RECIPE_SCREENSHOT)await transferModal.screenshot({path:process.env.NIA_TYPO_RECIPE_SCREENSHOT});
  await applyTransfer();
  const typoTransfer=sent.filter(row=>/shopping-transfer$/.test(row.path)).at(-1).body;
  assert.equal(typoTransfer.ingredients.length,2);
  for(const row of typoTransfer.ingredients){
    assert.equal(row.section_id,seeded.cold);assert.deepEqual(row.store_ids,[seeded.first]);
    assert.ok(!row.routing_feedback?.fields.length,'recipe typo predictions create no learning intent');
  }
  const transferredTypos=await page.evaluate(async expected=>{
    const {shoppingApi}=await import('/static/js/api/shopping.js');
    return (await shoppingApi.getList(expected.list)).items.filter(row=>row.name==='Pflanzliche Margarine'&&row.quantity_value===60);
  },seeded);
  assert.equal(transferredTypos.length,1,'the recipe amount is consolidated under its original spelling');
  assert.equal(transferredTypos[0].section_id,seeded.cold);assert.deepEqual(transferredTypos[0].store_ids,[seeded.first]);
  const afterTypos=(await memoryState()).entries.find(row=>row.name_key==='margerine');
  for(const field of ['list','section','stores'])assert.equal(afterTypos.evidence[field].observations,typoSeed.evidence[field].observations,'typo usage never reinforces the original source');
  assert.deepEqual(client.pageErrors,[]);assert.deepEqual(consoleErrors,[]);
  console.log('✅ Single-edit routing: actual Shopping entry, list-only reopen, consolidated recipe transfer, unchanged names and no self-learning passed');
  } else {
  phase='a recipe ingredient uses the same base route in the real transfer dialog';
  const organicRecipe=await page.evaluate(async expected=>{
    const {recipesApi}=await import('/static/js/api/recipes.js');
    return recipesApi.createRecipe(expected.book,{title:'Organic butter example',base_servings:2,client_mutation_id:'organic-base-example',ingredient_groups:[{client_key:'organic-group',name:'Ingredients',ingredients:[{client_key:'organic-butter',name:'Bio Butter',quantity_value:50,quantity_unit:'g'}]}],steps:[{client_key:'organic-mix',text:'Use the butter.'}]});
  },seeded);
  await poll(async expected=>(await window.dbGetAll('cookbooks')).some(book=>book.id===expected.book&&book.recipes.some(recipe=>recipe.id===expected.recipe)),{book:seeded.book,recipe:organicRecipe.id});
  await recipe(organicRecipe.id);await openTransfer();
  const organicRow=page.locator('.recipe-transfer-row[data-key="organic-butter"]');
  await poll(()=>document.querySelector('.recipe-transfer-row[data-key="organic-butter"]')?.textContent.includes('Cold shelf'));
  assert.match(await organicRow.textContent(),/First market/);
  assert.equal(await organicRow.locator('[data-source="memory"] .quick-add-memory-icon svg').count(),2);
  await applyTransfer();
  const baseTransfer=sent.filter(row=>/shopping-transfer$/.test(row.path)).at(-1).body;
  assert.ok(baseTransfer.ingredients.every(row=>!row.routing_feedback?.fields.length),'recipe base suggestions carry no child learning intent');
  phase='consuming Shopping memory in the actual recipe dialog without self-learning';
  await recipe();await openTransfer();
  await poll(()=>document.querySelector('.recipe-transfer-row[data-key="butter"]')?.textContent.includes('Cold shelf'));
  assert.match(await page.locator('.recipe-transfer-row[data-key="butter"]').textContent(),/First market/);
  const rememberedButter=page.locator('.recipe-transfer-row[data-key="butter"]');
  assert.equal(await rememberedButter.locator('[data-source="memory"] .quick-add-memory-icon svg').count(),2,'recipe section and supermarket use the same AI-icon chips as Quick Add');
  assert.equal(await rememberedButter.locator('[data-source="memory"]').evaluateAll(nodes=>nodes.every(node=>node.tagName==='SPAN'&&!node.querySelector('button')&&node.title&&node.querySelector('[role="img"]')?.getAttribute('aria-label')===node.title)),true,'applied memory is automatic, localized and accessible, without an acceptance button');
  const untouched=butter.updated_at, observationsBefore=butter.evidence;
  await applyTransfer();
  const predicted=sent.filter(row=>/shopping-transfer$/.test(row.path)).at(-1).body;
  assert.ok(predicted.ingredients.every(row=>!row.routing_feedback||!row.routing_feedback.fields.length),'predictions do not become explicit learning');
  const afterPrediction=(await memoryState()).entries.find(row=>row.name_key==='butter');
  assert.equal(afterPrediction.updated_at,untouched,'reading/applying predictions leaves the learned choice unchanged');
  for(const field of ['list','section','stores'])assert.equal(afterPrediction.evidence[field].observations,observationsBefore[field].observations,'prediction acceptance never adds history observations');
  phase='teaching recipe choices and consuming them in the ordinary Shopping editor';
  for(let correction=0;correction<3;correction++) {
    await openTransfer();await page.locator('#recipe-transfer-defaults > summary').click();
    await page.locator('#recipe-transfer-section').selectOption(String(seeded.dry),{force:true});
    await page.locator('#recipe-transfer-store').selectOption(String(seeded.second),{force:true});
    assert.equal(await page.locator('.recipe-transfer-row[data-key="butter"] [data-source="memory"]').count(),0,'explicit destination changes replace automatic memory markers');
    await applyTransfer();
    const evidence=(await memoryState()).entries.find(row=>row.name_key==='butter');
    if(correction===0) {
      assert.equal(evidence.evidence.section.conflicts,true,'an explicit changed destination retains competing history');
      assert.equal(evidence.section_known,false,'one conflicting observation does not produce an overconfident recommendation');
    }
  }
  const explicit=sent.filter(row=>/shopping-transfer$/.test(row.path)).at(-1).body;
  assert.ok(explicit.ingredients.every(row=>JSON.stringify([...row.routing_feedback.fields].sort())===JSON.stringify(['section','stores'])),'only explicit recipe defaults teach');
  await shopping();await createItem();
  await poll(expected=>document.getElementById('shopping-item-section')?.value===String(expected.dry)
    &&document.getElementById('shopping-item-store')?.value===String(expected.second),seeded);
  assert.equal(await page.locator('#shopping-item-quick-add-preview [data-source="memory"] .quick-add-memory-icon svg').count(),2,'ordinary Shopping displays the same automatic AI chips');
  assert.equal(await page.locator('#shopping-item-quick-add-preview [data-source="memory"]').evaluateAll(nodes=>nodes.every(node=>!node.querySelector('button'))),true,'no separate memory acceptance step is introduced');
  if(process.env.NIA_ROUTING_MEMORY_SCREENSHOT)await page.screenshot({path:process.env.NIA_ROUTING_MEMORY_SCREENSHOT,fullPage:false});
  await itemModal.locator('button[data-close-modal="shopping-item-modal"]').click();
  await itemModal.waitFor({state:'hidden'});
  phase='multi-store shared memory round-trip through actual recipe request';
  for(let observation=0;observation<10;observation++) {
    await page.evaluate(async expected=>{
      const {routingMemoryApi}=await import('/static/js/api/routing-memory.js');
      const {shoppingApi}=await import('/static/js/api/shopping.js');
      const state=await routingMemoryApi.read(),event='multi-store-choice-'+expected.observation;
      await shoppingApi.createItem(expected.list,{name:'Butter',section_id:expected.dry,store_ids:[expected.first,expected.second],client_mutation_id:event,routing_feedback:{event_id:event,generation:state.generation,fields:['stores']}});
    },{...seeded,observation});
    const row=(await memoryState()).entries.find(row=>row.name_key==='butter');
    if(row.stores_known&&row.store_ids.length===2)break;
    assert.ok(observation<9,'consistent new explicit store observations eventually meet the conservative confidence threshold');
  }
  await recipe();await openTransfer();
  await poll(()=>document.querySelector('.recipe-transfer-row[data-key="butter"]')?.textContent.includes('First market')&&document.querySelector('.recipe-transfer-row[data-key="butter"]')?.textContent.includes('Second market'));
  await applyTransfer();
  const multi=sent.filter(row=>/shopping-transfer$/.test(row.path)).at(-1).body.ingredients.find(row=>row.ingredient_client_key==='butter');
  assert.deepEqual([...multi.store_ids].sort((a,b)=>a-b),[seeded.first,seeded.second].sort((a,b)=>a-b));
  phase='consistent personal phrase combination autofills ordinary Shopping without teaching itself';
  await page.evaluate(async expected=>{
    const {routingMemoryApi}=await import('/static/js/api/routing-memory.js');
    const {shoppingApi}=await import('/static/js/api/shopping.js');
    const state=await routingMemoryApi.read();
    for(const [index,name] of ['Acme Butter','Butter ungesalzen'].entries()) {
      const event='attested-profile-'+index;
      await shoppingApi.createItem(expected.list,{name,section_id:expected.dry,store_ids:[expected.first,expected.second],client_mutation_id:event,routing_feedback:{event_id:event,generation:state.generation,fields:['list','section','stores']}});
    }
  },seeded);
  await shopping();await createItem();await page.fill('#shopping-item-name','Acme Butter ungesalzen');
  await poll(expected=>document.getElementById('shopping-item-section')?.value===String(expected.dry)
    &&document.querySelector('#shopping-item-quick-add-preview')?.textContent.includes('First market')
    &&document.querySelector('#shopping-item-quick-add-preview')?.textContent.includes('Second market'),seeded);
  assert.equal(await page.locator('#shopping-item-quick-add-preview [data-source="memory"] .quick-add-memory-icon svg').count(),2,'consistent personal phrase combinations use the shared automatic memory badges');
  await page.click('#shopping-item-save-btn');await itemModal.waitFor({state:'hidden'});await queueEmpty();
  const patternWrite=sent.filter(row=>/\/items$/.test(row.path)).at(-1).body;
  assert.deepEqual(patternWrite.routing_feedback.fields,['list'],'phrase-derived section/stores are not counted as user choices');
  assert.equal(patternWrite.section_id,seeded.dry);assert.deepEqual(patternWrite.store_ids,[seeded.first,seeded.second]);
  const patternHistory=(await memoryState()).entries.find(row=>row.name_key==='acme butter ungesalzen');
  assert.equal(patternHistory.evidence.section.observations,0);assert.equal(patternHistory.evidence.stores.observations,0,'saving an automatically routed pattern adds no child-route evidence');
  phase='verifying the shared BrainDump adapter without an LLM or BrainDump entitlement';
  const adapterCode=`
import json,sqlite3,sys
from services.braindump_routes import apply_module_routes
arg=json.loads(sys.argv[1])
db=sqlite3.connect('file:'+arg['db']+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
context={'typed_candidates':True,'supported_modules':['shopping']}
candidate={'module_id':'shopping','title':'Butter','shopping_list_id':arg['list'],'shopping_section_id':None,'shopping_store_ids':[],'explicit_route_fields':[]}
inferred=apply_module_routes(db,arg['actor'],None,{'candidates':[candidate]},context)['candidates'][0]
explicit=apply_module_routes(db,arg['actor'],None,{'candidates':[{**candidate,'shopping_section_id':arg['cold'],'shopping_store_ids':[],'explicit_route_fields':['container','section','stores']}]},context)['candidates'][0]
pattern=apply_module_routes(db,arg['actor'],None,{'candidates':[{**candidate,'title':'Acme Butter ungesalzen'}]},context)['candidates'][0]
form=apply_module_routes(db,arg['actor'],None,{'candidates':[{**candidate,'title':'pflanzliche Butter'}]},context)['candidates'][0]
unknown=apply_module_routes(db,arg['actor'],None,{'candidates':[{**candidate,'title':'beurre'}]},context)['candidates'][0]
print(json.dumps({'inferred':inferred,'explicit':explicit,'pattern':pattern,'form':form,'unknown':unknown}))
`;
  const adapter=await new Promise((resolve,reject)=>{
    const process=spawn(python,['-c',adapterCode,JSON.stringify({db:join(privateDir,'e2e.db'),actor:seeded.user,list:seeded.list,cold:seeded.cold})],{cwd:join(root,'api'),env:{...globalThis.process.env,PYTHONPATH:join(root,'api')},stdio:['ignore','pipe','pipe']});
    let output='',errors='';process.stdout.on('data',chunk=>{output+=chunk;});process.stderr.on('data',chunk=>{errors+=chunk;});process.on('error',reject);process.on('exit',code=>code===0?resolve(JSON.parse(output)):reject(new Error('Read-only BrainDump adapter failed: '+errors)));
  });
  assert.equal(adapter.inferred.shopping_section_id,seeded.dry);assert.deepEqual(adapter.inferred.shopping_store_ids,[seeded.first,seeded.second]);
  assert.equal(adapter.explicit.shopping_section_id,seeded.cold);assert.deepEqual(adapter.explicit.shopping_store_ids,[]);
  for(const route of [adapter.pattern,adapter.form]) {
    assert.equal(route.shopping_section_id,seeded.dry);assert.deepEqual(route.shopping_store_ids,[seeded.first,seeded.second]);
    assert.ok(route.memory_route_fields.includes('section')&&route.memory_route_fields.includes('stores'),'BrainDump receives the same explainable applied-field metadata');
  }
  assert.equal(adapter.unknown.shopping_section_id,null,'no built-in cross-language product alias');
  assert.deepEqual(adapter.unknown.shopping_store_ids,[]);
  phase='normal Tasks and BrainDump share exact personal route evidence';
  const taskTargets=await page.evaluate(async()=>{
    const {http}=await import('/static/js/api/http.js');
    const {projectsApi}=await import('/static/js/api/projects.js');
    const {sectionsApi}=await import('/static/js/api/sections.js');
    const {todosApi}=await import('/static/js/api/todos.js');
    const {routingMemoryApi}=await import('/static/js/api/routing-memory.js');
    const workspaces=(await http.get('/api/workspaces')).workspaces;
    const workspace=workspaces.find(row=>row.is_default)||workspaces[0];
    const first=await projectsApi.create({name:'Household memory',workspace_id:workspace.id});
    const firstSection=await sectionsApi.create(first.id,{name:'Laundry'});
    const second=await projectsApi.create({name:'Daily routines memory',workspace_id:workspace.id});
    const secondSection=await sectionsApi.create(second.id,{name:'Weekly'});
    const state=await routingMemoryApi.read();
    await todosApi.create({title:'Wäsche waschen',project_id:first.id,section_id:firstSection.id,
      client_mutation_id:'normal-task-teaches-memory',routing_feedback:{event_id:'normal-task-teaches-memory',generation:state.generation,fields:['list','section']}});
    for (const [index,title] of ['Wäsche trocknen','Wäsche falten'].entries()) {
      const event='personal-laundry-variant-'+index;
      await todosApi.create({title,project_id:first.id,section_id:firstSection.id,client_mutation_id:event,
        routing_feedback:{event_id:event,generation:state.generation,fields:['list','section']}});
    }
    await todosApi.create({title:'Auto waschen',project_id:second.id,section_id:secondSection.id,
      client_mutation_id:'contrast-task-teaches-memory',routing_feedback:{event_id:'contrast-task-teaches-memory',generation:state.generation,fields:['list','section']}});
    return {workspace:workspace.id,first:first.id,firstSection:firstSection.id,second:second.id,secondSection:secondSection.id};
  });
  // API-created root projects enter the UI through an authoritative snapshot.
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('#boot-overlay').waitFor({state:'hidden',timeout:30000});
  await selectModule('tasks');
  await poll(async expected=>(await window.dbGetAll('projects')).some(row=>row.id===expected.second),taskTargets);
  const todoModal=page.locator('#todo-modal');
  async function openTask(title='Wäsche waschen'){await page.locator('[data-todo-action="new"]').click();await todoModal.waitFor({state:'visible'});await page.fill('#todo-title',title);}
  async function taskFields(project,section){await poll(expected=>document.getElementById('todo-project')?.value===String(expected[0])&&document.getElementById('todo-section')?.value===String(expected[1]),[project,section]);}
  const taskEntry=data=>data.task_entries.find(row=>row.key_kind==='exact'&&row.name_key==='wäsche waschen');
  const taskBefore=taskEntry(await memoryState());
  await openTask('Wäsche machen');await taskFields(taskTargets.first,taskTargets.firstSection);
  assert.equal(await page.locator('#quick-add-preview [data-source="memory"] .quick-add-memory-icon svg').count(),2,'ordinary Tasks use the same automatic AI source badges');
  await page.click('#todo-save-btn');await todoModal.waitFor({state:'hidden'});await queueEmpty();
  const taskWrite=sent.filter(row=>row.path==='/api/todos').at(-1).body;
  assert.deepEqual(taskWrite.routing_feedback.fields,[],'unchanged Task predictions do not teach themselves');
  assert.ok(taskWrite.client_mutation_id,'ordinary offline Task creates carry a stable mutation receipt');
  const taskAfter=taskEntry(await memoryState());
  assert.equal(taskAfter.evidence.list.observations,taskBefore.evidence.list.observations);
  assert.equal(taskAfter.evidence.section.observations,taskBefore.evidence.section.observations);
  // Enable only this disposable fixture account, never an installed service.
  await new Promise((resolve,reject)=>{
    const proc=spawn(python,['-c',"import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('UPDATE users SET braindump_enabled=1 WHERE id=?',(int(sys.argv[2]),)); db.execute(\"INSERT INTO app_config(key,value,updated_at) VALUES ('braindump_enabled','true',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value\"); db.commit(); db.close()",join(privateDir,'e2e.db'),String(seeded.user)],{cwd:join(root,'api'),stdio:['ignore','ignore','pipe']});
    let errors='';proc.stderr.on('data',chunk=>{errors+=chunk;});proc.on('error',reject);proc.on('exit',code=>code===0?resolve():reject(Error(errors||'Private fixture flag update failed')));
  });
  phase='BrainDump corrections update the same Task memory used by normal entry';
  for(let confirmation=0;confirmation<4;confirmation++){
    await page.evaluate(async expected=>{
      const {http}=await import('/static/js/api/http.js');
      const {routingMemoryApi}=await import('/static/js/api/routing-memory.js');
      const state=await routingMemoryApi.read(),event='braindump-task-correction-'+expected.confirmation;
      await http.post('/api/braindump/v2/todos',{workspace_id:expected.workspace,candidates:[{
        module_id:'tasks',title:'Wäsche waschen',project_id:expected.second,section_id:expected.secondSection,
        client_mutation_id:event,explicit_route_fields:['container','section'],
        braindump_route:{original_module_id:'tasks',original_project_id:expected.first,original_section_id:expected.firstSection,original_route_present:true},
        routing_feedback:{event_id:event,generation:state.generation,fields:['list','section']},
      }]});
    },{...taskTargets,confirmation});
    const route=(await memoryState()).task_entries.find(row=>row.name_key==='wäsche waschen'&&row.project_id===taskTargets.second);
    if(route?.list_known&&route.section_known)break;
    assert.ok(confirmation<3,'deliberate Task corrections become reliable in the shared history');
  }
  await openTask();await taskFields(taskTargets.second,taskTargets.secondSection);
  assert.equal(await page.locator('#quick-add-preview [data-source="memory"]').count(),2,'BrainDump corrections immediately drive ordinary Task previews');
  if(process.env.NIA_TASK_MEMORY_SCREENSHOT)await todoModal.screenshot({path:process.env.NIA_TASK_MEMORY_SCREENSHOT});
  await todoModal.locator('button.modal-close-x').click();await todoModal.waitFor({state:'hidden'});

  const beforeReset=await memoryState();
  await page.evaluate(async()=>{const {routingMemoryApi}=await import('/static/js/api/routing-memory.js');await routingMemoryApi.update(false);});
  state=await memoryState();assert.equal(state.enabled,false);assert.deepEqual(state.entries,[]);assert.ok(state.generation>beforeReset.generation);
  await page.evaluate(async()=>{const {routingMemoryApi}=await import('/static/js/api/routing-memory.js');await routingMemoryApi.update(true);await routingMemoryApi.reset();});
  await page.evaluate(async expected=>{const {shoppingApi}=await import('/static/js/api/shopping.js');await shoppingApi.createItem(expected.list,{name:'Stale butter',section_id:expected.cold,store_ids:[],client_mutation_id:'stale-memory-event',routing_feedback:{event_id:'stale-memory-event',generation:expected.generation,fields:['section']}});},{...seeded,generation:beforeReset.generation});
  state=await memoryState();assert.equal(state.enabled,true);assert.deepEqual(state.entries,[],'a pre-reset offline event may save content but cannot recreate forgotten memory');assert.deepEqual(state.task_entries,[],'reset clears both modules through the same memory service');
  assert.deepEqual(client.pageErrors,[]);assert.deepEqual(consoleErrors,[]);
  console.log('✅ Shared routing: real Tasks↔BrainDump and Shopping↔Recipe choices, confidence history, automatic AI badges, variants, multi-store and reset fences passed');
  }
} catch(error) {
  console.error(`Shared routing E2E failed during: ${phase}`);throw error;
} finally {
  try {await client?.browser.close();} finally {await stopChild();await rm(privateDir,{recursive:true,force:true});}
}

// Keep independent scenarios in separate private services. The combined scripted
// request volume would hit the real API's per-IP budget within one minute. Each
// scenario retains production rate limiting and cleans up before the next starts.
if (!typoOnly) {
  const next = spawn(process.execPath, [fileURLToPath(import.meta.url), '--typos'], {cwd:root,env:process.env,stdio:'inherit'});
  const code = await new Promise((resolve,reject)=>{next.on('error',reject);next.on('exit',resolve);});
  assert.equal(code,0,'Independent single-edit E2E scenario must pass');
}

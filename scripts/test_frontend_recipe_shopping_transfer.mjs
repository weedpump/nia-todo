#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { waitForPageCondition } from './browser_page_condition.mjs';

// Real shared window/controller/dropdowns at a private mocked origin. No DB,
// service, LLM or real Shopping API is accessed by this fixture.
const fixture = `
import { initI18n, setLanguagePreference } from '/static/js/i18n/index.js';
import { renderRecipeShoppingTransferModal,createRecipeShoppingTransferFeature } from '/static/js/features/recipe-shopping-transfer.js';
import { createRecipeViewFeature } from '/static/js/features/recipe-view.js';
import { createUiShell } from '/static/js/features/ui-shell.js';
localStorage.setItem('nia-todo-language','de');await initI18n();
document.getElementById('dialogs').innerHTML=renderRecipeShoppingTransferModal();
const ui=createUiShell({showTodoModal(){},renderMarkdown:String});ui.bindModalCloseControls();ui.bindKeyboardShortcuts();
let actor=1,session='1:first',enabled=true,requests=[],queued=[],pending=[],requestGate=null,pendingGate=null,fail=false,pendingReads=0,pendingDone=0;
const recipe={id:8,cookbook_id:1,created_by_user_id:4,revision:1,title:'Read-only Pasta',base_servings:2,can_edit:false,
 ingredient_groups:[{client_key:'group',name:'Sauce',ingredients:[
 {client_key:'pasta',name:'Pasta',quantity_value:100,quantity_unit:'g',quantity_text:'',note:'Bissfest'},
 {client_key:'salt',name:'Salz',quantity_value:null,quantity_unit:'',quantity_text:'nach Geschmack',note:'Nicht skalieren'},
 {client_key:'herbs',name:'<script>unsafe</script>',quantity_value:1,quantity_unit:'TL',quantity_text:'',note:'<b>fresh</b>'}]}],steps:[],tags:[]};
let books=[{id:1,name:'Read-only',can_edit:false,recipes:[recipe]}];
let lists=[{id:10,name:'Haushalt',can_edit:true,sections:[{id:100,name:'Gemüse'},{id:101,name:'Vorrat'}]},
 {id:11,name:'Zweite Liste',can_edit:true,sections:[{id:110,name:'Andere Section'}]}];
let stores=[{id:20,shopping_list_id:10,name:'Markt',active:true},{id:21,shopping_list_id:11,name:'Andere Liste',active:true},
 {id:22,shopping_list_id:10,name:'Inaktiv',active:false}];
const errors=[];
const feature=createRecipeShoppingTransferFeature({getCookbooks:()=>books,getLists:()=>lists,getStores:()=>stores,
 getSessionIdentity:()=>session,getCurrentUser:()=>actor==null?null:{id:actor},canUseShopping:()=>enabled,
 transfer:async(payload,{isCurrent})=>{requests.push(structuredClone(payload));if(requestGate)await requestGate.promise;if(fail)throw new Error('expected transfer failure');return isCurrent()?{client_mutation_id:'operation-'+requests.length,shopping_list_id:payload.shoppingListId,status:'queued'}:null;},
 readPendingTransfers:async()=>{pendingReads++;if(pendingGate)await pendingGate.promise;pendingDone++;return structuredClone(pending);},
 cancelTransfer:async id=>{const entry=pending.find(item=>item.client_mutation_id===id);if(!entry?.can_cancel)return false;pending=pending.filter(item=>item!==entry);return true;},
 onQueued:result=>queued.push(result),onError:error=>errors.push(error.message)});
feature.bind();
const view=createRecipeViewFeature({getCookbooks:()=>books,getActiveCookbookId:()=>1,getSessionIdentity:()=>session,
 getActorId:()=>actor,onTransfer:(recipe,options)=>feature.show(recipe,options)});view.bind();view.selectRecipe(8,{updateNavigation:false});
const defer=()=>{let release;return {promise:new Promise(resolve=>{release=resolve;}),release:()=>release()};};
window.test={feature,view,language:setLanguagePreference,show:()=>feature.show(books[0].recipes[0]),state:()=>({requests,queued,errors,pendingReads,pendingDone}),
 oneList:()=>{lists=[lists[0]];},denyList:()=>{lists[0].can_edit=false;feature.reconcile();},
 changeSource:()=>{books=[{...books[0],recipes:[{...books[0].recipes[0],revision:2}]}];feature.reconcile();},
 evictSource:()=>{books=[];feature.reconcile();},disable:()=>{enabled=false;feature.reconcile();},enable:()=>{enabled=true;lists[0].can_edit=true;},
 setPending:rows=>{pending=rows;},fail:value=>{fail=value;},
 hold:()=>{requestGate=defer();},release:()=>{const old=requestGate;requestGate=null;old?.release();},
 holdPending:()=>{pendingGate=defer();},releasePending:()=>{const old=pendingGate;pendingGate=null;old?.release();},
 equivalent:()=>{books=structuredClone(books);lists=structuredClone(lists);stores=structuredClone(stores);feature.reconcile();},
 changeActor:()=>{actor=2;session='2:second';feature.reconcile();},
};
`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.route('http://recipe-transfer.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/style.css"></head><body><main class="main"><div id="cookbook-navigation-main"></div></main><div id="dialogs"></div><script type="module" src="/fixture.js"></script></body></html>' });
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: fixture });
    if (path.startsWith('/static/')) return route.fulfill({ body: readFileSync(new URL(`../web${path}`, import.meta.url)), contentType: path.endsWith('.json') ? 'application/json' : path.endsWith('.css') ? 'text/css' : 'text/javascript' });
    return route.fulfill({ status: 404, body: 'No real network allowed' });
  });
  const modal = page.locator('#recipe-transfer-modal');
  const ready = () => waitForPageCondition(page, () => document.getElementById('recipe-transfer-form').getAttribute('aria-busy') === 'false');
  const show = async () => { await page.evaluate(() => window.test.show()); await ready(); };
  const choose = async () => { await page.locator('#recipe-transfer-list').selectOption('10', { force: true }); };
  const close = async () => { await modal.locator('.modal-close-x').click(); await modal.waitFor({ state: 'hidden' }); };
  await page.goto('http://recipe-transfer.test/'); await page.waitForFunction(() => Boolean(window.test));
  assert.equal(await page.locator('[data-recipe-action="edit"]').count(), 0);
  await page.locator('[data-recipe-action="more"]').click();
  await page.locator('[data-recipe-action="transfer"]').click(); await ready();
  assert.equal(await page.locator('#recipe-transfer-servings').inputValue(), '3', 'the transfer inherits cooking portions even for read-only recipes');
  assert.equal(await page.locator('#recipe-transfer-list').inputValue(), '', 'several lists require an explicit selection');
  assert.equal(await page.locator('#recipe-transfer-save-btn').isHidden(), true);
  assert.equal(await page.locator('[data-transfer-ingredient]:checked').count(), 3);
  assert.equal(await page.locator('[data-transfer-amount="pasta"]').textContent(), '150 g');
  assert.equal(await page.locator('[data-transfer-amount="salt"]').textContent(), 'nach Geschmack');
  assert.equal(await modal.locator('script').count(), 0, 'ingredient names/notes remain escaped text');
  assert.match(await modal.textContent(), /Bissfest/);
  await choose();
  assert.equal(await page.locator('#recipe-transfer-save-btn').isVisible(), true, 'the initially selected payload does not require a fake dirty edit');
  const portions = page.locator('#recipe-transfer-servings');
  const lessPortions = modal.locator('[data-servings-step="-1"]');
  const morePortions = modal.locator('[data-servings-step="1"]');
  assert.equal(await modal.locator('.recipe-servings').count(), 1, 'the transfer reuses the reading servings control');
  await morePortions.click(); assert.equal(await portions.inputValue(), '4');
  await lessPortions.click(); assert.equal(await portions.inputValue(), '3');
  await portions.fill('1.6666666666666667');
  assert.equal(await page.locator('[data-transfer-amount="pasta"]').textContent(), '83 g');
  await portions.fill('1'); assert.equal(await lessPortions.isDisabled(), true);
  await portions.fill('100000'); assert.equal(await morePortions.isDisabled(), true);
  await portions.fill('3');
  await page.evaluate(() => window.test.language('en'));
  assert.equal(await morePortions.getAttribute('aria-label'), 'More servings');
  assert.equal(await page.locator('#recipe-transfer-servings-label').textContent(), 'Servings');
  await page.evaluate(() => window.test.language('de'));
  await page.locator('#recipe-transfer-servings').focus();
  const servingsPendingRead = await page.evaluate(() => {
    window.transferServingsBeforeRefresh=document.getElementById('recipe-transfer-servings');
    window.test.holdPending();window.test.equivalent();return window.test.state().pendingReads;
  });
  assert.equal(await page.locator('#recipe-transfer-servings').evaluate(input => input === window.transferServingsBeforeRefresh && document.activeElement === input && !input.disabled), true, 'equivalent snapshots preserve the live servings field while the pending read is held');
  assert.equal(await page.locator('#recipe-transfer-form').getAttribute('aria-busy'), 'false');
  await page.evaluate(() => window.test.releasePending());
  await waitForPageCondition(page, count => window.test.state().pendingDone >= count, servingsPendingRead);
  assert.equal(await page.locator('#recipe-transfer-servings').evaluate(input => document.activeElement === input), true, 'background pending completion does not steal servings focus');
  await page.locator('#recipe-transfer-defaults summary').click();
  await page.locator('#recipe-transfer-section').selectOption('100', { force: true });
  await page.locator('#recipe-transfer-store').selectOption('20', { force: true });
  const sectionTrigger = page.locator('[data-select-id="recipe-transfer-section"] .ui-select-trigger');
  await sectionTrigger.click();
  await page.locator('#recipe-transfer-section-ui-menu [role="option"]').first().focus();
  const menuPendingRead = await page.evaluate(() => {
    window.transferMenuBeforeRefresh=document.getElementById('recipe-transfer-section-ui-menu');
    window.transferMenuRowBeforeRefresh=document.activeElement;
    window.test.holdPending();window.test.equivalent();return window.test.state().pendingReads;
  });
  assert.equal(await sectionTrigger.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.evaluate(() => document.getElementById('recipe-transfer-section-ui-menu') === window.transferMenuBeforeRefresh && window.transferMenuRowBeforeRefresh.isConnected && document.activeElement === window.transferMenuRowBeforeRefresh), true, 'equivalent target options retain the actual open menu row while the pending read is held');
  await page.evaluate(() => window.test.releasePending());
  await waitForPageCondition(page, count => window.test.state().pendingDone >= count, menuPendingRead);
  assert.equal(await sectionTrigger.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.evaluate(() => window.transferMenuRowBeforeRefresh.isConnected && document.activeElement === window.transferMenuRowBeforeRefresh), true, 'background pending completion neither rerenders the menu nor redirects its focus');
  await page.keyboard.press('Escape');
  assert.equal(await sectionTrigger.getAttribute('aria-expanded'), 'false');
  const salt = modal.locator('.recipe-transfer-row[data-key="salt"]');
  await salt.locator('summary').click();
  assert.equal(await salt.locator('[data-target="store"] option[value="21"]').count(), 0, 'stores are scoped to the selected list');
  assert.equal(await salt.locator('[data-target="store"] option[value="22"]').count(), 0, 'inactive stores are unavailable');
  await salt.locator('[data-target="section"]').selectOption('101', { force: true });
  await salt.locator('[data-target="store"]').selectOption('', { force: true });
  await page.locator('[data-transfer-ingredient="herbs"]').uncheck();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await modal.locator('.modal-content').evaluate(node => node.scrollWidth <= node.clientWidth), true, `transfer fits at ${width}px`);
  }
  await page.locator('#recipe-transfer-save-btn').click(); await modal.waitFor({ state: 'hidden' });
  const payload = (await page.evaluate(() => window.test.state())).requests[0];
  assert.deepEqual(payload, { recipeId: 8, shoppingListId: 10, servings: 3, ingredients: [
    { ingredient_client_key: 'pasta', section_id: 100, store_ids: [20] },
    { ingredient_client_key: 'salt', section_id: 101, store_ids: [] },
  ] });
  await waitForPageCondition(page, () => window.test.state().queued.length === 1);

  await page.evaluate(() => window.test.oneList()); await show();
  assert.equal(await page.locator('#recipe-transfer-list').inputValue(), '10');
  await page.locator('#recipe-transfer-select-all').click();
  assert.equal(await page.locator('[data-transfer-ingredient]:checked').count(), 0);
  assert.equal(await page.locator('#recipe-transfer-save-btn').isHidden(), true);
  await page.locator('#recipe-transfer-select-all').click();
  await page.evaluate(() => window.test.fail(true)); await page.locator('#recipe-transfer-save-btn').click();
  await ready(); assert.equal(await modal.isVisible(), true); assert.equal(await page.locator('[data-transfer-ingredient]:checked').count(), 3);
  assert.equal(await page.locator('#recipe-transfer-save-btn').isVisible(), true);
  await page.evaluate(() => window.test.fail(false)); await close();

  await page.evaluate(() => window.test.setPending([{ client_mutation_id: 'blocked', recipe_id: 8, status: 'blocked', can_cancel: true }]));
  await show(); assert.equal(await page.locator('#recipe-transfer-save-btn').isHidden(), true);
  await page.locator('[data-cancel-transfer]').click(); await ready();
  assert.equal(await page.locator('#recipe-transfer-save-btn').isVisible(), true, 'removing blocked intent permits a fresh transfer');
  await close();
  await page.evaluate(() => window.test.setPending([{ client_mutation_id: 'attempted', recipe_id: 8, status: 'queued', can_cancel: false }]));
  await show(); assert.equal(await page.locator('[data-cancel-transfer]').count(), 0);
  assert.equal(await morePortions.isDisabled(), true, 'a queued transfer disables the servings buttons');
  assert.equal(await page.locator('#recipe-transfer-save-btn').isHidden(), true); await close();
  await page.evaluate(() => window.test.setPending([]));

  await show(); await page.evaluate(() => window.test.changeSource());
  await ready(); assert.equal(await page.locator('#recipe-transfer-save-btn').isHidden(), true, 'source changes freeze the snapshot rather than transferring stale ingredients');
  await close(); await show();
  assert.equal(await page.locator('#recipe-transfer-save-btn').isVisible(), true, 'reopening captures the current source');
  await page.evaluate(() => window.test.hold()); await page.locator('#recipe-transfer-save-btn').click();
  assert.equal(await page.locator('#recipe-transfer-form').getAttribute('aria-busy'), 'true');
  const beforeActorChange = await page.evaluate(() => window.test.state().queued.length);
  await page.evaluate(() => { window.test.changeActor();window.test.release(); });
  await modal.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.test.state().queued.length), beforeActorChange, 'a delayed enqueue receipt cannot affect another account');
  await show(); await page.evaluate(() => window.test.denyList()); await ready();
  assert.equal(await page.locator('#recipe-transfer-save-btn').isHidden(), true); await close();
  await show(); await page.evaluate(() => window.test.disable()); await modal.waitFor({ state: 'hidden' });
  await page.evaluate(() => window.test.enable()); await show();
  await page.evaluate(() => window.test.evictSource()); await modal.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.test.state().errors), ['expected transfer failure']);
  console.log('✅ Recipe transfer selection, scaled preview, targets, pending intents and lifecycle guards passed');
} finally { await browser.close(); }

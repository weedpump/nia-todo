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
 seedFlour:(different=false)=>{books[0].recipes=[{...recipe,ingredient_groups:[{client_key:'dough',name:'Teig',ingredients:[{client_key:'flour-dough',name:'Mehl',quantity_value:.25,quantity_unit:'kg',note:different?'Type 405':'gesiebt'}]},{client_key:'surface',name:'Arbeitsfläche',ingredients:[{client_key:'flour-surface',name:'Mehl',quantity_value:100,quantity_unit:'grams',note:different?'Type 1050':'gesiebt'}]}],steps:[{ingredients:[{ingredient_client_key:'flour-dough'},{ingredient_client_key:'flour-dough'}]}]}];},
 restoreRecipe:()=>{books[0].recipes=[structuredClone(recipe)];},
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
const browser = await chromium.launch({ headless: true, ...(process.env.NIA_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.NIA_TEST_BROWSER_EXECUTABLE } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.route('http://recipe-transfer.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/style.css"></head><body><main class="main"><div id="cookbook-navigation-main"></div></main><div id="dialogs"></div><script type="module" src="/fixture.js"></script></body></html>' });
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
  assert.equal(await page.locator('#recipe-transfer-sources').count(), 0, 'there is no second global ingredient list');
  assert.equal(await page.locator('.recipe-transfer-summary-row:visible').count(), 3, 'one visible checklist combines selection and quantities');
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
    assert.equal(await page.locator('.recipe-transfer-summary').evaluate(node => node.getBoundingClientRect().top - document.querySelector('#recipe-transfer-defaults .recipe-transfer-targets').getBoundingClientRect().bottom >= 12),true,`expanded defaults keep a clear gap before ingredients at ${width}px`);
  }
  await page.locator('#recipe-transfer-save-btn').click(); await modal.waitFor({ state: 'hidden' });
  const payload = (await page.evaluate(() => window.test.state())).requests[0];
  assert.deepEqual(payload, { recipeId: 8, shoppingListId: 10, servings: 3, ingredients: [
    { ingredient_client_key: 'pasta', section_id: 100, store_ids: [20] },
    { ingredient_client_key: 'salt', section_id: 101, store_ids: [] },
  ] });
  await waitForPageCondition(page, () => window.test.state().queued.length === 1);

  await page.evaluate(() => {window.test.oneList();window.test.seedFlour();});await show();
  assert.equal(await page.locator('.recipe-transfer-summary-row').count(),1,'same product across recipe groups consolidates automatically');
  assert.equal(await page.locator('.recipe-transfer-summary-amount').textContent(),'350 g','compatible kg/g source quantities sum once, independently of repeated step references');
  assert.equal(await page.locator('[data-transfer-combine]').count(),0,'identical notes use the existing automatic backend contract');
  assert.equal(await page.evaluate(()=>window.test.feature.getDraft().ingredients.every(row=>!Object.hasOwn(row,'merge_group'))),true);
  await close();await page.evaluate(()=>window.test.seedFlour(true));await show();
  assert.equal(await page.locator('.recipe-transfer-summary-row').count(),1,'different notes combine by default');
  const productDetails=page.locator('.recipe-transfer-sources');
  assert.equal(await productDetails.getAttribute('open'),null,'original source lines start collapsed under their product');
  assert.equal(await page.locator('[data-transfer-separate]').count(),1,'a single toggle offers explicit separation');
  assert.equal(await page.locator('[data-transfer-combine]').count(),0);
  let grouped=await page.evaluate(()=>window.test.feature.getDraft());
  assert.deepEqual(grouped.ingredients.map(row=>row.ingredient_client_key),['flour-dough','flour-surface']);
  assert.equal(new Set(grouped.ingredients.map(row=>row.merge_group)).size,1);assert.ok(grouped.ingredients.every(row=>typeof row.merge_group==='string'));
  await portions.fill('4');assert.equal(await page.locator('.recipe-transfer-summary-amount').textContent(),'700 g','round only after summing and scaling sources');
  await page.locator('[data-transfer-keys]').uncheck();
  assert.equal(await page.locator('.recipe-transfer-summary-row').count(),1,'unchecked products remain available in the same checklist');
  assert.equal(await page.locator('#recipe-transfer-save-btn').isHidden(),true);
  await page.locator('[data-transfer-keys]').check();
  assert.equal(await page.locator('#recipe-transfer-save-btn').isVisible(),true);
  await productDetails.locator(':scope > summary').click();
  assert.match(await productDetails.textContent(),/Type 405/);assert.match(await productDetails.textContent(),/Type 1050/);
  await page.locator('[data-transfer-ingredient="flour-surface"]').uncheck();
  assert.equal(await page.locator('.recipe-transfer-summary-amount').textContent(),'500 g');
  assert.equal(await page.locator('[data-transfer-keys]').evaluate(input=>input.indeterminate),true,'partial source selection is represented on the parent checkbox');
  assert.equal(await page.locator('[data-transfer-ingredient="flour-surface"]').evaluate(input=>input===document.activeElement),true,'source selection retains keyboard focus');
  assert.notEqual(await productDetails.getAttribute('open'),null,'source details stay open while selecting');
  assert.deepEqual((await page.evaluate(()=>window.test.feature.getDraft())).ingredients.map(row=>row.ingredient_client_key),['flour-dough']);
  await page.locator('[data-transfer-ingredient="flour-surface"]').check();
  assert.equal(await page.locator('.recipe-transfer-summary-amount').textContent(),'700 g');
  assert.equal(await page.locator('[data-transfer-keys]').evaluate(input=>input.indeterminate),false);
  await page.evaluate(()=>window.test.language('en'));
  assert.equal(await page.locator('[data-transfer-separate]').textContent(),'Keep separate');
  assert.notEqual(await productDetails.getAttribute('open'),null,'language changes preserve the expanded source selection');
  await page.evaluate(()=>window.test.language('de'));
  await page.locator('[data-transfer-separate]').focus();await page.locator('[data-transfer-separate]').press('Enter');
  assert.equal(await page.locator('.recipe-transfer-summary-row').count(),2);
  assert.equal(await page.locator('[data-transfer-combine]').evaluate(button=>button===document.activeElement),true,'toggling grouping retains keyboard focus');
  assert.equal(await page.evaluate(()=>window.test.feature.getDraft().ingredients.every(row=>!Object.hasOwn(row,'merge_group'))),true);
  await portions.fill('3');
  assert.equal(await page.locator('.recipe-transfer-summary-row').count(),2,'portion edits preserve explicit separation');
  await page.evaluate(()=>window.test.equivalent());await ready();
  assert.equal(await page.locator('.recipe-transfer-summary-row').count(),2,'equivalent snapshots preserve explicit separation');
  await page.locator('[data-transfer-combine]').click();
  assert.equal(await page.locator('[data-transfer-separate]').evaluate(button=>button===document.activeElement),true,'regrouping retains keyboard focus on the toggle');
  await portions.fill('4');
  if(!await productDetails.evaluate(node=>node.open))await productDetails.locator(':scope > summary').click();
  assert.equal(await productDetails.locator('.recipe-transfer-corrections').count(),1,'combined ingredients expose one shared target editor');
  assert.equal(await productDetails.locator('.recipe-transfer-source-row .recipe-transfer-corrections').count(),0,'original source rows do not duplicate the target editor');
  const commonTargets=productDetails.locator('.recipe-transfer-corrections');
  await commonTargets.locator(':scope > summary').click();
  assert.notEqual(await commonTargets.evaluate(node=>getComputedStyle(node).backgroundColor),'rgba(0, 0, 0, 0)','expanded target editor has a background');
  await commonTargets.locator('[data-select-id$="-section"] .ui-select-trigger').click();
  await page.getByRole('option',{name:'Vorrat',exact:true}).click();
  assert.equal(await page.locator('.recipe-transfer-summary-row').count(),1,'editing the shared target keeps the ingredients combined');
  assert.equal(await page.evaluate(()=>window.test.feature.getDraft().ingredients.every(row=>row.section_id===101)),true,'shared section applies to every original source');
  assert.equal(await commonTargets.locator('[data-select-id$="-section"] .ui-select-trigger').evaluate(node=>node===document.activeElement),true,'shared target changes retain dropdown focus');
  await commonTargets.locator('[data-select-id$="-store"] .ui-select-trigger').click();
  await page.getByRole('option',{name:'Markt',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.test.feature.getDraft().ingredients.every(row=>JSON.stringify(row.store_ids)==='[20]')),true,'shared store applies to every original source');
  for(const width of [1280,390,320]) {
    await page.setViewportSize({width,height:900});
    const gap=await page.locator('.recipe-transfer-product').evaluate(node=>node.querySelector('.recipe-transfer-combine').getBoundingClientRect().top-node.querySelector('.recipe-transfer-sources').getBoundingClientRect().bottom);
    assert.ok(gap>=12,`expanded details leave a gap before the separate button at ${width}px`);
  }
  await page.locator('[data-transfer-separate]').click();
  assert.equal(await page.locator('.recipe-transfer-corrections').count(),2,'separated ingredients have independent target editors');
  const flourSingle=page.locator('.recipe-transfer-row[data-key="flour-surface"]');
  await flourSingle.locator('.recipe-transfer-corrections > summary').click();
  await flourSingle.locator('[data-select-id$="-section"] .ui-select-trigger').click();
  await page.getByRole('option',{name:'Vorgaben verwenden',exact:true}).click();
  assert.equal(await page.locator('.recipe-transfer-summary-row').count(),2,'different destinations cannot be grouped');
  assert.equal(await page.locator('[data-transfer-separate],[data-transfer-combine]').count(),0);
  assert.equal(await flourSingle.locator('[data-select-id$="-section"] .ui-select-trigger').evaluate(button=>button===document.activeElement),true,'independent target changes retain trigger focus');
  await flourSingle.locator('[data-select-id$="-section"] .ui-select-trigger').click();
  await page.getByRole('option',{name:'Vorrat',exact:true}).click();
  assert.equal(await page.locator('.recipe-transfer-summary-row').count(),1,'matching destinations restore the default combined row');
  assert.notEqual(await productDetails.getAttribute('open'),null,'regrouping exposes the shared target editor');
  assert.notEqual(await commonTargets.getAttribute('open'),null,'the shared target stays expanded after regrouping');
  assert.equal(await commonTargets.locator('[data-select-id$="-section"] .ui-select-trigger').evaluate(button=>button===document.activeElement),true,'regrouping from a non-first source keeps focus on the shared target trigger');
  assert.equal(await page.locator('.ui-select-menu:not([hidden])').count(),0,'choosing a source target leaves no detached dropdown menu');
  for(const width of [1280,390,320]){await page.setViewportSize({width,height:900});assert.equal(await modal.locator('.modal-content').evaluate(node=>node.scrollWidth<=node.clientWidth),true,`consolidated preview fits at ${width}px`);}
  await page.locator('#recipe-transfer-save-btn').click();await modal.waitFor({state:'hidden'});
  grouped=(await page.evaluate(()=>window.test.state())).requests.at(-1);
  assert.deepEqual(grouped.ingredients.map(row=>row.ingredient_client_key),['flour-dough','flour-surface'],'submission preserves each original provenance key');
  assert.ok(grouped.ingredients.every(row=>row.merge_group===grouped.ingredients[0].merge_group));
  await page.evaluate(()=>window.test.restoreRecipe());

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

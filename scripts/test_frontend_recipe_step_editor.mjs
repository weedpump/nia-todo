#!/usr/bin/env node
// Private mocked origin and disposable browser IndexedDB only; no Nia service/SQLite.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { waitForPageCondition } from './browser_page_condition.mjs';

const fixture = `
import { initI18n, setLanguagePreference, t } from '/static/js/i18n/index.js';
import { renderRecipeEditorModal, createRecipeEditorFeature } from '/static/js/features/recipe-editor.js';
import { createRecipeController } from '/static/js/features/recipe-mutations.js';
import { validateRecipeChanges, sanitizeRecipeEntry, projectRecipeCookbook, mergeRecipeStepIngredients } from '/static/js/features/recipe-pending.js';
import { hasOpenUiLayer } from '/static/js/features/ui-history.js';
import * as storage from '/static/js/storage/indexed-db.js';
localStorage.setItem('nia-todo-language', 'de'); await initI18n(); await storage.openDatabase();
document.body.insertAdjacentHTML('beforeend', renderRecipeEditorModal());
const special = 'Salz <img src=x onerror="window.stepXss=true"> – 盐';
const recipe = { id: 101, cookbook_id: 1, title: 'Recipe', description: '', base_servings: 2, tags: [],
 revision: 1, can_edit: true, created_by_user_id: 11, client_mutation_id: 'recipe-101',
 ingredient_groups: [{client_key:'g1',name:'Main',ingredients:[
 {client_key:'i1',name:'Flour',quantity_value:100,quantity_unit:'g'},
 {client_key:'i-盐<>',name:special,quantity_text:'nach Geschmack',note:''}]},
 {client_key:'g2',name:'Finish',ingredients:[{client_key:'i3',name:'Oil',quantity_value:1,quantity_unit:'tbsp'}]}],
 steps:[{client_key:'s1',text:'Mix'}, {client_key:'s2',text:'Serve'}] };
let writes=0;
let books=[{id:1,name:'Book',can_edit:true,can_manage:true,created_by_user_id:11,recipes:[recipe]}], session='11:one', editor, held, release, sequence=0;
const errors=[], mutations=[];
await storage.put('cookbooks',books[0]);
const controller=createRecipeController({getCookbooks:()=>books,setCookbooks:value=>{books=value;editor?.reconcile();},
 getSessionIdentity:()=>session,getCurrentUser:()=>({id:11}),createTempId:()=> 'temp-step-'+(++sequence),
 commitMutation:async build=>{writes++;try{if(held)await held;const mutation=build();if(mutation){await storage.commitRecipeMutation(mutation);mutations.push(structuredClone(mutation));}return mutation;}finally{writes--;}}});
editor=createRecipeEditorFeature({getCookbooks:()=>books,recipeController:controller,getSessionIdentity:()=>session,onError:err=>errors.push(err.message)});
editor.bind(); editor.showEdit(101);
window.stepTest={editor,controller,storage,mutations,errors,special,t,pending:()=>writes,hasOpenUiLayer,validateRecipeChanges,sanitizeRecipeEntry,setLanguagePreference,
 books:()=>structuredClone(books),queue:()=>storage.getAll('syncQueue'),draft:()=>editor.getDraft(),
 hold:()=>{held=new Promise(done=>{release=done;});},release:()=>{held=null;release?.();},
 permission:value=>{books=books.map(book=>({...book,can_edit:value,recipes:book.recipes.map(recipe=>({...recipe,can_edit:value}))}));editor.reconcile();},
 session:value=>{session=value;editor.reconcile();},
 legacy:async()=>{
   const source={...structuredClone(recipe),id:102,cookbook_id:2,steps:[
     {client_key:'s1',text:'Canonical',ingredients:[{ingredient_client_key:'i1',show_quantity:true},{ingredient_client_key:'i-盐<>',show_quantity:false}]},
     {client_key:'s2',text:'Second',ingredients:[]}]};
   const canonical={id:2,name:'Restored',can_edit:true,can_manage:true,created_by_user_id:11,recipes:[source]};
   const entry={id:555,action:'UPDATE_RECIPE',actor_id:11,attempted:true,data:{id:102,cookbook_id:2,expected_revision:1,client_mutation_id:'legacy-attempted',
     changes:{steps:[{client_key:'s1',text:'Older offline text'},{client_key:'s2',text:'Second'}]}}};
   const before=JSON.stringify(entry);
   books=[projectRecipeCookbook(canonical,[entry])]; session='11:legacy';
   await storage.put('cookbooks',books[0]); await storage.put('syncQueue',entry);
   const retained=books[0].recipes[0].steps[0].ingredients;
   const groups=[{client_key:'g1',name:'',ingredients:[source.ingredient_groups[0].ingredients[1]]}];
   const inherited=mergeRecipeStepIngredients(source,{ingredient_groups:groups,steps:[{client_key:'s1',text:'Changed'}]}).steps[0].ingredients;
   const omittedSteps=mergeRecipeStepIngredients(source,{ingredient_groups:groups}).steps[0].ingredients;
   const explicit=mergeRecipeStepIngredients(source,{steps:[{client_key:'s1',text:'Changed',ingredients:[]}]}).steps[0].ingredients;
   const bad=mergeRecipeStepIngredients(source,{ingredient_groups:groups,steps:[{client_key:'s1',text:'Changed',ingredients:[{ingredient_client_key:'i1',show_quantity:true}]}]});
   const conflict=projectRecipeCookbook(canonical,[{...entry,conflict:{server:source,local:{...source,steps:entry.data.changes.steps},operation:'update'}}]);
   await controller.update(102,{steps:[{client_key:'s1',text:'Immediate offline controller edit'},{client_key:'s2',text:'Second'}]});
   const immediate=controller.getRecipe(102).steps[0].ingredients;
   const immediateBodyOmitted=!Object.hasOwn((await storage.getAll('syncQueue')).filter(row=>row.data.id===102).at(-1).data.changes.steps[0],'ingredients');
   editor.showEdit(102);
   return {retained,inherited,omittedSteps,immediate,immediateBodyOmitted,explicit,badRejected:validateRecipeChanges(bad,true)===null,
     conflict:conflict.recipes[0].conflict.local.steps[0].ingredients,unchanged:before===JSON.stringify(entry)};
 }};
`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const step = key => page.locator(`.recipe-editor-step[data-key="${key}"]`);
const toggle = key => step(key).locator('[data-recipe-editor-action="step-ingredients-toggle"]');
const openPicker = async key => { if (!await step(key).locator('details').evaluate(node => node.open)) await toggle(key).click(); };
const choice = (key, index) => step(key).locator('[data-step-ingredient]').nth(index);
const partial = (key, index) => step(key).locator('[data-step-ingredient-partial]').nth(index);
const draft = () => page.evaluate(() => window.stepTest.draft());
const links = async key => (await draft()).steps.find(row => row.client_key === key).ingredients;
const closed = () => waitForPageCondition(page, () => !document.getElementById('recipe-modal').classList.contains('active') && !window.stepTest.hasOpenUiLayer());
try {
  await page.route('http://recipe-step-editor.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/style.css"></head><body><script type="module" src="/fixture.js"></script></body></html>'});
    if (path === '/fixture.js') return route.fulfill({contentType:'text/javascript',body:fixture});
    if (path.startsWith('/static/')) {
      try { return route.fulfill({body:readFileSync(new URL(`../web${path}`,import.meta.url)),contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.json')?'application/json':path.endsWith('.css')?'text/css':'application/octet-stream'}); }
      catch { return route.fulfill({status:404,body:`Missing fixture asset ${path}`}); }
    }
    return route.fulfill({status:404,body:'No service in this fixture'});
  });
  await page.goto('http://recipe-step-editor.test/');
  await waitForPageCondition(page, () => Boolean(window.stepTest));
  assert.equal(await page.locator('#recipe-save-btn').isVisible(), false, 'legacy missing arrays do not make the editor dirty');
  assert.deepEqual((await draft()).steps.map(row => row.ingredients), [[], []], 'legacy steps receive empty editor link arrays only');
  assert.equal(await page.locator('.recipe-editor-step-ingredients[open]').count(), 0);
  await step('s1').locator('textarea').fill('Draft heading\nKeep this multiline text.');
  await page.evaluate(() => { window.originalStepTextarea=document.querySelector('.recipe-editor-step[data-key="s1"] textarea'); });
  await openPicker('s1');
  assert.equal(await choice('s1', 0).isChecked(), false);
  assert.equal(await choice('s1', 1).locator('..').locator('..').textContent().then(text => text.includes('盐')), true);
  assert.equal(await page.locator('[data-step-picker-content] img').count(), 0, 'ingredient names stay text');
  assert.equal(await page.evaluate(() => Boolean(window.stepXss)), false);
  await choice('s1', 0).check(); await partial('s1', 0).check();
  await choice('s1', 1).check(); await choice('s1', 1).uncheck();
  assert.deepEqual(await links('s1'), [{ingredient_client_key:'i1',show_quantity:false}]);
  assert.deepEqual(await links('s2'), [], 'adding a link never assigns another step automatically');
  assert.equal(await page.evaluate(() => window.originalStepTextarea===document.querySelector('.recipe-editor-step[data-key="s1"] textarea')), true, 'picker changes retain the textarea node and draft');
  assert.equal(await step('s1').locator('textarea').inputValue(), 'Draft heading\nKeep this multiline text.');
  await openPicker('s2'); await choice('s2', 0).check();
  assert.deepEqual(await links('s2'), [{ingredient_client_key:'i1',show_quantity:true}], 'reuse leaves the explicit source flag intact');
  assert.equal((await page.evaluate(() => window.stepTest.queue())).length, 0, 'picker choices are draft edits, not backend writes');

  // Editing source names refreshes only picker labels; links follow stable keys.
  await page.locator('.recipe-editor-ingredient[data-key="i1"] [data-recipe-editor-action="ingredient-edit"]').click();
  await page.locator('.recipe-editor-ingredient[data-key="i1"] [data-field="name"]').fill('New flour – мука');
  assert.equal(await choice('s1', 0).locator('..').locator('..').textContent().then(text => text.includes('New flour – мука')), true);
  assert.deepEqual(await links('s1'), [{ingredient_client_key:'i1',show_quantity:false}]);
  await page.locator('.recipe-editor-ingredient[data-key="i1"] [data-recipe-editor-action="ingredient-done"]').click();
  await step('s1').locator('[data-recipe-editor-action="step-down"]').click();
  assert.deepEqual((await draft()).steps.map(row => row.client_key), ['s2','s1']);
  assert.equal((await draft()).steps[1].text, 'Draft heading\nKeep this multiline text.');
  assert.deepEqual(await links('s1'), [{ingredient_client_key:'i1',show_quantity:false}]);
  await openPicker('s1'); await choice('s1', 2).check();
  await page.locator('.recipe-editor-group[data-key="g2"] [data-recipe-editor-action="group-remove"]').click();
  assert.deepEqual(await links('s1'), [{ingredient_client_key:'i1',show_quantity:false}], 'removing a group prunes its ingredient references');
  await page.locator('.recipe-editor-ingredient[data-key="i1"] [data-recipe-editor-action="ingredient-edit"]').click();
  await page.locator('.recipe-editor-ingredient[data-key="i1"] [data-recipe-editor-action="ingredient-remove"]').click();
  assert.deepEqual(await links('s1'), []); assert.deepEqual(await links('s2'), [], 'removing an ingredient prunes every step');
  await openPicker('s1'); await choice('s1', 0).check();
  await page.click('#recipe-save-btn'); await closed();
  const queue = await page.evaluate(() => window.stepTest.queue());
  assert.deepEqual(queue[0].data.changes.steps.map(row => [row.client_key,row.ingredients]), [
    ['s2',[]],['s1',[{ingredient_client_key:'i-盐<>',show_quantity:true}]],
  ], 'queued payload contains only ordered stable links and flags');
  await page.evaluate(() => window.stepTest.editor.showEdit(101));
  assert.equal(await page.locator('#recipe-save-btn').isVisible(), false, 'reopening a queued linked recipe has no phantom dirty state');
  assert.equal(await page.locator('.recipe-editor-step-ingredients[open]').count(), 0, 'a reopened editor starts with collapsed assignment pickers');
  await openPicker('s1'); assert.equal(await choice('s1',0).isChecked(), true);
  assert.equal(await choice('s1',0).isDisabled(), false);
  assert.equal(await partial('s1',0).isDisabled(), false, 'selected ingredient partial control is enabled after reopen');
  await partial('s1',0).check();
  await step('s2').locator('[data-recipe-editor-action="step-remove"]').click();
  assert.deepEqual((await draft()).steps.map(row=>row.client_key), ['s1']);

  for (const width of [1280,390,320]) {
    await page.setViewportSize({width,height:900});
    await openPicker('s1');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth), true, `no body overflow at ${width}`);
    assert.equal(await choice('s1',0).evaluate(input=>input.closest('label').getBoundingClientRect().height>=44), true);
  }
  const beforeLanguage = await step('s1').locator('textarea').inputValue();
  await page.evaluate(() => window.stepTest.setLanguagePreference('en'));
  assert.ok((await toggle('s1').textContent()).includes(await page.evaluate(() => window.stepTest.t('recipe.step.ingredients.assign'))));
  assert.equal(await step('s1').locator('textarea').inputValue(), beforeLanguage);
  assert.deepEqual(await links('s1'), [{ingredient_client_key:'i-盐<>',show_quantity:false}]);
  await page.evaluate(() => window.stepTest.permission(false));
  assert.equal(await choice('s1',0).isDisabled(), true); assert.equal(await partial('s1',0).isDisabled(), true);
  assert.equal(await toggle('s1').getAttribute('aria-disabled'), 'true');
  await page.evaluate(() => window.stepTest.permission(true));
  assert.equal(await choice('s1',0).isDisabled(), false);
  await page.keyboard.press('Escape'); await closed(); // Content details must not consume the modal Escape.
  await page.evaluate(() => window.stepTest.editor.showEdit(101));
  await openPicker('s1'); await partial('s1',0).check();
  const beforeHeld = await page.evaluate(() => window.stepTest.queue());
  await page.evaluate(() => window.stepTest.hold()); await page.click('#recipe-save-btn');
  assert.equal(await choice('s1',0).isDisabled(), true, 'pending save disables assignment controls');
  await page.evaluate(() => window.stepTest.session(null)); await closed();
  await page.evaluate(() => window.stepTest.release());
  await waitForPageCondition(page, () => window.stepTest.pending() === 0);
  assert.deepEqual(await page.evaluate(() => window.stepTest.queue()), beforeHeld, 'account change fences a held write');

  const checks = await page.evaluate(() => {
    const {validateRecipeChanges:valid,sanitizeRecipeEntry:sanitize}=window.stepTest;
    const base={title:'X',ingredient_groups:[{client_key:'g',name:'',ingredients:[{client_key:'i',name:'A'}]}],steps:[{client_key:'s',text:'A'}]};
    const explicit=links=>({...base,steps:[{...base.steps[0],ingredients:links}]});
    const attempted={action:'UPDATE_RECIPE',attempted:true,data:{id:1,cookbook_id:1,expected_revision:1,client_mutation_id:'attempted',changes:{steps:base.steps}}};
    return {legacy:valid(base,true).steps[0].ingredients,
      patchMissing:Object.hasOwn(valid({steps:base.steps}).steps[0],'ingredients'),
      unknown:valid(explicit([{ingredient_client_key:'other'}]),true),duplicate:valid(explicit([{ingredient_client_key:'i'},{ingredient_client_key:'i'}]),true),
      badFlag:valid(explicit([{ingredient_client_key:'i',show_quantity:0}]),true),extra:valid(explicit([{ingredient_client_key:'i',quantity_value:1}]),true),
      defaultFlag:valid(explicit([{ingredient_client_key:'i'}]),true).steps[0].ingredients[0].show_quantity,
      immutable:JSON.stringify(sanitize(attempted).data.changes.steps)===JSON.stringify(base.steps)};
  });
  assert.deepEqual(checks,{legacy:[],patchMissing:false,unknown:null,duplicate:null,badFlag:null,extra:null,defaultFlag:true,immutable:true});
  // Restoring an older durable PATCH must inherit canonical step links locally,
  // so opening and saving another offline draft cannot turn omission into [].
  const legacy = await page.evaluate(() => window.stepTest.legacy());
  const inheritedLinks = [{ingredient_client_key:'i1',show_quantity:true},{ingredient_client_key:'i-盐<>',show_quantity:false}];
  assert.deepEqual(legacy,{retained:inheritedLinks,inherited:[inheritedLinks[1]],omittedSteps:[inheritedLinks[1]],immediate:inheritedLinks,immediateBodyOmitted:true,explicit:[],badRejected:true,conflict:inheritedLinks,unchanged:true});
  assert.deepEqual(await links('s1'), inheritedLinks, 'editor receives inherited canonical links after a restored legacy PATCH');
  assert.equal(await page.locator('#recipe-save-btn').isVisible(), false);
  await step('s1').locator('textarea').fill('Another offline edit');
  await page.click('#recipe-save-btn'); await closed();
  const restoredQueue = await page.evaluate(() => window.stepTest.queue());
  const old = restoredQueue.find(row => row.data.client_mutation_id==='legacy-attempted');
  assert.equal(old.attempted,true);
  assert.equal(Object.hasOwn(old.data.changes.steps[0],'ingredients'),false,'attempted legacy request is never rewritten');
  const followup = restoredQueue.filter(row=>row.action==='UPDATE_RECIPE'&&row.data.id===102).at(-1);
  assert.notEqual(followup.id,old.id);
  assert.deepEqual(followup.data.changes.steps[0].ingredients,inheritedLinks,'next offline step edit persists retained links rather than clearing them');
  assert.deepEqual(await page.evaluate(() => window.stepTest.errors), []); assert.deepEqual(errors, []);
  console.log('✅ Recipe step editor: stable links, pruning, offline payload, language, mobile and lifecycle guards');
} finally { await browser.close(); }

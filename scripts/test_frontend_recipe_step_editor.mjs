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
editor=createRecipeEditorFeature({getCookbooks:()=>books,recipeController:controller,getSessionIdentity:()=>session,getBrainDumpAccess:()=>true,onError:err=>errors.push(err.message)});
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
const openPicker = async key => { if (!await step(key).locator('.recipe-editor-step-ingredients').evaluate(node => node.open)) await toggle(key).click(); };
const openGroups = async key => { await openPicker(key); for (const group of await step(key).locator('[data-step-group]').all()) if (!await group.evaluate(node=>node.open)) await group.locator(':scope > summary').click(); };
const choice = (key, index) => step(key).locator('[data-step-ingredient]').nth(index);
const quantity = (key, index) => step(key).locator('[data-step-quantity-value]').nth(index);
const freeQuantity = (key, index) => step(key).locator('[data-step-quantity-text]').nth(index);
const editAmount = async (key, index) => { const details=step(key).locator('.recipe-editor-step-quantity').nth(index); if (!await details.evaluate(node=>node.open)) await details.locator('summary').click(); };
const setAmount = async (key,index,value,free=false) => { await editAmount(key,index); await (free?freeQuantity(key,index):quantity(key,index)).fill(value); };
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
  await step('s1').locator('[data-field="step-title"]').fill('Separate heading <img src=x>');
  await step('s1').locator('textarea').fill('Draft heading\nKeep this multiline text.');
  assert.equal((await draft()).steps[0].title,'Separate heading <img src=x>');
  await page.evaluate(() => { window.originalStepTextarea=document.querySelector('.recipe-editor-step[data-key="s1"] textarea'); });
  await openPicker('s1');
  assert.equal(await step('s1').locator('[data-step-group]').count(),2);
  assert.equal(await step('s1').locator('[data-step-group][open]').count(),0,'ingredient groups start collapsed');
  assert.equal(await choice('s1',0).isVisible(),false);
  await step('s1').locator('[data-step-group="g1"] > summary').press('Enter');
  assert.equal(await choice('s1',0).isVisible(),true,'keyboard opens only its ingredient group');
  assert.equal(await choice('s1',2).isVisible(),false,'other ingredient groups stay collapsed');
  await openGroups('s1');
  assert.equal(await choice('s1', 0).isChecked(), false);
  assert.equal(await choice('s1', 1).locator('..').locator('..').textContent().then(text => text.includes('盐')), true);
  assert.equal(await page.locator('[data-step-picker-content] img').count(), 0, 'ingredient names stay text');
  assert.equal(await page.evaluate(() => Boolean(window.stepXss)), false);
  await choice('s1', 0).check(); await setAmount('s1', 0, '20');
  await choice('s1', 1).check(); await choice('s1', 1).uncheck();
  assert.deepEqual((await draft()).steps.find(row=>row.client_key==='s1').excluded_ingredients,['i-盐<>'],'manual uncheck records an exclusion');
  assert.deepEqual(await links('s1'), [{ingredient_client_key:'i1',show_quantity:true,origin:'manual',quantity_value:20,quantity_text:null}]);
  assert.deepEqual(await links('s2'), [], 'adding a link never assigns another step automatically');
  assert.equal(await step('s1').locator('[data-step-group="g1"] [data-step-group-count]').textContent(),' (1)');
  await step('s1').locator('[data-step-group="g1"] > summary').click();
  assert.equal(await choice('s1',0).isVisible(),false);
  assert.equal((await links('s1'))[0].quantity_value,20,'collapsing keeps the selected step amount');
  await step('s1').locator('[data-step-group="g1"] > summary').press('Space');
  assert.equal(await quantity('s1',0).inputValue(),'20','reopening preserves selected quantities');

  await page.evaluate(() => { window.stepAmountInput=document.querySelector('[data-step-quantity-value]'); });
  await quantity('s1',0).fill('101');
  assert.equal(await page.locator('#recipe-save-btn').isVisible(),false,'step quantity cannot exceed its source total');
  assert.equal(await quantity('s1',0).evaluate(node=>node===window.stepAmountInput&&document.activeElement===node),true,'typing preserves the amount input and focus');
  await quantity('s1',0).fill('20');
  await step('s1').locator('[data-recipe-editor-action="step-quantity-reset"]').first().click();
  assert.deepEqual(await links('s1'),[{ingredient_client_key:'i1',show_quantity:true,origin:'manual',quantity_value:null,quantity_text:null}],'reset explicitly returns to the full source amount');
  await setAmount('s1',0,'20');
  assert.equal(await page.evaluate(() => window.originalStepTextarea===document.querySelector('.recipe-editor-step[data-key="s1"] textarea')), true, 'picker changes retain the textarea node and draft');
  assert.equal(await step('s1').locator('textarea').inputValue(), 'Draft heading\nKeep this multiline text.');
  await openGroups('s2'); await choice('s2', 0).check();
  assert.deepEqual(await links('s2'), [{ingredient_client_key:'i1',show_quantity:true,origin:'manual'}], 'reuse leaves the explicit source flag intact');
  assert.equal((await page.evaluate(() => window.stepTest.queue())).length, 0, 'picker choices are draft edits, not backend writes');

  // Editing source names refreshes only picker labels; links follow stable keys.
  await page.locator('.recipe-editor-ingredient[data-key="i1"] [data-recipe-editor-action="ingredient-edit"]').click();
  await page.locator('.recipe-editor-ingredient[data-key="i1"] [data-field="name"]').fill('New flour – мука');
  assert.equal(await choice('s1', 0).locator('..').locator('..').textContent().then(text => text.includes('New flour – мука')), true);
  assert.deepEqual(await links('s1'), [{ingredient_client_key:'i1',show_quantity:true,origin:'manual',quantity_value:20,quantity_text:null}]);
  await page.locator('.recipe-editor-ingredient[data-key="i1"] [data-recipe-editor-action="ingredient-done"]').click();
  await step('s1').locator('[data-recipe-editor-action="step-down"]').click();
  assert.deepEqual((await draft()).steps.map(row => row.client_key), ['s2','s1']);
  assert.equal((await draft()).steps[1].text, 'Draft heading\nKeep this multiline text.');
  assert.equal((await draft()).steps[1].title,'Separate heading <img src=x>','heading follows its stable step key through reorder');
  assert.equal(await step('s1').locator('[data-step-group="g1"]').evaluate(node=>node.open),true,'expanded groups follow stable step keys through reorder');
  assert.deepEqual(await links('s1'), [{ingredient_client_key:'i1',show_quantity:true,origin:'manual',quantity_value:20,quantity_text:null}]);
  await openGroups('s1'); await choice('s1', 2).check();
  await openGroups('s2'); await choice('s2',2).check(); await choice('s2',2).uncheck();
  await page.locator('.recipe-editor-group[data-key="g2"] [data-recipe-editor-action="group-remove"]').click();
  assert.deepEqual((await draft()).steps.find(row=>row.client_key==='s2').excluded_ingredients,[],'removing a source group prunes its negative choices');
  assert.deepEqual(await links('s1'), [{ingredient_client_key:'i1',show_quantity:true,origin:'manual',quantity_value:20,quantity_text:null}], 'removing a group prunes its ingredient references');
  await page.locator('.recipe-editor-ingredient[data-key="i1"] [data-recipe-editor-action="ingredient-edit"]').click();
  await page.locator('.recipe-editor-ingredient[data-key="i1"] [data-recipe-editor-action="ingredient-remove"]').click();
  assert.deepEqual(await links('s1'), []); assert.deepEqual(await links('s2'), [], 'removing an ingredient prunes every step');
  await openGroups('s1'); await choice('s1', 0).check();
  await page.click('#recipe-save-btn'); await closed();
  const queue = await page.evaluate(() => window.stepTest.queue());
  assert.deepEqual(queue[0].data.changes.steps.map(row => [row.client_key,row.ingredients]), [
    ['s2',[]],['s1',[{ingredient_client_key:'i-盐<>',show_quantity:true,origin:'manual'}]],
  ], 'queued payload contains only ordered stable links and flags');
  await page.evaluate(() => window.stepTest.editor.showEdit(101));
  assert.equal(await page.locator('#recipe-save-btn').isVisible(), false, 'reopening a queued linked recipe has no phantom dirty state');
  assert.equal(await step('s1').locator('[data-field="step-title"]').inputValue(),'Separate heading <img src=x>');
  assert.equal(await step('s1').locator('img').count(),0,'step headings remain escaped input content');
  assert.equal(await page.locator('.recipe-editor-step-ingredients[open]').count(), 0, 'a reopened editor starts with collapsed assignment pickers');
  await openGroups('s1'); assert.equal(await choice('s1',0).isChecked(), true);
  assert.equal(await choice('s1',0).isDisabled(), false);
  assert.equal(await freeQuantity('s1',0).isDisabled(), false, 'selected ingredient free amount control is enabled after reopen');
  assert.equal(await quantity('s1',0).isDisabled(), true, 'a free source amount cannot invent a numeric total');
  await setAmount('s1',0,'eine Prise',true);
  await step('s2').locator('[data-recipe-editor-action="step-remove"]').click();
  assert.deepEqual((await draft()).steps.map(row=>row.client_key), ['s1']);

  for (const width of [1280,390,320]) {
    await page.setViewportSize({width,height:900});
    await openGroups('s1');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth), true, `no body overflow at ${width}`);
    assert.equal(await choice('s1',0).evaluate(input=>input.closest('label').getBoundingClientRect().height>=44), true);
  }
  const beforeLanguage = await step('s1').locator('textarea').inputValue();
  await page.evaluate(() => window.stepTest.setLanguagePreference('en'));
  assert.ok((await toggle('s1').textContent()).includes(await page.evaluate(() => window.stepTest.t('recipe.step.ingredients.assign'))));
  assert.equal(await step('s1').locator('textarea').inputValue(), beforeLanguage);
  assert.deepEqual(await links('s1'), [{ingredient_client_key:'i-盐<>',show_quantity:true,origin:'manual',quantity_value:null,quantity_text:'eine Prise'}]);
  await page.evaluate(() => window.stepTest.permission(false));
  assert.equal(await choice('s1',0).isDisabled(), true); assert.equal(await freeQuantity('s1',0).isDisabled(), true);
  assert.equal(await toggle('s1').getAttribute('aria-disabled'), 'true');
  await page.evaluate(() => window.stepTest.permission(true));
  assert.equal(await choice('s1',0).isDisabled(), false);
  await page.keyboard.press('Escape'); await closed(); // Content details must not consume the modal Escape.
  await page.evaluate(() => window.stepTest.editor.showEdit(101));
  await openGroups('s1'); await setAmount('s1',0,'eine Prise',true);
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
      badFlag:valid(explicit([{ingredient_client_key:'i',show_quantity:0}]),true),extra:valid(explicit([{ingredient_client_key:'i',quantity_unit:'g'}]),true),
      defaultFlag:valid(explicit([{ingredient_client_key:'i'}]),true).steps[0].ingredients[0].show_quantity,
      immutable:JSON.stringify(sanitize(attempted).data.changes.steps)===JSON.stringify(base.steps),
      numericWithoutSource:valid(explicit([{ingredient_client_key:'i',quantity_value:1}]),true),
      both:valid(explicit([{ingredient_client_key:'i',quantity_value:1,quantity_text:'some'}]),true),
      legacyWithValue:valid(explicit([{ingredient_client_key:'i',show_quantity:false,quantity_text:'some'}]),true)};
  });
  assert.deepEqual(checks,{legacy:[],patchMissing:false,unknown:null,duplicate:null,badFlag:null,extra:null,defaultFlag:true,immutable:true,numericWithoutSource:null,both:null,legacyWithValue:null});
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
  await page.evaluate(() => {
    const source=window.stepTest.books()[0].recipes[0];
    window.stepTest.editor.showImport(source,2,{warnings:['recipe.ai.reviewQuantities']});
    document.querySelector('.recipe-editor-source').open=true;
  });
  for(const width of [1280,390,320]) {
    await page.setViewportSize({width,height:900});
    const spaces=await page.evaluate(()=>{
      const rect=selector=>document.querySelector(selector).getBoundingClientRect();
      return {ai:rect('#recipe-import-review').top-rect('.recipe-ai-tools').bottom,
        source:rect('.recipe-editor-source').top-rect('.recipe-editor-intro').bottom,
        intro:rect('.recipe-editor-intro').top-rect('#recipe-import-review').bottom,
        overflow:document.documentElement.scrollWidth>innerWidth};
    });
    assert.ok(spaces.ai>=12,`BrainDump notice keeps spacing at ${width}px: ${JSON.stringify(spaces)}`);
    assert.ok(spaces.source>=16,`expanded source keeps spacing below portions/times at ${width}px: ${JSON.stringify(spaces)}`);
    assert.ok(spaces.intro>=16,`import notice keeps spacing before title at ${width}px`);
    assert.equal(spaces.overflow,false);
  }
  const firstStep=page.locator('.recipe-editor-step').first();
  await firstStep.locator('textarea').fill('');
  await firstStep.locator('[data-field="step-title"]').fill('Title-only step');
  assert.equal(await page.locator('#recipe-save-btn').isVisible(),true,'a title-only step is valid without an artificial required body');
  await firstStep.locator('[data-field="step-title"]').fill('');
  assert.equal(await page.locator('#recipe-save-btn').isVisible(),false,'a step still requires a heading or body');
  for (const width of [1280,390,320]) {
    await page.setViewportSize({width,height:900});
    for (const name of ['', 'Dough <img src=x>']) {
      assert.equal(await page.evaluate(name => {
        const source=structuredClone(window.stepTest.books()[0].recipes[0]);
        source.ingredient_groups=[{client_key:'only',name,ingredients:source.ingredient_groups.flatMap(group=>group.ingredients)},
          {client_key:'empty',name:'Unused group',ingredients:[]}];
        window.stepTest.editor.deactivate();
        return window.stepTest.editor.showImport(source,2);
      },name),true);
      await openPicker('s1');
      assert.equal(await step('s1').locator('[data-step-group]').count(),0,'a single populated group needs no second disclosure');
      assert.equal(await choice('s1',0).isVisible(),true,`ingredients are immediately available at ${width}px`);
      assert.equal(await choice('s1',0).isChecked(),true,'existing step assignments remain selected');
      assert.equal(await step('s1').locator('.recipe-editor-step-group-name').count(),name ? 1 : 0,'only a named group keeps its static heading');
      assert.equal(await step('s1').locator('img').count(),0,'single group names stay escaped');
      await choice('s1',0).uncheck(); await choice('s1',0).check();
      assert.equal(await choice('s1',0).isVisible(),true,'changing an assignment keeps the direct list visible');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    }
  }
  assert.equal(await page.evaluate(()=>{
    const source=structuredClone(window.stepTest.books()[0].recipes[0]);
    for(const row of source.steps){row.excluded_ingredients=[];for(const link of row.ingredients)link.origin='braindump';}
    window.stepTest.editor.deactivate();return window.stepTest.editor.showImport(source,2,{warnings:['recipe.ai.review'],reviewHint:'recipe.ai.reviewHint',issues:[
      {step_client_key:'s1',code:'additional_amount_missing',ingredient_name:'Flour',reason:'amount_missing',evidence:source.steps[0].text}]});
  }),true);
  assert.equal(await step('s1').locator('[data-recipe-step-issues]').isVisible(),true);
  assert.equal(await step('s2').locator('[data-recipe-step-issues]').isVisible(),false,'a concrete warning appears only on the referenced step');
  await step('s1').locator('.recipe-editor-issue-evidence>summary').click();
  await openGroups('s1');
  assert.equal((await links('s1'))[0].origin,'braindump','AI origin survives imported editor cloning');
  await setAmount('s1',0,'25');
  assert.equal((await links('s1'))[0].origin,'manual');
  await choice('s1',1).uncheck();
  await step('s1').locator('[data-recipe-editor-action="step-down"]').click();
  assert.equal(await step('s1').locator('[data-recipe-step-issues]').isVisible(),true,'issue placement follows the stable step key through reorder');
  assert.equal(await step('s2').locator('[data-recipe-step-issues]').isVisible(),false);
  assert.equal(await step('s1').locator('.recipe-editor-issue-evidence').evaluate(node=>node.open),true,'the optional quote stays expanded through reorder');
  assert.deepEqual((await draft()).steps.find(row=>row.client_key==='s1').excluded_ingredients,['i-盐<>'],'exclusions follow stable step keys on reorder');
  await page.click('#recipe-save-btn'); await closed();
  const inferredCreate=(await page.evaluate(()=>window.stepTest.queue())).find(row=>row.action==='CREATE_RECIPE');
  const authoredStep=inferredCreate.data.steps.find(row=>row.client_key==='s1');
  assert.equal(authoredStep.ingredients[0].origin,'manual');
  assert.equal(authoredStep.ingredients[0].quantity_value,25);
  assert.deepEqual(authoredStep.excluded_ingredients,['i-盐<>'],'manual negative intent survives durable offline create');
  assert.equal(Object.hasOwn(authoredStep,'issues'),false,'review findings never become authored recipe content');
  assert.deepEqual(await page.evaluate(() => window.stepTest.errors), []); assert.deepEqual(errors, []);
  console.log('✅ Recipe step editor: stable links, pruning, offline payload, language, mobile and lifecycle guards');
} finally { await browser.close(); }

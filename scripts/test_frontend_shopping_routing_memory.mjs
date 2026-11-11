#!/usr/bin/env node
// Real Shopping editor/controller at a private origin. No API/service/SQLite.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { waitForPageCondition } from './browser_page_condition.mjs';
import { renderQuickAddChips } from '../web/static/js/features/quick-add.js';

const escapedChip=renderQuickAddChips([{type:'store',label:'Supermarket',value:'<img src=x onerror="unsafe()">',source:'memory'}],()=> 'Remembered "choice"');
assert.match(escapedChip,/&lt;img src=x onerror=&quot;unsafe\(\)&quot;&gt;/,'shared HTML chips escape supplied values');
assert.match(escapedChip,/aria-label="Remembered &quot;choice&quot;"/,'memory icon labels remain escaped attributes');
assert.doesNotMatch(escapedChip,/<img/,'values never become HTML elements');

const fixture = `
import { initI18n, translatePage } from '/static/js/i18n/index.js';
import { SHOPPING_DIALOGS_HTML } from '/static/js/modules/shopping-dialogs.js';
import { createShoppingItemEditorFeature } from '/static/js/features/shopping-item-editor.js';
import { createShoppingItemsController } from '/static/js/features/shopping-items.js';
import { createUiShell } from '/static/js/features/ui-shell.js';
localStorage.setItem('nia-todo-language','de');await initI18n();
document.body.innerHTML='<button type="button" data-shopping-item-action="open-create">Add</button>'+SHOPPING_DIALOGS_HTML;
translatePage(document);createUiShell({}).bindModalCloseControls();
let lists=[{id:1,name:'Einkauf',can_edit:true,sections:[{id:10,name:'Kühlregal'},{id:20,name:'Vorrat'}],items:[]}];
const stores=[{id:100,shopping_list_id:1,name:'REWE',active:true},{id:101,shopping_list_id:1,name:'ALDI',active:true}];
let memoryGeneration=1;
let actor=1,enabled=true,ready=true,sequence=0,eventSequence=0,hold=null,memoryRefreshes=0,releaseFailure=null;
const commits=[],errors=[],feedbackCalls=[];
const routes={Butter:{shopping_list_id:1,section_id:10,section_known:true,memory_fields:['list','section','stores'],store_ids:[100,101],stores_known:true},Mehl:{shopping_list_id:1,section_id:20,section_known:true,memory_fields:['list','section','stores'],store_ids:[101],stores_known:true}};
const memory={
 suggest:(name,listId)=>actor===1&&enabled&&listId===1?structuredClone(routes[name]||null):null,
 refresh:()=>{memoryRefreshes++;return hold?.promise||Promise.resolve();},
 feedback:fields=>{feedbackCalls.push([...fields]);return {event_id:'event-'+(++eventSequence),generation:memoryGeneration,fields:actor===1&&enabled&&ready?[...fields]:[]};},
 capture:()=>{const generation=memoryGeneration;return {feedback:fields=>{feedbackCalls.push([...fields]);return {event_id:'event-'+(++eventSequence),generation,
   fields:actor===1&&enabled&&ready&&generation===memoryGeneration?[...fields]:[]};}};}
};
let editor;
const controller=createShoppingItemsController({getLists:()=>lists,setLists:next=>{lists=next;},getActiveListId:()=>1,getStores:()=>stores,routingMemory:memory,
 createTempId:()=> 'temp-memory-'+(++sequence),commitMutation:async build=>{const mutation=build();if(mutation)commits.push(structuredClone(mutation));return mutation;}});
editor=createShoppingItemEditorFeature({getLists:()=>lists,getActiveListId:()=>1,getStores:()=>stores,itemController:controller,routingMemory:memory,onError:error=>errors.push(error.message)});
editor.bind();
window.test={editor,controller,commits,errors,feedbackCalls,generation:()=>memoryGeneration,
 resetMemory:()=>{memoryGeneration++;for(const name of Object.keys(routes))routes[name]=null;window.dispatchEvent(new CustomEvent('nia-routing-memory-changed'));},
 route:name=>structuredClone(routes[name]),refreshes:()=>memoryRefreshes,
 changeRoute:(name,route)=>{routes[name]=route;window.dispatchEvent(new CustomEvent('nia-routing-memory-changed'));},
 holdFailingSave:()=>{const create=controller.create;controller.create=async()=>{controller.create=create;await new Promise(resolve=>{releaseFailure=resolve;});throw Error('expected memory save failure');};},
 releaseFailure:()=>releaseFailure?.(),lists:()=>structuredClone(lists),
 holdMemory:()=>{let release;const promise=new Promise(done=>{release=done;});hold={promise,release};},
 releaseMemory:()=>{const gate=hold;hold=null;gate?.release();},
 actor:value=>{actor=value;editor.close();},enabled:value=>{enabled=value;},ready:value=>{ready=value;}};
`;
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('http://shopping-memory.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/style.css"></head><body><script type="module" src="/fixture.js"></script></body></html>'});
  if(path==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:fixture});
  if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.json')?'application/json':path.endsWith('.css')?'text/css':'application/octet-stream',body:readFileSync(new URL('../web'+path,import.meta.url))});
  return route.fulfill({status:404,body:'No real network'});
 });
 await page.goto('http://shopping-memory.test/');await page.waitForFunction(()=>Boolean(window.test));
 const modal=page.locator('#shopping-item-modal'),name=page.locator('#shopping-item-name');
 const section=page.locator('#shopping-item-section'),store=page.locator('#shopping-item-store');
 const open=async()=>{await page.evaluate(()=>window.test.editor.showCreate());await modal.waitFor({state:'visible'});};
 const closed=()=>modal.waitFor({state:'hidden'});
 const save=async()=>{await page.locator('#shopping-item-save-btn').click();await closed();};
 const last=()=>page.evaluate(()=>window.test.commits.at(-1));
 const targets=async(sectionId,storeId)=>waitForPageCondition(page,expected=>document.getElementById('shopping-item-section').value===expected[0]&&document.getElementById('shopping-item-store').value===expected[1],[sectionId,storeId]);

 await open();await name.fill('Butter');await targets('10','100');
 assert.match(await page.locator('#shopping-item-quick-add-preview').textContent(),/REWE, ALDI/,'all remembered supermarkets are visible in the preview');
 assert.equal(await page.evaluate(()=>window.test.feedbackCalls.length),0,'rendering and dirty-state reads do not create memory events');
 assert.equal(await page.locator('#shopping-item-quick-add-preview [data-source="memory"] .quick-add-memory-icon svg').count(),2,'each applied remembered destination has the shared AI icon');
 assert.ok(await page.locator('#shopping-item-quick-add-preview .quick-add-memory-icon svg path').count()>2,'the registered AI icon paths are rendered instead of a placeholder circle');
 assert.equal(await page.locator('#shopping-item-quick-add-preview [data-source="memory"]').evaluateAll(nodes=>nodes.every(node=>node.title&&node.querySelector('[role="img"]').getAttribute('aria-label')===node.title)),true,'memory badges carry a localized title and accessible icon label');
 await page.setViewportSize({width:320,height:740});
 assert.equal(await modal.locator('.modal-content').evaluate(node=>node.scrollWidth<=node.clientWidth),true,'remembered field badges fit the narrow mobile editor');
 await save();let mutation=await last();
 assert.deepEqual(mutation.data.item.store_ids,[100,101],'suggested supermarket sets are not truncated to the one visible select');
 assert.equal(mutation.data.item.section_id,10);
 assert.deepEqual(mutation.data.item.routing_feedback.fields,['list'],'memory-derived section/store do not teach themselves again');
 assert.equal(Object.hasOwn(mutation.result,'routing_feedback'),false,'feedback belongs only to the queued request');
 const firstId=mutation.result.id;

 await open();await name.fill('Butter');await targets('10','100');
 await section.selectOption('',{force:true});await store.selectOption('',{force:true});
 await name.fill('Butter /Kühlregal @REWE');await targets('','');assert.equal(await page.locator('#shopping-item-quick-add-preview [data-source="memory"]').count(),0,'explicit empty destinations never retain a memory badge');await save();mutation=await last();
 assert.equal(mutation.data.item.name,'Butter');assert.equal(mutation.data.item.section_id,null);assert.deepEqual(mutation.data.item.store_ids,[]);
 assert.deepEqual(mutation.data.item.routing_feedback.fields,['list','section','stores'],'explicit empty choices beat syntax and remembered values');

 await open();await name.fill('Butter /Vorrat @ALDI');await targets('20','101');assert.equal(await page.locator('#shopping-item-quick-add-preview [data-source="memory"]').count(),0,'explicit Quick Add fields use ordinary chips');await save();mutation=await last();
 assert.equal(mutation.data.item.section_id,20);assert.deepEqual(mutation.data.item.store_ids,[101]);
 assert.deepEqual(mutation.data.item.routing_feedback.fields,['list','section','stores'],'explicit Quick Add routes teach their fields');

 await open();await name.fill('Butter');await targets('10','100');await name.fill('Unbekannt');await targets('','');assert.equal(await page.locator('#shopping-item-quick-add-preview [data-source="memory"]').count(),0,'changing the name clears stale memory badges');
 await name.fill('');await targets('','');await page.evaluate(()=>window.test.editor.close());await closed();

 await open();await page.locator('#shopping-item-create-mode-switch [data-multi-add-mode="multi"]').click();
 const rows=page.locator('#shopping-item-multi-add-rows .ui-multi-add-input');
 await rows.first().fill('Butter');await rows.first().press('Enter');await rows.nth(1).fill('Butter /Vorrat @ALDI');
 await waitForPageCondition(page,()=>document.querySelectorAll('#shopping-item-multi-add-rows .ui-multi-add-preview')[0].textContent.includes('REWE, ALDI'));
 assert.equal(await page.locator('#shopping-item-multi-add-rows .ui-multi-add-row').first().locator('[data-source="memory"] .quick-add-memory-icon svg').count(),2,'bulk rows reuse the same per-field memory icon chips');
 assert.equal(await page.locator('#shopping-item-multi-add-rows .ui-multi-add-row').nth(1).locator('[data-source="memory"]').count(),0,'bulk explicit syntax overrides remembered markers');
 const bulkButter=await page.evaluate(()=>window.test.route('Butter'));
 const bulkRefreshes=await page.evaluate(()=>window.test.refreshes());
 await page.evaluate(route=>window.test.changeRoute('Butter',route),{...bulkButter,section_id:20,store_ids:[101]});
 await waitForPageCondition(page,()=>document.querySelectorAll('#shopping-item-multi-add-rows .ui-multi-add-preview')[0].textContent.includes('Vorrat')&&!document.querySelectorAll('#shopping-item-multi-add-rows .ui-multi-add-preview')[0].textContent.includes('REWE'));
 assert.equal(await rows.nth(1).evaluate(input=>input===document.activeElement),true,'live bulk refresh preserves the focused row input');
 assert.equal(await page.evaluate(()=>window.test.refreshes()),bulkRefreshes,'live bulk refresh never creates a GET loop');
 await page.evaluate(route=>window.test.changeRoute('Butter',route),bulkButter);
 await waitForPageCondition(page,()=>document.querySelectorAll('#shopping-item-multi-add-rows .ui-multi-add-preview')[0].textContent.includes('REWE, ALDI'));
 await page.locator('#shopping-item-multi-section').selectOption('20',{force:true});await page.locator('#shopping-item-multi-section').selectOption('',{force:true});
 await page.locator('#shopping-item-multi-store').selectOption('100',{force:true});await page.locator('#shopping-item-multi-store').selectOption('',{force:true});
 await save();mutation=await last();
 assert.deepEqual(mutation.mutations.map(entry=>[entry.data.item.section_id,entry.data.item.store_ids]),[[null,[]],[20,[101]]],'bulk explicit empty defaults beat memory while per-line syntax beats defaults');
 assert.ok(mutation.mutations.every(entry=>JSON.stringify(entry.data.item.routing_feedback.fields)==='["list","section","stores"]'));

 const originalButter=await page.evaluate(()=>window.test.route('Butter'));
 const newButter={...originalButter,section_id:20,store_ids:[101]};
 await open();await name.fill('Butter');await targets('10','100');
 const beforeLiveRefresh=await page.evaluate(()=>window.test.refreshes());
 await page.evaluate(route=>window.test.changeRoute('Butter',route),newButter);await targets('20','101');
 assert.equal(await name.evaluate(input=>input===document.activeElement),true,'live memory notifications do not steal input focus');
 assert.equal(await page.evaluate(()=>window.test.refreshes()),beforeLiveRefresh,'memory notifications rerender without another API refresh');
 await save();mutation=await last();assert.equal(mutation.data.item.section_id,20);assert.deepEqual(mutation.data.item.store_ids,[101],'visible live proposals and queued destinations agree');
 await page.evaluate(route=>window.test.changeRoute('Butter',route),originalButter);
 await open();await name.fill('Butter');await targets('10','100');
 await page.evaluate(()=>window.test.changeRoute('Butter',null));await targets('','');
 assert.equal(await page.locator('#shopping-item-quick-add-preview [data-source="memory"]').count(),0,'a live reset removes suggestions and memory origins');
 await save();mutation=await last();assert.equal(mutation.data.item.section_id,null);assert.deepEqual(mutation.data.item.store_ids,[],'submission does not silently retain a removed remembered route');
 await page.evaluate(route=>window.test.changeRoute('Butter',route),originalButter);
 await open();await name.fill('Butter');await targets('10','100');await section.selectOption('20',{force:true});await store.selectOption('101',{force:true});
 await page.evaluate(route=>window.test.changeRoute('Butter',route),{...originalButter,section_id:null,store_ids:[]});await targets('20','101');
 assert.equal(await page.locator('#shopping-item-quick-add-preview [data-source="memory"]').count(),0,'a live update preserves explicit fields without stale origins');
 await save();mutation=await last();assert.equal(mutation.data.item.section_id,20);assert.deepEqual(mutation.data.item.store_ids,[101]);
 await page.evaluate(route=>window.test.changeRoute('Butter',route),originalButter);
 await open();await name.fill('Butter');await targets('10','100');await page.evaluate(()=>window.test.holdFailingSave());
 await page.locator('#shopping-item-save-btn').click();
 await waitForPageCondition(page,()=>document.getElementById('shopping-item-modal').getAttribute('aria-busy')==='true');
 await page.evaluate(route=>window.test.changeRoute('Butter',route),newButter);await targets('10','100');
 await page.evaluate(()=>window.test.releaseFailure());await targets('20','101');
 assert.deepEqual(await page.evaluate(()=>window.test.errors.splice(0)),['expected memory save failure'],'deferred live proposals refresh after a failed save finishes');
 await page.evaluate(()=>window.test.editor.close());await closed();await page.evaluate(route=>window.test.changeRoute('Butter',route),originalButter);

 await page.evaluate(id=>window.test.editor.showEdit(1,id),firstId);await modal.waitFor({state:'visible'});
 await page.locator('.shopping-item-additional-details > summary').click();await page.locator('#shopping-item-note').fill('Only the note changed');await save();mutation=await last();
 assert.deepEqual(mutation.data.changes.store_ids,[100,101],'editing a note retains every original supermarket');
 assert.deepEqual(mutation.data.changes.routing_feedback.fields,[],'unrelated edits do not reinforce routes');
 assert.equal(Object.hasOwn(mutation.result,'routing_feedback'),false);
 await page.evaluate(id=>window.test.controller.moveToSection(1,id,20),firstId);mutation=await last();
 assert.deepEqual(mutation.data.changes.routing_feedback.fields,['section'],'drag/drop learns only the section');
 const eventId=mutation.data.changes.routing_feedback.event_id;
 const before=await page.evaluate(()=>window.test.commits.length);
 await page.evaluate(id=>window.test.controller.moveToSection(1,id,20),firstId);
 assert.equal(await page.evaluate(()=>window.test.commits.length),before,'moving to the same section does not queue another memory event');
 assert.equal((await last()).data.changes.routing_feedback.event_id,eventId,'the queued event identity remains stable');
 await page.evaluate(id=>window.test.controller.toggleCompleted(1,id),firstId);mutation=await last();
 assert.equal(Object.hasOwn(mutation.data.changes,'routing_feedback'),false,'purchasing does not teach routing');

 await page.evaluate(()=>window.test.holdMemory());await open();await name.fill('Butter');await targets('10','100');
 const beforeStale=await page.evaluate(()=>window.test.commits.length);
 await page.evaluate(()=>document.getElementById('shopping-item-form').requestSubmit());
 await page.evaluate(()=>window.test.editor.close());await closed();
 await open();await name.fill('Mehl');await targets('20','101');await section.selectOption('10',{force:true});
 await page.evaluate(()=>window.test.releaseMemory());await targets('10','101');
 assert.equal(await name.inputValue(),'Mehl','an old refresh cannot restore a previous modal name');
 assert.equal(await page.evaluate(()=>window.test.commits.length),beforeStale,'closing while waiting for memory aborts the old submit');
 await save();assert.equal((await last()).data.item.section_id,10,'late refresh preserves manual edits in the new modal');

 await page.evaluate(()=>window.test.holdMemory());await open();await name.fill('Explicit reset item');
 await section.selectOption('20',{force:true});await store.selectOption('100',{force:true});
 const oldSaveGeneration=await page.evaluate(()=>window.test.generation());
 assert.equal(await page.locator('#shopping-item-save-btn').isEnabled(),true,'a valid draft may submit while the initial model read is pending');
 await page.locator('#shopping-item-save-btn').click();
 await page.evaluate(()=>window.test.resetMemory());await page.evaluate(()=>window.test.releaseMemory());await closed();
 mutation=await last();
 assert.equal(mutation.data.item.section_id,20);assert.deepEqual(mutation.data.item.store_ids,[100],'a memory reset preserves the explicit content destination');
 assert.equal(mutation.data.item.routing_feedback.generation,oldSaveGeneration,'a waiting single submit keeps its pre-reset learning generation');
 assert.deepEqual(mutation.data.item.routing_feedback.fields,[],'a reset cannot turn an earlier Shopping save into active new-generation learning');
 await page.evaluate(()=>window.test.holdMemory());await open();
 await page.locator('#shopping-item-create-mode-switch [data-multi-add-mode="multi"]').click();
 await page.locator('#shopping-item-multi-section').selectOption('20',{force:true});await page.locator('#shopping-item-multi-store').selectOption('100',{force:true});
 await rows.first().fill('Bulk reset first');await rows.first().press('Enter');await rows.nth(1).fill('Bulk reset second');
 const beforePendingBulk=await page.evaluate(()=>({count:window.test.commits.length,generation:window.test.generation()}));
 await page.locator('#shopping-item-save-btn').click();
 await page.evaluate(()=>window.test.resetMemory());await page.evaluate(()=>window.test.releaseMemory());
 await waitForPageCondition(page,()=>!document.getElementById('shopping-item-modal').hasAttribute('aria-busy'));
 const afterPendingBulk=await page.evaluate(count=>window.test.commits.slice(count),beforePendingBulk.count);
 for(const batch of afterPendingBulk)for(const row of batch.mutations||[batch]){
   const feedback=row.data.item.routing_feedback;
   assert.ok(feedback.generation===beforePendingBulk.generation||feedback.fields.length===0,'pending bulk validation cannot recreate learning in a post-reset generation');
 }
 await page.evaluate(()=>window.test.editor.close());await closed();
 await page.evaluate(()=>window.test.actor(2));await open();await name.fill('Butter');await targets('','');await save();mutation=await last();
 assert.deepEqual(mutation.data.item.routing_feedback.fields,[],'another account cannot learn from stale account memory');
 assert.deepEqual(await page.evaluate(()=>window.test.errors),[]);assert.deepEqual(errors,[]);
 console.log('PASS Shopping shared routing suggestions, explicit empty choices, bulk precedence, multi-store preservation, queued feedback and stale refresh guards');
} finally {await browser.close();}

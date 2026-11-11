#!/usr/bin/env node
// Real Tasks editors with private mocked persistence; no installed DB or service.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createTodoQuickAddFeature } from '../web/static/js/features/todo-quick-add.js';
import { waitForPageCondition } from './browser_page_condition.mjs';

const dictionary = JSON.parse(await readFile(new URL('../web/static/i18n/de.json', import.meta.url), 'utf8'));
const t = key => dictionary[key] || key;
const projects = [{id:1,name:'Inbox',workspace_id:1,is_inbox:true},{id:2,name:'Haushalt',workspace_id:1},{id:3,name:'Arbeit',workspace_id:1}];
const sections = [{id:11,project_id:1,name:'Eingang'},{id:21,project_id:2,name:'Wäsche'},{id:22,project_id:2,name:'Putzen'},{id:31,project_id:3,name:'Büro'}];
const route = {project_id:2,section_id:21,list_known:true,section_known:true,memory_fields:['list','section']};
const calls = [];
const memory = {suggestTask:(name,workspaceId,projectId,sectionCatalog)=>{
  calls.push([name,workspaceId,projectId,sectionCatalog]);
  if (name === 'Post sortieren' && workspaceId === 1 && String(projectId) === '1') return {project_id:1,section_id:11,list_known:false,section_known:true,memory_fields:['section']};
  if (name !== 'Wäsche waschen' || workspaceId !== 1 || projectId != null && String(projectId) !== '2') return null;
  return projectId == null ? structuredClone(route) : {...route,list_known:false,memory_fields:['section']};
}};
const parser = createTodoQuickAddFeature({getActiveLanguage:()=> 'de',t,getProjects:()=>projects,getCurrentProjectId:()=>1,
  getCurrentWorkspaceId:()=>1,dbGetAll:async()=>sections,routingMemory:memory});
let parsed = await parser.parseQuickAddTitle('Wäsche waschen',1,1);
assert.equal(parsed.changes.project_id,2);assert.equal(parsed.changes.section_id,21);
assert.deepEqual(calls.at(-1)[3],sections,'Dashboard lookups validate children against the complete local catalog, not only the current view');
assert.deepEqual(parsed.routing_fields,[]);assert.deepEqual(parsed.memory_fields,['list','section']);
parsed = await parser.parseQuickAddTitle('Wäsche waschen #Arbeit /Büro',1,1);
assert.equal(parsed.title,'Wäsche waschen');assert.equal(parsed.changes.project_id,3);assert.equal(parsed.changes.section_id,31);
assert.deepEqual(parsed.routing_fields,['list','section']);assert.deepEqual(parsed.memory_fields,[]);
parsed = await parser.parseQuickAddTitle('Wäsche waschen #Arbeit /Büro',1,2,{projectExplicit:true,sectionExplicit:true,sectionId:null});
assert.equal(parsed.changes.project_id,2);assert.equal(parsed.changes.section_id,null);
assert.deepEqual(parsed.memory_fields,[],'explicit dropdowns, including an empty section, beat syntax and memory');
parsed = await parser.parseQuickAddTitle('Wäsche waschen',1,2,{projectExplicit:true});
assert.deepEqual(parsed.memory_fields,['section'],'an explicit project can independently retain a remembered section');
assert.equal(calls.at(-1)[2],2);
parsed = await parser.parseQuickAddTitle('Post sortieren',1,1);
assert.deepEqual(parsed.memory_fields,['section']);assert.equal(parsed.changes.section_id,11);
assert.deepEqual(parsed.routing_fields,[],'section-only memories never invent a deliberate project choice');
assert.equal(parsed.matches.filter(match=>match.source==='memory'&&match.type==='project').length,0);
parsed = await parser.parseQuickAddTitle('Post sortieren',1,2,{contextProjectId:1});
assert.equal(parsed.changes.project_id,1);assert.equal(parsed.changes.section_id,11,'the previous title\'s inferred project does not become the next title\'s fallback context');
parsed = await parser.parseQuickAddTitle('Wäsche waschen',1,1,{sectionExplicit:true,sectionId:11});
assert.equal(parsed.changes.section_id,11);assert.deepEqual(parsed.memory_fields,[],'a chosen section prevents a memory proposal from moving it into a different project');

const fixture = `
import {TASK_DIALOGS_HTML} from '/static/js/modules/tasks-dialogs.js';
import {createTodosFeature} from '/static/js/features/todos.js';
import {initI18n} from '/static/js/i18n/index.js';
localStorage.setItem('nia-todo-language','de');await initI18n();
document.body.innerHTML=TASK_DIALOGS_HTML;
let todos=[],sequence=0,enabled=true,memoryGeneration=4,captureCalls=0,refreshes=0,commitGate=null,releaseCommit=null,commitEntered=false;
let sectionGate=null,releaseSections=null,sectionReadEntered=false,detachedCommitRelease=null;
const projects=${JSON.stringify(projects)}, sections=${JSON.stringify(sections)};
const queue=[],stored=[],feedbackCalls=[],memoryRoutes={'Wäsche waschen':${JSON.stringify(route)}};
const enqueue=async(action,data)=>queue.push({id:queue.length+1,action,data:structuredClone(data)});
const routeFor=(routes,name,workspace,project)=>{
 if(name==='Post sortieren'&&workspace===1&&String(project)==='1')return {project_id:1,section_id:11,list_known:false,section_known:true,memory_fields:['section']};
 const route=routes[name];if(!enabled||workspace!==1||!route||project!=null&&String(project)!==String(route.project_id))return null;
 return project==null?structuredClone(route):{...route,list_known:false,memory_fields:['section']};
};
const feedback=(fields,generation=memoryGeneration,active=enabled)=>{feedbackCalls.push([...fields]);return {event_id:'task-memory-'+(++sequence),generation,fields:active?[...fields]:[]};};
const memory={suggestTask:(...args)=>routeFor(memoryRoutes,...args),refresh:async()=>{refreshes++;},feedback,
 capture:()=>{captureCalls++;const routes=structuredClone(memoryRoutes),generation=memoryGeneration;const current=()=>enabled&&generation===memoryGeneration;
  return {generation,isCurrent:current,suggestTask:(...args)=>current()?routeFor(routes,...args):null,feedback:fields=>feedback(fields,generation,current())};}};
const feature=createTodosFeature({getTodos:()=>todos,setTodos:next=>{todos=next;},getProjects:()=>projects,getSections:()=>sections,
getCurrentProjectId:()=>null,getCurrentWorkspaceId:()=>1,getCurrentUser:()=>null,setCurrentUser:()=>{},getAppInitialized:()=>true,getDb:()=>({}),
dbPut:async(store,value)=>{stored.push({store,value:structuredClone(value)});if(store==='syncQueue'){const index=queue.findIndex(row=>row.id===value.id);if(index>=0)queue[index]=structuredClone(value);}},dbGetAll:async store=>{if(store==='sections'){if(sectionGate){sectionReadEntered=true;await sectionGate;}return sections;}return store==='syncQueue'?structuredClone(queue):[];},deleteFromDB:async()=>{},
addToSyncQueue:enqueue,runSyncQueueMutation:async op=>{commitEntered=true;if(commitGate)await commitGate;return op(enqueue);},
isOnlineForSync:()=>false,syncWithServer:async()=>{},todosApi:{},sectionsApi:{},placesApi:null,renderProjects:()=>{},renderStats:()=>{},renderTodos:()=>{},
closeModal:id=>document.getElementById(id).classList.remove('active'),confirmDanger:async()=>false,showToast:()=>{},setupDescPreview:()=>{},renderMarkdown:value=>String(value||''),routingMemory:memory});
feature.bindTodoActions();
window.test={feature,queue,stored,feedbackCalls,memoryGeneration:()=>memoryGeneration,captures:()=>captureCalls,todos:()=>todos,refreshes:()=>refreshes,commitEntered:()=>commitEntered,
persisted:()=>{const value={...structuredClone(todos[0]),id:700};todos.push(value);return value;},
hold:()=>{commitEntered=false;commitGate=new Promise((resolve,reject)=>{releaseCommit=reject;});},
holdSuccess:()=>{commitEntered=false;commitGate=new Promise(resolve=>{releaseCommit=resolve;});},
detachCommit:()=>{detachedCommitRelease=releaseCommit;commitGate=null;releaseCommit=null;},
releaseDetached:()=>{const release=detachedCommitRelease;detachedCommitRelease=null;release?.(Error('expected canceled bulk save'));},
release:()=>{const release=releaseCommit;commitGate=null;releaseCommit=null;release(Error('expected failed save'));},
holdSections:()=>{sectionReadEntered=false;sectionGate=new Promise(resolve=>{releaseSections=resolve;});},
sectionReadEntered:()=>sectionReadEntered,releaseSections:()=>{const release=releaseSections;sectionGate=null;releaseSections=null;release?.();},
resetMemory:()=>{memoryGeneration++;delete memoryRoutes['Wäsche waschen'];window.dispatchEvent(new CustomEvent('nia-routing-memory-changed'));},
change:route=>{memoryRoutes['Wäsche waschen']=route;window.dispatchEvent(new CustomEvent('nia-routing-memory-changed'));}};
`;

const browser = await chromium.launch({headless:true});
try {
  const page=await browser.newPage({viewport:{width:390,height:844}}), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://todo-memory.test/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/style.css"></head><body><script type="module" src="/fixture.js"></script></body></html>'});
    if(path==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:fixture});
    if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.json')?'application/json':path.endsWith('.css')?'text/css':'application/octet-stream',body:await readFile(new URL('../web'+path,import.meta.url))});
    return route.fulfill({status:404,body:'No real service'});
  });
  await page.goto('http://todo-memory.test/');await page.waitForFunction(()=>Boolean(window.test));
  const title=page.locator('#todo-title'), modal=page.locator('#todo-modal');
  const open=async()=>{await page.evaluate(()=>window.test.feature.showTodoModal());await modal.waitFor({state:'visible'});};
  const target=async(project,section)=>waitForPageCondition(page,expected=>document.getElementById('todo-project').value===expected[0]&&document.getElementById('todo-section').value===expected[1],[project,section]);
  const save=async()=>{await page.evaluate(()=>window.test.feature.saveTodo({preventDefault(){}}));await modal.waitFor({state:'hidden'});};
  const last=()=>page.evaluate(()=>window.test.queue.at(-1));
  await open();await title.fill('Wäsche waschen');await target('2','21');
  assert.equal(await page.locator('#quick-add-preview [data-source="memory"]').count(),2);
  assert.equal(await page.evaluate(()=>window.test.feedbackCalls.length),0,'rendering does not create learning events');
  assert.equal(await title.evaluate(input=>input===document.activeElement),true,'auto-fill leaves the cursor in the title');
  await page.setViewportSize({width:320,height:740});
  assert.equal(await modal.locator('.modal-content').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
  await save();let item=await last();
  assert.equal(item.data.project_id,2);assert.equal(item.data.section_id,21);assert.deepEqual(item.data.routing_feedback.fields,[]);
  assert.equal(await page.evaluate(()=>Object.hasOwn(window.test.todos().at(-1),'routing_feedback')),false,'feedback is private request metadata');

  await page.evaluate(()=>window.test.feature.showTodoModal(window.test.todos()[0]));await modal.waitFor({state:'visible'});
  await page.locator('#todo-section').selectOption('22',{force:true});await save();item=await last();
  assert.equal(item.action,'CREATE_TODO','editing an offline-created task updates its existing durable intent');
  assert.equal(item.data.section_id,22);assert.deepEqual(item.data.routing_feedback.fields,['section']);
  assert.equal(await page.evaluate(()=>window.test.queue.length),1);
  const chosenEvent=item.data.routing_feedback.event_id;
  await page.evaluate(()=>window.test.feature.showTodoModal(window.test.todos()[0]));await modal.waitFor({state:'visible'});
  await page.locator('#todo-priority').selectOption('2',{force:true});await save();item=await last();
  assert.deepEqual(item.data.routing_feedback.fields,['section'],'editing other metadata preserves the original unsent explicit learning intent');
  assert.equal(item.data.routing_feedback.event_id,chosenEvent,'coalescing keeps a single original learning receipt');
  await page.evaluate(()=>{window.test.queue[0].attempted=true;});
  const originalCreate=await page.evaluate(()=>structuredClone(window.test.queue[0]));
  await page.evaluate(()=>window.test.feature.showTodoModal(window.test.todos()[0]));await modal.waitFor({state:'visible'});
  await page.locator('#todo-section').selectOption('21',{force:true});await save();item=await last();
  assert.equal(item.action,'UPDATE_TODO');assert.equal(item.data.id,originalCreate.data._tempId);
  assert.deepEqual(item.data.changes.routing_feedback.fields,['section']);
  assert.deepEqual(await page.evaluate(()=>window.test.queue[0]),originalCreate,'an attempted create payload and receipt stay immutable');

  await open();await title.fill('Wäsche waschen');await target('2','21');
  await page.locator('#todo-section').selectOption('',{force:true});await target('2','');
  assert.equal(await page.locator('#quick-add-preview [data-source="memory"]').count(),1);
  await save();item=await last();assert.equal(item.data.section_id,null);assert.deepEqual(item.data.routing_feedback.fields,['section']);

  await open();await title.fill('Wäsche waschen');await target('2','21');
  await title.fill('Unbekannt');await target('1','');
  assert.equal(await page.locator('#quick-add-preview [data-source="memory"]').count(),0,'name changes clear the old route');
  await title.fill('Wäsche waschen');await target('2','21');
  await page.evaluate(route=>window.test.change({...route,section_id:22}),route);await target('2','22');
  assert.equal(await title.evaluate(input=>input===document.activeElement),true);
  await page.locator('#todo-project').selectOption('3',{force:true});await target('3','');
  await page.locator('#todo-section').selectOption('31',{force:true});await target('3','31');
  assert.equal(await page.locator('#quick-add-preview [data-source="memory"]').count(),0);
  await save();item=await last();assert.equal(item.data.project_id,3);assert.equal(item.data.section_id,31);assert.deepEqual(item.data.routing_feedback.fields,['list','section']);

  await page.evaluate(route=>window.test.change(route),route);
  await open();await title.fill('Wäsche waschen');await target('2','21');
  const refreshes=await page.evaluate(()=>window.test.refreshes());
  await page.evaluate(()=>{window.test.hold();window.pendingSave=window.test.feature.saveTodo({preventDefault(){}}).catch(()=>false);});
  await page.waitForFunction(()=>window.test.commitEntered());
  await page.evaluate(route=>window.test.change({...route,section_id:22}),route);
  assert.equal(await page.locator('#todo-section').inputValue(),'21','live memory changes do not mutate an in-flight draft');
  await page.evaluate(()=>window.test.release());await page.evaluate(()=>window.pendingSave);await target('2','22');
  assert.equal(await page.evaluate(()=>window.test.refreshes()),refreshes,'cache notifications never start a refresh loop');
  await page.evaluate(()=>document.getElementById('todo-modal').classList.remove('active'));

  await page.evaluate(route=>window.test.change(route),route);
  await open();await page.locator('#todo-create-mode-switch [data-multi-add-mode="multi"]').click();
  const rows=page.locator('#todo-multi-add-rows .ui-multi-add-input');
  await rows.first().fill('Wäsche waschen');await rows.first().press('Enter');await rows.nth(1).fill('Wäsche waschen #Arbeit /Büro');
  await waitForPageCondition(page,()=>document.querySelectorAll('#todo-multi-add-rows .ui-multi-add-preview')[0].textContent.includes('Haushalt'));
  assert.equal(await page.locator('#todo-multi-add-rows .ui-multi-add-row').first().locator('[data-source="memory"]').count(),2);
  await page.evaluate(route=>window.test.change({...route,section_id:22}),route);
  await waitForPageCondition(page,()=>document.querySelectorAll('#todo-multi-add-rows .ui-multi-add-preview')[0].textContent.includes('Putzen'));
  assert.equal(await rows.nth(1).evaluate(input=>input===document.activeElement),true,'bulk updates preserve the focused row');
  await page.evaluate(route=>window.test.change(route),route);
  await waitForPageCondition(page,()=>document.querySelectorAll('#todo-multi-add-rows .ui-multi-add-preview')[0].textContent.includes('Wäsche'));
  await save();const bulk=await page.evaluate(()=>window.test.queue.slice(-2));
  assert.equal(bulk[0].data.project_id,2);assert.equal(bulk[0].data.section_id,21);assert.deepEqual(bulk[0].data.routing_feedback.fields,[]);
  assert.equal(bulk[1].data.project_id,3);assert.equal(bulk[1].data.section_id,31);assert.deepEqual(bulk[1].data.routing_feedback.fields,['list','section']);
  assert.notEqual(bulk[0].data.routing_feedback.event_id,bulk[1].data.routing_feedback.event_id);

  await open();await page.locator('#todo-create-mode-switch [data-multi-add-mode="multi"]').click();
  await page.locator('#todo-multi-project').selectOption('3',{force:true});
  await page.waitForFunction(()=>document.querySelector('#todo-multi-section option[value="31"]'));
  await page.locator('#todo-multi-section').selectOption('31',{force:true});
  await rows.first().fill('Wäsche waschen');await rows.first().press('Enter');await rows.nth(1).fill('Wäsche waschen #Haushalt /Wäsche');
  await waitForPageCondition(page,()=>document.querySelectorAll('#todo-multi-add-rows .ui-multi-add-preview')[1].textContent.includes('Haushalt'));
  assert.equal(await page.locator('#todo-multi-add-rows .ui-multi-add-row').first().locator('[data-source="memory"]').count(),0,'explicit bulk defaults override predicted fields');
  await save();const defaultsBulk=await page.evaluate(()=>window.test.queue.slice(-2));
  assert.equal(defaultsBulk[0].data.project_id,3);assert.equal(defaultsBulk[0].data.section_id,31);
  assert.equal(defaultsBulk[1].data.project_id,2);assert.equal(defaultsBulk[1].data.section_id,21,'per-line syntax retains its established priority over shared defaults');
  await page.evaluate(async()=>{window.test.persisted();await window.test.feature.updateTodoFields(700,{section_id:22},null,{sync:false});});
  item=await last();assert.equal(item.action,'UPDATE_TODO');assert.deepEqual(item.data.changes.routing_feedback.fields,['section']);
  assert.equal(await page.evaluate(()=>Object.hasOwn(window.test.todos().find(todo=>todo.id===700),'routing_feedback')),false);
  await page.evaluate(()=>window.test.feature.updateTodoFields(700,{priority:1},null,{sync:false}));
  assert.equal(Object.hasOwn((await last()).data.changes,'routing_feedback'),false,'unrelated metadata updates do not teach destinations');
  await open();await title.fill('Wäsche waschen');await target('2','21');
  await title.fill('Post sortieren');await target('1','11');
  assert.equal(await page.locator('#quick-add-preview [data-source="memory"]').count(),1);
  assert.equal(await page.locator('#quick-add-preview .project[data-source="memory"]').count(),0);
  await save();item=await last();assert.equal(item.data.project_id,1);assert.equal(item.data.section_id,11);assert.deepEqual(item.data.routing_feedback.fields,[]);
  await open();await page.locator('#todo-section').selectOption('11',{force:true});
  await title.fill('Wäsche waschen');await target('1','11');
  assert.equal(await page.locator('#quick-add-preview [data-source="memory"]').count(),0);
  await save();item=await last();assert.equal(item.data.project_id,1);assert.equal(item.data.section_id,11);assert.deepEqual(item.data.routing_feedback.fields,['section']);
  // Exercise the actual single-modal options, not just direct parser defaults.
  await open();await title.fill('Wäsche waschen #Arbeit /Büro');await target('3','31');
  await page.locator('#todo-project').selectOption('2',{force:true});
  await waitForPageCondition(page,()=>document.getElementById('todo-project').value==='2'
    &&document.getElementById('todo-section').value==='21');
  assert.equal(await page.locator('#quick-add-preview .project[data-source="memory"]').count(),0,'manual project choice stays explicit');
  assert.equal(await page.locator('#quick-add-preview .section[data-source="memory"]').count(),1,'incompatible old syntax does not prevent a valid section inside the chosen project');
  await page.locator('#todo-section').selectOption('22',{force:true});await target('2','22');
  await save();item=await last();
  assert.equal(item.data.project_id,2);assert.equal(item.data.section_id,22);
  assert.equal(item.data.title,'Wäsche waschen');assert.deepEqual(item.data.routing_feedback.fields,['list','section']);
  await open();await title.fill('Wäsche waschen #Arbeit /Büro');await target('3','31');
  await page.locator('#todo-section').selectOption('',{force:true});await target('3','');
  await save();item=await last();
  assert.equal(item.data.project_id,3);assert.equal(item.data.section_id,null);
  assert.deepEqual(item.data.routing_feedback.fields,['list','section'],'an explicit empty section overrides written syntax and teaches that deliberate choice');
  await page.evaluate(route=>window.test.change(route),route);
  await open();await title.fill('Wäsche waschen');await target('2','21');
  await page.evaluate(()=>{window.test.holdSections();window.pendingSectionSave=window.test.feature.saveTodo({preventDefault(){}});});
  await page.waitForFunction(()=>window.test.sectionReadEntered());
  await page.evaluate(route=>window.test.change({...route,section_id:22}),route);
  const submittedVisibleSection=await page.locator('#todo-section').inputValue();
  assert.equal(submittedVisibleSection,'21','memory updates remain invisible while submission awaits sections');
  await page.evaluate(()=>window.test.releaseSections());await page.evaluate(()=>window.pendingSectionSave);
  item=await last();
  assert.equal(String(item.data.section_id),submittedVisibleSection,'submission must preserve the visible inferred section across an awaited section read');
  await page.evaluate(route=>window.test.change(route),route);
  await open();await title.fill('Wäsche waschen');await target('2','21');
  await page.locator('#todo-section').selectOption('22',{force:true});await target('2','22');
  await page.evaluate(()=>{window.test.holdSections();window.pendingResetSave=window.test.feature.saveTodo({preventDefault(){}});});
  await page.waitForFunction(()=>window.test.sectionReadEntered());
  await page.evaluate(()=>window.test.resetMemory());
  await page.evaluate(()=>window.test.releaseSections());await page.evaluate(()=>window.pendingResetSave);
  item=await last();
  assert.equal(item.data.section_id,22,'a memory reset does not discard the explicit content edit');
  assert.equal(item.data.routing_feedback.generation,4,'an awaited submission never adopts a post-reset learning generation');
  assert.deepEqual(item.data.routing_feedback.fields,[],'a fenced snapshot cannot create active learning after a reset');
  await page.evaluate(route=>window.test.change(route),route);
  await open();await page.locator('#todo-create-mode-switch [data-multi-add-mode="multi"]').click();
  await rows.first().fill('Wäsche waschen');await rows.first().press('Enter');await rows.nth(1).fill('Wäsche waschen');
  await waitForPageCondition(page,()=>{const list=[...document.querySelectorAll('#todo-multi-add-rows .ui-multi-add-row')].filter(row=>row.querySelector('.ui-multi-add-input')?.value.trim());return list.length===2&&list.every(row=>String(row._multiParsed?.changes?.section_id)==='21');});
  const beforeBulkCapture=await page.evaluate(()=>({captures:window.test.captures(),queue:window.test.queue.length}));
  await page.evaluate(()=>{window.test.holdSections();window.pendingBulkSaveOne=window.test.feature.saveTodo({preventDefault(){}});window.pendingBulkSaveTwo=window.test.feature.saveTodo({preventDefault(){}});});
  await page.waitForFunction(()=>window.test.sectionReadEntered());
  assert.equal(await page.evaluate(()=>window.test.captures()),beforeBulkCapture.captures+1,'reentrant bulk submissions share one model snapshot');
  await page.evaluate(route=>window.test.change({...route,section_id:22}),route);
  await page.evaluate(()=>window.test.releaseSections());await page.evaluate(()=>Promise.all([window.pendingBulkSaveOne,window.pendingBulkSaveTwo]));
  const stableBulk=await page.evaluate(()=>window.test.queue.slice(-2));
  assert.equal(await page.evaluate(()=>window.test.queue.length),beforeBulkCapture.queue+2,'reentrant saves enqueue each row once');
  assert.ok(stableBulk.every(row=>row.data.project_id===2&&row.data.section_id===21),'all bulk rows preserve the visible inferred targets');
  assert.ok(stableBulk.every(row=>row.data.routing_feedback.fields.length===0),'inferred bulk routes do not teach themselves');
  await page.evaluate(route=>window.test.change(route),route);await open();
  await page.locator('#todo-create-mode-switch [data-multi-add-mode="multi"]').click();
  await page.locator('#todo-multi-project').selectOption('3',{force:true});
  await page.waitForFunction(()=>document.querySelector('#todo-multi-section option[value="31"]'));
  await page.locator('#todo-multi-section').selectOption('31',{force:true});
  await rows.first().fill('Wäsche waschen');await rows.first().press('Enter');await rows.nth(1).fill('Post sortieren');
  await waitForPageCondition(page,()=>{const list=[...document.querySelectorAll('#todo-multi-add-rows .ui-multi-add-row')].filter(row=>row.querySelector('.ui-multi-add-input')?.value.trim());return list.length===2&&list.every(row=>String(row._multiParsed?.changes?.section_id)==='31');});
  const oldBulkGeneration=await page.evaluate(()=>window.test.memoryGeneration());
  await page.evaluate(()=>{window.test.holdSections();window.pendingBulkResetSave=window.test.feature.saveTodo({preventDefault(){}});});
  await page.waitForFunction(()=>window.test.sectionReadEntered());await page.evaluate(()=>window.test.resetMemory());
  await page.evaluate(()=>window.test.releaseSections());await page.evaluate(()=>window.pendingBulkResetSave);
  const bulkAfterReset=await page.evaluate(()=>window.test.queue.slice(-2));
  for(const row of bulkAfterReset){
    assert.equal(row.data.project_id,3);assert.equal(row.data.section_id,31);
    assert.equal(row.data.routing_feedback.generation,oldBulkGeneration,'bulk submissions cannot adopt a post-reset learning generation');
    assert.deepEqual(row.data.routing_feedback.fields,[],'reset bulk snapshots have no active learning intent');
  }
  await page.evaluate(route=>window.test.change(route),route);await open();
  await page.locator('#todo-create-mode-switch [data-multi-add-mode="multi"]').click();await rows.first().fill('Wäsche waschen');
  await waitForPageCondition(page,()=>String(document.querySelector('#todo-multi-add-rows .ui-multi-add-row')._multiParsed?.changes?.section_id)==='21');
  const beforeCanceledBulk=await page.evaluate(()=>window.test.queue.length);
  await page.evaluate(()=>{window.test.hold();window.canceledBulkSave=window.test.feature.saveTodo({preventDefault(){}});});
  await page.waitForFunction(()=>window.test.commitEntered());await page.evaluate(()=>window.test.detachCommit());
  await open();
  await page.locator('#todo-create-mode-switch [data-multi-add-mode="multi"]').click();await rows.first().fill('Wäsche waschen');
  await waitForPageCondition(page,()=>String(document.querySelector('#todo-multi-add-rows .ui-multi-add-row')._multiParsed?.changes?.section_id)==='21');
  await page.evaluate(()=>{window.test.holdSuccess();window.currentBulkSave=window.test.feature.saveTodo({preventDefault(){}});});
  await page.waitForFunction(()=>window.test.commitEntered());
  const activeBulkCaptures=await page.evaluate(()=>window.test.captures());
  await page.evaluate(()=>window.test.releaseDetached());await page.evaluate(()=>window.canceledBulkSave);
  await page.evaluate(()=>{window.repeatedCurrentBulkSave=window.test.feature.saveTodo({preventDefault(){}});});
  assert.equal(await page.evaluate(()=>window.test.captures()),activeBulkCaptures,'an older canceled save cannot clear the new operation or its captured snapshot');
  await page.evaluate(()=>window.test.release());await page.evaluate(()=>Promise.all([window.currentBulkSave,window.repeatedCurrentBulkSave]));
  assert.equal(await page.evaluate(()=>window.test.queue.length),beforeCanceledBulk+1,'only the current bulk operation commits after an older modal resets');
  assert.deepEqual(errors,[]);
  console.log('PASS Tasks shared-memory auto-fill, per-field AI badges, explicit choices, live changes, bulk and private durable feedback');
} finally {await browser.close();}

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  brainDumpCandidatePayload,
  brainDumpCandidateError,
  brainDumpCandidateMemoryFields,
  brainDumpOriginalRoute,
  changeBrainDumpCandidateModule,
  resolveBrainDumpShoppingTarget,
} from '../web/static/js/features/braindump-candidate-review.js';

const converted = { module_id: 'shopping', title: 'Book dentist', shopping_list_id: 'temp-list', shopping_section_id: 'temp-section', shopping_store_ids: ['temp-store'] };
converted._bdOriginalRoute = brainDumpOriginalRoute(converted);
changeBrainDumpCandidateModule(converted, 'tasks');
assert.equal(converted.shopping_list_id, null);
assert.equal(brainDumpCandidatePayload(converted).braindump_route.original_module_id, 'shopping');
assert.equal(brainDumpCandidatePayload(converted).braindump_route.original_shopping_list_id, null, 'temporary shopping IDs must not enter direct Task API requests');
assert.deepEqual(brainDumpCandidatePayload(converted).braindump_route.original_shopping_store_ids, []);
changeBrainDumpCandidateModule(converted, 'shopping');
assert.equal(converted.shopping_list_id, 'temp-list', 'module correction roundtrip preserves the previous domain draft');
assert.equal(resolveBrainDumpShoppingTarget({ shopping_list_id: 1, shopping_store_ids: [20] }, [{ id: 1, can_edit: true }], [{ id: 20, shopping_list_id: 2, active: true }]), null, 'cross-list store IDs fail closed');

const memory = { feedback: (fields, {eventId}) => ({event_id:eventId,generation:7,fields}) };
const inferred = {module_id:'shopping',title:'Milk',shopping_list_id:1,shopping_section_id:11,shopping_store_ids:[101,102],explicit_route_fields:[],client_mutation_id:'bd-memory-1'};
const inferredPayload = brainDumpCandidatePayload(inferred,{routingMemory:memory});
assert.deepEqual(inferredPayload.routing_feedback,{event_id:'bd-memory-1',generation:7,fields:[]},'accepting inferred routing sends a no-learning marker');
assert.deepEqual(inferredPayload.shopping_store_ids,[101,102],'all selected stores survive confirmation');
assert.deepEqual(brainDumpCandidateMemoryFields({...inferred,memory_route_fields:['list','section','stores'],explicit_route_fields:['stores']}),['list','section'],'explicit fields suppress only their own memory marker');
assert.equal(Object.hasOwn(brainDumpCandidatePayload({...inferred,module_id:'tasks',memory_route_fields:['section']}),'memory_route_fields'),false,'read-only memory metadata never enters a Task creation payload');
assert.ok(resolveBrainDumpShoppingTarget(inferred,[{id:1,can_edit:true,sections:[{id:11}]}],[{id:101,shopping_list_id:1},{id:102,shopping_list_id:1}]),'multiple authorized stores are valid');
const corrected = {...inferred,explicit_route_fields:['container','stores'],_bdRoutingFields:['section'],_bdRoutingEventId:'manual-event'};
assert.deepEqual(brainDumpCandidatePayload(corrected,{routingMemory:memory}).routing_feedback,{event_id:'manual-event',generation:7,fields:['list','stores','section']},'only spoken targets and manually touched fields teach shared routing');
assert.deepEqual(brainDumpCandidatePayload(corrected,{routingMemory:memory}),brainDumpCandidatePayload(corrected,{routingMemory:memory}),'feedback identity stays stable across render/retry');
assert.deepEqual(brainDumpCandidatePayload({...corrected,_bdRoutingListChanged:true,_bdRoutingFields:['list'],shopping_section_id:null,shopping_store_ids:[]},{routingMemory:memory}).routing_feedback.fields,['list'],'resetting child destinations during a list change does not teach explicit empty choices');
const switched = {...corrected,_bdOriginalRoute:{...brainDumpOriginalRoute(corrected),original_module_id:'tasks'},_bdRoutingFields:[]};
assert.deepEqual(brainDumpCandidatePayload(switched,{routingMemory:memory}).routing_feedback.fields,['module'],'a module correction does not teach a former Task project as a Shopping destination');

const inferredTask = {module_id:'tasks',title:'Wäsche waschen',project_id:7,section_id:71,project_name:'Personal',section_name:'Calls',memory_route_fields:['list','section'],explicit_route_fields:[],client_mutation_id:'bd-task-memory'};
assert.deepEqual(brainDumpCandidateMemoryFields(inferredTask),['list','section']);
assert.deepEqual(brainDumpCandidatePayload(inferredTask,{routingMemory:memory}).routing_feedback,{event_id:'bd-task-memory',generation:7,fields:[]},'Task predictions use the same no-learning envelope as Shopping');
assert.deepEqual(brainDumpCandidatePayload({...inferredTask,_bdRoutingFields:['section'],section_id:null,section_name:null},{routingMemory:memory}).routing_feedback.fields,['section'],'an explicit empty Task section is a deliberate choice');
assert.deepEqual(brainDumpCandidatePayload({...inferredTask,_bdRoutingProjectChanged:true,_bdRoutingFields:['list'],explicit_route_fields:['container','section'],section_id:null,section_name:null},{routingMemory:memory}).routing_feedback.fields,['list'],'project changes do not teach an implicit empty section');
assert.deepEqual(brainDumpCandidateMemoryFields({...inferredTask,_bdRoutingFields:['section']}),['list'],'manual Task section changes remove only the section source icon');
assert.deepEqual(brainDumpOriginalRoute(inferredTask),{original_module_id:'tasks',original_shopping_list_id:null,original_shopping_section_id:null,original_shopping_store_ids:[],original_project_id:7,original_section_id:71,original_project_name:'Personal',original_section_name:'Calls',original_route_present:true});
const taskTargets={projects:[{id:7,name:'Personal'}],sections:[{id:71,project_id:7}]};
assert.equal(brainDumpCandidateError(inferredTask,taskTargets),null);
assert.equal(brainDumpCandidateError({...inferredTask,project_id:'temp-project'},taskTargets),'capture.target.required','temporary Task projects cannot silently fall back to a name route');
assert.equal(brainDumpCandidateError({...inferredTask,section_id:'temp-section'},taskTargets),'capture.target.required','temporary Task sections must wait for canonical IDs');
assert.equal(brainDumpCandidateError(inferredTask,{...taskTargets,projects:[{id:7,name:'Personal',can_edit:0}]}),'capture.target.required','numeric read-only project flags fail closed');
assert.equal(brainDumpCandidateError(inferredTask,{...taskTargets,projects:[{id:7,name:'Personal',can_edit_content:0}]}),'capture.target.required','numeric content-edit revocation fails closed');
assert.equal(brainDumpCandidateError({...inferredTask,project_id:null,section_id:null},{...taskTargets,projects:[{id:7,name:'Personal'},{id:8,name:'Personal'}]}),'capture.target.required','ambiguous legacy names require an explicit target instead of guessing');
assert.equal(brainDumpCandidateError(inferredTask,{...taskTargets,projects:[]}), 'capture.target.required','revoked Task IDs fail closed');
assert.equal(brainDumpCandidateError({...inferredTask,section_id:72},taskTargets), 'capture.target.required','cross-project section IDs fail closed');
const taskRoundtrip={...inferredTask,_bdRoutingFields:['section'],_bdOriginalRoute:brainDumpOriginalRoute(inferredTask)};
changeBrainDumpCandidateModule(taskRoundtrip,'shopping');
assert.deepEqual(taskRoundtrip._bdRoutingFields,[],'Task field edits are not carried into Shopping intent');
assert.deepEqual(brainDumpCandidatePayload(taskRoundtrip,{routingMemory:memory}).routing_feedback.fields,['module'],'module-only corrections carry explicit module intent without an inferred container');
assert.equal(taskRoundtrip.project_id,null);
changeBrainDumpCandidateModule(taskRoundtrip,'tasks');
assert.equal(taskRoundtrip.project_id,7);
assert.deepEqual(taskRoundtrip._bdRoutingFields,['section'],'module roundtrips restore only their own explicit choices');

const fixture = `
  import { createBrainDumpLiveFeature } from '/static/js/features/braindump-live.js';
  import { initI18n } from '/static/js/i18n/index.js';
  localStorage.setItem('jwt_token', 'fixture-session');
  localStorage.setItem('nia-todo-language', '${process.env.NIA_BRAINDUMP_SCREENSHOTS ? 'de' : 'en'}');
  await initI18n();
  let active = 'tasks', modules = ['tasks', 'shopping'];
  let projects = [{id:7,name:'Personal',workspace_id:9}];
  let sections = [{id:71,project_id:7,name:'Calls'},{id:81,project_id:8,name:'Laundry'}];
  let sectionGate = null, releaseSections = null, sectionReads = 0;
  let lists = [
    { id: 1, name: 'Same name', can_edit: true, sections: [{id:11,name:'Cold'}] },
    { id: 2, name: 'Same name', can_edit: true, sections: [{id:21,name:'Fruit'}] },
    { id: 3, name: 'Forbidden', can_edit: false, sections: [] },
  ];
  let stores = [
    {id:101,shopping_list_id:1,name:'One',active:true},
    {id:201,shopping_list_id:2,name:'Two',active:true},
    {id:202,shopping_list_id:2,name:'Inactive',active:false},
  ];
  let failList = null;
  let shoppingGate = null, releaseShopping = null, shoppingFinished = 0;
  const shoppingAttempts = [], shoppingSaved = [];
  class Recorder extends EventTarget {
    static isTypeSupported() { return true; }
    constructor() { super(); this.state='inactive'; this.mimeType='audio/webm'; }
    start() { this.state='recording'; }
    requestData() { this.dispatchEvent(Object.assign(new Event('dataavailable'), {data:new Blob(['x'.repeat(128)], {type:'audio/webm'})})); }
    stop() { this.state='inactive'; this.dispatchEvent(new Event('stop')); }
  }
  window.MediaRecorder = Recorder;
  window.AudioContext = undefined;
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}});
  const feature = createBrainDumpLiveFeature({
    routingMemory: {feedback:(fields,{eventId})=>({event_id:eventId,generation:7,fields})},
    getActiveModule: () => active,
    getSupportedModules: () => modules,
    getLauncherRoot: () => document.getElementById('module-floating-slot'),
    getProjects: () => projects,
    getSections: () => [], // Dashboard/current-project projection is deliberately incomplete.
    loadTaskSections: async () => {
      sectionReads++; const result=structuredClone(sections); const gate=sectionGate; sectionGate=null;
      if(gate) await gate; return result;
    },
    getCurrentWorkspaceId: () => 9,
    getShoppingLists: () => lists,
    getShoppingStores: () => stores,
    placesApi: {list:async()=>({places:[]})},
    createShoppingCandidates: async (candidates,{isCurrent}) => {
      shoppingAttempts.push(structuredClone(candidates));
      if (shoppingGate) { const gate = shoppingGate; shoppingGate = null; await gate; }
      shoppingFinished++;
      if (!isCurrent()) throw new Error('cancelled');
      if (String(candidates[0].shopping_list_id)===String(failList)) {failList=null; throw new Error('fixture save failure');}
      shoppingSaved.push(...structuredClone(candidates));
      return candidates.map((candidate,index)=>({id:1000+shoppingSaved.length+index,...candidate}));
    },
  });
  window.test = {
    init:()=>feature.init(), open:()=>feature.open(),
    module:value=>{active=value;feature.refreshLauncher();},
    modules:value=>{modules=value;feature.refreshLauncher();},
    lists:value=>{lists=value;feature.refreshLauncher();},
    projects:value=>{projects=value;feature.refreshLauncher();},
    sections:value=>{sections=value;}, reconcile:()=>feature.refreshLauncher(),
    holdSections:()=>{sectionGate=new Promise(resolve=>{releaseSections=resolve;});},
    releaseSections:()=>releaseSections?.(), sectionReads:()=>sectionReads,
    failList:value=>{failList=value;},
    holdNext:()=>{shoppingGate=new Promise(resolve=>{releaseShopping=resolve;});},
    release:()=>releaseShopping?.(), finished:()=>shoppingFinished,
    attempts:()=>structuredClone(shoppingAttempts), saved:()=>structuredClone(shoppingSaved),
  };
  await feature.init();
`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const errors = [];
page.on('pageerror', error => errors.push(String(error.stack || error)));
let accessCalls = 0;
let candidates = [];
const extractionRequests = [];
const taskRequests = [];
const taskIds = new Set();
let failTaskOnce = false;
try {
  await page.route('http://nia.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/style.css"></head><body><div id="app"><div id="login-overlay" style="display:none"></div><div id="module-floating-slot"></div></div><script type="module" src="/fixture.js"></script></body></html>' });
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: fixture });
    if (url.pathname.endsWith('/api/braindump/v2/access')) {
      accessCalls++;
      return route.fulfill({ status: accessCalls === 1 ? 503 : 200, json: { enabled: true } });
    }
    if (url.pathname.endsWith('/audio-segment/transcribe')) return route.fulfill({ json: { transcript: 'Fixture speech, never sent to a transcription service.' } });
    if (url.pathname.endsWith('/text-segment/extract')) {
      extractionRequests.push(route.request().postDataJSON());
      return route.fulfill({ json: { json: { candidates } } });
    }
    if (url.pathname.endsWith('/api/braindump/v2/todos')) {
      const body = route.request().postDataJSON();
      taskRequests.push(body);
      body.candidates.forEach(candidate => taskIds.add(candidate.client_mutation_id));
      if (failTaskOnce) { failTaskOnce = false; return route.fulfill({ status: 503, body: 'fixture ambiguous response' }); }
      return route.fulfill({ json: { todos: body.candidates.map(candidate => ({ id: candidate.client_mutation_id, title: candidate.title })) } });
    }
    if (url.pathname.startsWith('/static/')) {
      try {
        return route.fulfill({ contentType: url.pathname.endsWith('.json') ? 'application/json' : url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: readFileSync(new URL('../web' + url.pathname, import.meta.url), 'utf8') });
      } catch { return route.fulfill({ status: 404 }); }
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('http://nia.test/');
  await page.waitForFunction(() => Boolean(window.test));
  await page.evaluate(() => window.test.init());
  const launcher = page.locator('#braindump-fab');
  await launcher.waitFor({ state: 'visible' });
  assert(accessCalls >= 2, 'a failed access request must recover on init');
  await page.evaluate(() => window.test.init());
  assert.equal(await launcher.count(), 1, 'init is idempotent after modal creation');
  assert.equal(await launcher.evaluate(element => element.parentElement.id), 'module-floating-slot');
  await page.evaluate(() => window.test.module('recipes'));
  assert.equal(await launcher.isVisible(), false, 'recipes must not expose a stale Tasks launcher');
  await page.evaluate(() => window.test.module('shopping'));
  assert.equal(await launcher.isVisible(), true);
  await page.evaluate(() => { localStorage.removeItem('jwt_token'); return window.test.init(); });
  assert.equal(await launcher.isVisible(), false, 'logout hides the shared launcher');
  await page.evaluate(() => { localStorage.setItem('jwt_token', 'second-session'); return window.test.init(); });
  assert.equal(await launcher.isVisible(), true, 'relogin recovers without recreating the page');

  const capture = async values => {
    candidates = values;
    await launcher.click();
    await page.locator('#braindump-record').waitFor({ state: 'visible' });
    await page.locator('#braindump-record').click();
    try { await page.waitForFunction(count => document.querySelectorAll('.braindump-candidate-card').length === count, values.length); }
    catch (error) { error.message += '\nCapture diagnostics: ' + JSON.stringify({errors,extractionRequests,state:await page.locator('#braindump-error').textContent()}); throw error; }
    await page.waitForFunction(() => !document.querySelector('#braindump-modal').classList.contains('is-processing'));
  };
  const close = () => page.locator('#braindump-close').click();
  const assertEditorSurface = async () => {
    const surface = await page.evaluate(() => {
      const card = document.querySelector('.braindump-candidate-card.is-editing');
      const style = getComputedStyle(card);
      const cardBounds = card.getBoundingClientRect();
      const checkboxBounds = card.querySelector('.braindump-check').getBoundingClientRect();
      const editBounds = card.querySelector('.braindump-edit-candidate').getBoundingClientRect();
      return {
        radius: parseFloat(style.borderTopLeftRadius),
        checkboxOffset: checkboxBounds.top - cardBounds.top,
        editCenterOffset: Math.abs((editBounds.top + editBounds.bottom - cardBounds.top - cardBounds.bottom) / 2),
        editRightInset: cardBounds.right - editBounds.right,
        editorOverflow: getComputedStyle(document.querySelector('#braindump-candidates')).overflowY,
        sections: [...document.querySelectorAll('#braindump-modal .ui-detail-section')].map(section => {
          const sectionStyle = getComputedStyle(section);
          return [sectionStyle.borderLeftWidth, sectionStyle.borderRightWidth, sectionStyle.borderBottomWidth];
        }),
      };
    });
    assert(surface.radius <= 24, 'an expanded editor must retain rounded corners instead of becoming an ellipse');
    assert(surface.checkboxOffset <= 16, 'selection stays aligned with the title when editor fields expand');
    assert(surface.editCenterOffset < 2 && surface.editRightInset <= 16,
      'the edit action stays vertically centered at the right edge of the expanded card');
    assert.equal(surface.editorOverflow, 'visible', 'expanded fields use the modal scroll area instead of a clipped nested list');
    assert(surface.sections.every(borders => borders.every(width => width === '0px')),
      'review sections use shared dividers without rectangular side/bottom frames');
    assert.doesNotMatch(await page.locator('.braindump-results-head h4').innerText(), /todo/i,
      'mixed review headings must describe suggestions without assuming a Todo destination');
  };

  await page.evaluate(() => window.test.failList(2));
  await capture([
    {module_id:'shopping',title:'Milk',shopping_list_id:1,shopping_section_id:11,shopping_store_ids:[101],quantity_value:0,quantity_unit:'l',memory_route_fields:['list','section','stores']},
    {module_id:'shopping',title:'Apples',shopping_list_id:2,shopping_section_id:21,shopping_store_ids:[201],quantity_value:3,quantity_unit:'x'},
    {module_id:'tasks',title:'Call dentist',project_name:'Personal',section_name:'Calls'},
  ]);
  assert.equal(await page.locator('.braindump-candidate-card').filter({hasText:'Milk'}).locator('[data-source="memory"] .quick-add-memory-icon svg').count(),3,'BrainDump displays one shared brain badge per actually remembered field');
  assert.equal(await page.locator('.braindump-candidate-card').filter({hasText:'Apples'}).locator('[data-source="memory"]').count(),0,'model-inferred fields are not falsely labeled as remembered');
  assert.deepEqual(extractionRequests.at(-1).supported_modules, ['tasks', 'shopping']);
  assert.equal(extractionRequests.at(-1).workspace_id, 9);
  assert.equal(await page.locator('[data-bd-group="shopping:1"]').count(), 1);
  assert.equal(await page.locator('[data-bd-group="shopping:2"]').count(), 1, 'identical list names remain distinct target groups');
  await page.locator('#braindump-create').click();
  await page.waitForFunction(() => document.querySelector('#braindump-create-status').textContent.includes('fixture save failure'));
  assert.equal(await page.locator('.braindump-candidate-card.is-saved').count(), 1, 'successful list group stays accepted after later failure');
  await page.locator('#braindump-create').click();
  await page.waitForFunction(() => document.querySelectorAll('.braindump-candidate-card.is-saved').length === 3);
  const attempts = await page.evaluate(() => window.test.attempts());
  assert.deepEqual(attempts.map(group => Number(group[0].shopping_list_id)), [1, 2, 2], 'retry must not replay the accepted first group');
  assert.equal(attempts[1][0].client_mutation_id, attempts[2][0].client_mutation_id, 'failed group retries retain mutation identity');
  assert.equal(attempts[0][0].quantity_value, 0, 'zero quantity is preserved');
  assert.deepEqual(attempts[0][0].routing_feedback.fields,[], 'inferred preview targets do not reinforce themselves');
  assert.deepEqual(attempts[1][0].routing_feedback,attempts[2][0].routing_feedback,'retrying a failed Shopping group retains the same routing event');
  assert.match(attempts[0][0].client_mutation_id, /^temp-bd-/);
  assert.equal(taskRequests.length, 1);
  assert.deepEqual(taskRequests[0].candidates[0].routing_feedback.fields,[],'model-inferred Task destinations do not reinforce themselves');
  assert.equal(await page.locator('#braindump-modal').isVisible(), true, 'success remains inspectable without an unscoped delayed close');
  await close();

  await capture([{module_id:'shopping',title:'Milk',shopping_list_id:1,shopping_section_id:11,shopping_store_ids:[101],memory_route_fields:['list','section','stores']}]);
  await page.locator('.braindump-edit-candidate').click();
  await page.locator('[data-bd-field="shopping_section_id"]').selectOption('',{force:true});
  assert.equal(await page.locator('.braindump-candidate-card [data-source="memory"]').count(),2,'clearing a section removes that brain icon while preserving independently remembered fields');
  const renamed=page.locator('[data-bd-field="title"]');
  await renamed.fill('Butter');
  assert.equal(await page.locator('.braindump-candidate-card [data-source="memory"]').count(),0,'editing a name clears stale memory markers immediately without replacing the input');
  assert.equal(await renamed.evaluate(input=>input===document.activeElement),true,'badge refresh preserves the editor input focus');
  await close();

  await page.evaluate(() => window.test.projects([{id:7,name:'Personal',workspace_id:9},{id:8,name:'Personal',workspace_id:9}]));
  await capture([{module_id:'tasks',title:'Wäsche waschen',project_id:7,section_id:71,project_name:'Personal',section_name:'Calls',explicit_route_fields:[],memory_route_fields:['list','section']}]);
  assert.equal(await page.locator('.braindump-candidate-card [data-source="memory"] .quick-add-memory-icon svg').count(),2,'Task project and section use the same automatic AI chips as Shopping');
  assert.equal(await page.locator('.braindump-candidate-card [data-source="memory"] button').count(),0,'Task memories need no acceptance step');
  if (process.env.NIA_BRAINDUMP_SCREENSHOTS) await page.screenshot({path:'/tmp/nia-braindump-tasks-memory.png',animations:'disabled'});
  await page.locator('.braindump-edit-candidate').click();
  assert.equal(await page.locator('[data-bd-field="project_name"]').inputValue(),'7','stable IDs distinguish identical project names');
  assert.equal(await page.locator('[data-bd-field="section_name"]').inputValue(),'71');
  await page.locator('[data-bd-field="section_name"]').selectOption('',{force:true});
  assert.equal(await page.locator('.braindump-candidate-card [data-source="memory"]').count(),1,'clearing a Task section preserves the independently remembered project');
  await page.locator('[data-bd-field="project_name"]').selectOption('8',{force:true});
  assert.equal(await page.locator('[data-bd-field="section_name"]').inputValue(),'');
  assert.equal(await page.locator('[data-bd-field="section_name"] option[value="71"]').count(),0,'project switching removes foreign Task sections');
  await page.locator('[data-bd-field="section_name"]').selectOption('81',{force:true});
  await page.locator('#braindump-create').click();
  await page.waitForFunction(() => document.querySelector('.braindump-candidate-card').classList.contains('is-saved'));
  const learnedTask=taskRequests.at(-1).candidates[0];
  assert.equal(learnedTask.project_id,8);
  assert.equal(learnedTask.section_id,81);
  assert.equal(learnedTask.braindump_route.original_project_id,7);
  assert.deepEqual(learnedTask.routing_feedback.fields,['list','section']);
  assert.equal('memory_route_fields' in learnedTask,false);
  await close();

  await capture([{module_id:'tasks',title:'Wäsche waschen',project_id:7,section_id:71,project_name:'Personal',section_name:'Calls',explicit_route_fields:[],memory_route_fields:['list','section']}]);
  await page.locator('.braindump-edit-candidate').click();
  const taskTitle=page.locator('[data-bd-field="title"]');
  await taskTitle.fill('Wäsche aufhängen');
  assert.equal(await page.locator('.braindump-candidate-card [data-source="memory"]').count(),0,'Task name edits clear stale origins immediately');
  assert.equal(await taskTitle.evaluate(input=>input===document.activeElement),true,'Task badge changes preserve input focus');
  await close();

  await capture([{module_id:'tasks',title:'Wäsche waschen',project_id:7,section_id:71,project_name:'Personal',section_name:'Calls',explicit_route_fields:[],memory_route_fields:['list','section']}]);
  await page.evaluate(() => window.test.projects([{id:8,name:'Personal',workspace_id:9}]));
  assert.equal(await page.locator('#braindump-create').isDisabled(),true,'Task parent revocation blocks an open preview');
  assert.equal(await page.locator('.braindump-candidate-card [data-source="memory"]').count(),0,'revoked routes lose their remembered-field markers');
  assert.doesNotMatch(await page.locator('.braindump-candidate-card').textContent(),/Personal|Calls/,'revoked Task IDs do not display stale private target names');
  await close();
  await page.evaluate(() => window.test.projects([{id:7,name:'Personal',workspace_id:9},{id:8,name:'Personal',workspace_id:9}]));

  const readsBeforeRevocation=await page.evaluate(()=>window.test.sectionReads());
  await capture([{module_id:'tasks',title:'Wäsche waschen',project_id:7,section_id:71,project_name:'Personal',section_name:'Calls',explicit_route_fields:[],memory_route_fields:['list','section']}]);
  assert.equal(await page.locator('#braindump-create').isDisabled(),false,'a complete child catalog supports other-project targets while the Dashboard projection is empty');
  const tasksBeforeSectionRevocation=taskRequests.length;
  await page.evaluate(()=>window.test.sections([{id:81,project_id:8,name:'Laundry'}]));
  await page.locator('#braindump-create').click();
  await page.waitForFunction(()=>document.querySelector('.braindump-candidate-card').classList.contains('is-editing'));
  assert.equal(taskRequests.length,tasksBeforeSectionRevocation,'a fresh child catalog is revalidated before a Task POST');
  assert.equal(await page.locator('#braindump-create').isDisabled(),true);
  assert.ok(await page.evaluate(()=>window.test.sectionReads())>readsBeforeRevocation);
  await close();
  await page.evaluate(()=>window.test.sections([{id:71,project_id:7,name:'Calls'},{id:81,project_id:8,name:'Laundry'}]));

  await capture([{module_id:'tasks',title:'Wäsche waschen',project_id:7,section_id:71,project_name:'Personal',section_name:'Calls',explicit_route_fields:[],memory_route_fields:['list','section']}]);
  const readsBeforeRace=await page.evaluate(()=>window.test.sectionReads());
  await page.evaluate(()=>{window.test.holdSections();window.test.reconcile();});
  await page.waitForFunction(count=>window.test.sectionReads()>count,readsBeforeRace);
  await page.evaluate(()=>{window.test.sections([]);window.test.reconcile();});
  await page.waitForFunction(()=>document.querySelector('#braindump-create').disabled);
  await page.evaluate(()=>window.test.releaseSections());
  assert.equal(await page.locator('#braindump-create').isDisabled(),true,'an older catalog read cannot undo a later section revocation');
  await close();
  await page.evaluate(()=>window.test.sections([{id:71,project_id:7,name:'Calls'},{id:81,project_id:8,name:'Laundry'}]));

  await capture([{module_id:'tasks',title:'Wäsche waschen',project_id:7,section_id:71,project_name:'Personal',section_name:'Calls',explicit_route_fields:[],memory_route_fields:['list','section']}]);
  const readsBeforeNewSession=await page.evaluate(()=>window.test.sectionReads());
  await page.evaluate(()=>{window.test.holdSections();window.test.reconcile();});
  await page.waitForFunction(count=>window.test.sectionReads()>count,readsBeforeNewSession);
  await close();
  await page.evaluate(()=>window.test.sections([]));
  await capture([{module_id:'tasks',title:'New capture',project_id:7,section_id:71,project_name:'Personal',section_name:'Calls',explicit_route_fields:[],memory_route_fields:['list','section']}]);
  assert.equal(await page.locator('#braindump-create').isDisabled(),true);
  await page.evaluate(()=>window.test.releaseSections());
  assert.equal(await page.locator('#braindump-create').isDisabled(),true,'a catalog response from a closed capture cannot populate a newer capture');
  await close();
  await page.evaluate(()=>window.test.sections([{id:71,project_id:7,name:'Calls'},{id:81,project_id:8,name:'Laundry'}]));

  await capture([{module_id:'shopping',title:'Tomaten',shopping_list_id:null,shopping_store_ids:[],quantity_value:.25,quantity_unit:'Packung'}]);
  assert.equal(await page.locator('#braindump-create').isDisabled(), true);
  await page.locator('.braindump-edit-candidate').click();
  await assertEditorSurface();
  const unitField = page.locator('[data-bd-field="quantity_unit"]');
  assert.equal(await unitField.inputValue(), process.env.NIA_BRAINDUMP_SCREENSHOTS ? 'Pack.' : 'pack', 'BrainDump edits use the fixed current-locale unit label');
  await unitField.fill('Liter'); await unitField.blur();
  assert.equal(await page.locator('[data-bd-field="quantity_unit"]').inputValue(), 'l');
  await page.locator('[data-bd-field="quantity_unit"]').fill('Hansdampf');
  await page.locator('[data-bd-field="quantity_unit"]').blur();
  assert.equal(await page.locator('[data-bd-field="quantity_unit"]').inputValue(), 'Hansdampf');
  await page.locator('[data-bd-field="quantity_unit"]').fill('Lita');
  await page.locator('[data-bd-field="quantity_unit"]').blur();
  assert.equal(await page.locator('[data-bd-field="quantity_unit"]').inputValue(), 'Lita', 'no STT/fuzzy correction');
  if (process.env.NIA_BRAINDUMP_SCREENSHOTS) {
    await page.locator('.braindump-candidate-card.is-editing').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/nia-braindump-review-desktop.png', animations: 'disabled' });
  }
  const listField = page.locator('[data-bd-field="shopping_list_id"]');
  assert.equal(await listField.locator('option[value="3"]').count(), 0, 'read-only destinations are not offered');
  await listField.selectOption('1', { force: true });
  await page.locator('[data-bd-field="shopping_store_ids"]').selectOption('101', { force: true });
  await page.locator('[data-bd-field="shopping_section_id"]').selectOption('11', { force: true });
  await page.locator('[data-bd-field="shopping_list_id"]').selectOption('2', { force: true });
  assert.equal(await page.locator('[data-bd-field="shopping_section_id"]').inputValue(), '');
  assert.equal(await page.locator('[data-bd-field="shopping_store_ids"]').inputValue(), '', 'list change clears list-scoped child routing');
  assert.equal(await page.locator('[data-bd-field="shopping_store_ids"] option[value="101"]').count(), 0);
  assert.equal(await page.locator('[data-bd-field="shopping_store_ids"] option[value="202"]').count(), 0);
  const beforeIme = (await page.evaluate(() => window.test.attempts())).length;
  await page.locator('[data-bd-field="title"]').dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, keyCode: 229 });
  assert.equal((await page.evaluate(() => window.test.attempts())).length, beforeIme, 'IME composition does not submit a candidate');
  await page.locator('[data-bd-field="module_id"]').selectOption('tasks', { force: true });
  assert.equal(await page.locator('[data-bd-field="shopping_list_id"]').count(), 0);
  assert.equal(await page.locator('[data-bd-field="project_name"]').count(), 1, 'module correction swaps the same shared field surface');
  await page.locator('#braindump-create').click();
  await page.waitForFunction(() => document.querySelector('.braindump-candidate-card').classList.contains('is-saved'));
  assert.equal(taskRequests.at(-1).candidates[0].braindump_route.original_module_id, 'shopping');
  assert.deepEqual(taskRequests.at(-1).candidates[0].routing_feedback.fields,['module'],'switching only the module never teaches an inferred default project');
  assert.deepEqual(taskRequests.at(-1).candidates[0].explicit_route_fields,[],'module learning does not alter the spoken-container provenance contract');
  await close();

  failTaskOnce = true;
  await capture([{module_id:'tasks',title:'Retry task',project_name:null}]);
  await page.locator('#braindump-create').click();
  await page.waitForFunction(() => document.querySelector('#braindump-create-status').textContent.includes('fixture ambiguous response'));
  const failedIdentity = taskRequests.at(-1).candidates[0].client_mutation_id;
  assert.equal(await page.locator('.braindump-edit-candidate').isDisabled(), true, 'uncertain Task receipt freezes field/type editing');
  const originalTitle = taskRequests.at(-1).candidates[0].title;
  await page.evaluate(() => {
    const card=document.querySelector('.braindump-candidate-card');
    const key=card.querySelector('[data-bd-candidate-key]').dataset.bdCandidateKey;
    for(const [name,value] of [['title','Changed after uncertain commit'],['module_id','shopping']]) {
      const input=document.createElement('input');input.dataset.bdField=name;input.dataset.bdCandidateKey=key;input.value=value;card.append(input);
      input.dispatchEvent(new Event('input',{bubbles:true}));input.remove();
    }
  });
  await page.locator('#braindump-create').click();
  await page.waitForFunction(() => document.querySelector('.braindump-candidate-card').classList.contains('is-saved'));
  assert.equal(taskRequests.at(-1).candidates[0].client_mutation_id, failedIdentity);
  assert.equal(taskRequests.at(-1).candidates[0].title, originalTitle, 'retry replays the immutable original payload');
  assert.equal(taskRequests.at(-1).candidates[0].module_id, 'tasks');
  assert.equal([...taskIds].filter(id => id === failedIdentity).length, 1);
  await close();

  const savedBeforeLogout = (await page.evaluate(() => window.test.saved())).length;
  const finishedBeforeLogout = await page.evaluate(() => window.test.finished());
  await capture([{module_id:'shopping',title:'Queued logout',shopping_list_id:1,shopping_store_ids:[]}]);
  await page.evaluate(() => window.test.holdNext());
  await page.locator('#braindump-create').click();
  await page.waitForFunction(() => document.querySelector('#braindump-create').disabled);
  await page.evaluate(() => {localStorage.removeItem('jwt_token');window.test.release();});
  await page.waitForFunction(count => window.test.finished() > count, finishedBeforeLogout);
  assert.equal((await page.evaluate(() => window.test.saved())).length, savedBeforeLogout, 'queued write must recheck auth without needing a launcher refresh');
  await close();
  await page.evaluate(() => {localStorage.setItem('jwt_token','third-session');return window.test.init();});

  const tasksBeforeDisable = taskRequests.length;
  const savedBeforeDisable = (await page.evaluate(() => window.test.saved())).length;
  await capture([
    {module_id:'shopping',title:'Accept before Tasks disabled',shopping_list_id:1,shopping_store_ids:[]},
    {module_id:'tasks',title:'Must not submit after disabling Tasks'},
  ]);
  await page.evaluate(() => window.test.holdNext());
  await page.locator('#braindump-create').click();
  await page.waitForFunction(() => document.querySelector('#braindump-create').disabled);
  await page.evaluate(() => {window.test.modules(['shopping']);window.test.release();});
  await page.waitForFunction(count => window.test.saved().length > count, savedBeforeDisable);
  await page.waitForFunction(() => document.querySelector('#braindump-create-status').textContent.length > 0);
  assert.equal(taskRequests.length, tasksBeforeDisable, 'every later Task group rechecks enabled modules before POST');
  await close();

  await page.setViewportSize({ width: 360, height: 780 });
  await page.evaluate(() => window.test.modules(['shopping']));
  await capture([{module_id:'shopping',title:'A long shopping candidate title which must wrap on mobile',shopping_list_id:2,shopping_store_ids:[],quantity_value:1.5,quantity_unit:'VeryLongUnitWithoutSpaces'}]);
  await page.locator('.braindump-edit-candidate').click();
  await assertEditorSurface();
  if (process.env.NIA_BRAINDUMP_SCREENSHOTS) {
    await page.locator('.braindump-candidate-card.is-editing').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/nia-braindump-review-mobile.png', animations: 'disabled' });
  }
  const layout = await page.evaluate(() => ({ viewport:innerWidth, body:document.documentElement.scrollWidth, modal:document.querySelector('.braindump-modal-content').getBoundingClientRect().width }));
  assert(layout.body <= layout.viewport && layout.modal <= layout.viewport, 'mobile shared candidate editor has no horizontal overflow');
  assert.deepEqual(extractionRequests.at(-1).supported_modules, ['shopping']);
  await page.evaluate(() => window.test.lists([]));
  assert.equal(await page.locator('#braindump-create').isDisabled(), true, 'revoked or missing destinations block confirmation');
  await close();
  assert.deepEqual(errors, []);
  console.log('✅ Mixed BrainDump modules, launcher recovery, editable routing, durable partial retries and mobile review passed');
} finally {
  await browser.close();
}

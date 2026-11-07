#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  brainDumpCandidatePayload,
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

const fixture = `
  import { createBrainDumpLiveFeature } from '/static/js/features/braindump-live.js';
  import { initI18n } from '/static/js/i18n/index.js';
  localStorage.setItem('jwt_token', 'fixture-session');
  localStorage.setItem('nia-todo-language', '${process.env.NIA_BRAINDUMP_SCREENSHOTS ? 'de' : 'en'}');
  await initI18n();
  let active = 'tasks', modules = ['tasks', 'shopping'];
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
    getActiveModule: () => active,
    getSupportedModules: () => modules,
    getLauncherRoot: () => document.getElementById('module-floating-slot'),
    getProjects: () => [{id:7,name:'Personal',workspace_id:9}],
    getSections: () => [{id:71,project_id:7,name:'Calls'}],
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
      return {
        radius: parseFloat(style.borderTopLeftRadius),
        checkboxOffset: checkboxBounds.top - cardBounds.top,
        editorOverflow: getComputedStyle(document.querySelector('#braindump-candidates')).overflowY,
        sections: [...document.querySelectorAll('#braindump-modal .ui-detail-section')].map(section => {
          const sectionStyle = getComputedStyle(section);
          return [sectionStyle.borderLeftWidth, sectionStyle.borderRightWidth, sectionStyle.borderBottomWidth];
        }),
      };
    });
    assert(surface.radius <= 24, 'an expanded editor must retain rounded corners instead of becoming an ellipse');
    assert(surface.checkboxOffset <= 16, 'selection stays aligned with the title when editor fields expand');
    assert.equal(surface.editorOverflow, 'visible', 'expanded fields use the modal scroll area instead of a clipped nested list');
    assert(surface.sections.every(borders => borders.every(width => width === '0px')),
      'review sections use shared dividers without rectangular side/bottom frames');
    assert.doesNotMatch(await page.locator('.braindump-results-head h4').innerText(), /todo/i,
      'mixed review headings must describe suggestions without assuming a Todo destination');
  };

  await page.evaluate(() => window.test.failList(2));
  await capture([
    {module_id:'shopping',title:'Milk',shopping_list_id:1,shopping_section_id:11,shopping_store_ids:[101],quantity_value:0,quantity_unit:'l'},
    {module_id:'shopping',title:'Apples',shopping_list_id:2,shopping_section_id:21,shopping_store_ids:[201],quantity_value:3,quantity_unit:'x'},
    {module_id:'tasks',title:'Call dentist',project_name:'Personal',section_name:'Calls'},
  ]);
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
  assert.match(attempts[0][0].client_mutation_id, /^temp-bd-/);
  assert.equal(taskRequests.length, 1);
  assert.equal(await page.locator('#braindump-modal').isVisible(), true, 'success remains inspectable without an unscoped delayed close');
  await close();

  await capture([{module_id:'shopping',title:'Tomaten',shopping_list_id:null,shopping_store_ids:[]}]);
  assert.equal(await page.locator('#braindump-create').isDisabled(), true);
  await page.locator('.braindump-edit-candidate').click();
  await assertEditorSurface();
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

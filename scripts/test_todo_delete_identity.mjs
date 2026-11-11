#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

// Real Todo controller, renderer and confirmation/history at a private origin.
// All persistence and requests are in-memory; no service or installed DB is used.
const source = `
import { initI18n } from '/static/js/i18n/index.js';
import { renderTodoItem } from '/static/js/features/todo-rendering.js';
import { createTodosFeature } from '/static/js/features/todos.js';
import { createConfirmDialogFeature } from '/static/js/features/confirm-dialog.js';
await initI18n();
let todos=[], actor={id:1}, mutations=[], deleted=[], toasts=[], commitGate=null, commitStarted=false, commitSettled=0, session=0;
const ref={privacyGeneration:0};
const render=()=>{document.getElementById('todo-root').innerHTML=todos.map(renderTodoItem).join('');};
const confirmation=createConfirmDialogFeature(); confirmation.bindConfirmDialog();
const feature=createTodosFeature({
 getTodos:()=>todos,setTodos:next=>{todos=next;},getProjects:()=>[{id:9}],getSections:()=>[],
 getCurrentProjectId:()=>null,getCurrentWorkspaceId:()=>null,getCurrentUser:()=>actor,setCurrentUser:()=>{},
 getAppInitialized:()=>true,getDb:()=>({}),dbPut:async()=>{},dbGetAll:async()=>[],
 deleteFromDB:async(_store,id)=>{deleted.push(id);},addToSyncQueue:async(action,data)=>{mutations.push({action,data});},
 runSyncQueueMutation:async build=>{commitStarted=true;try{if(commitGate)await commitGate.promise;return await build(async(action,data)=>{mutations.push({action,data});});}finally{commitSettled++;}},
 isOnlineForSync:()=>false,syncWithServer:async()=>{},todosApi:{},sectionsApi:{},placesApi:null,
 renderProjects(){},renderStats(){},renderTodos:render,closeModal(){},
 confirmDanger:options=>confirmation.confirmDanger(options),showToast:(message,action)=>toasts.push({message,action}),
 setupDescPreview(){},renderMarkdown:String,syncInProgressRef:ref,getSessionIdentity:()=>session,
});
window.test={feature,
 reset:rows=>{todos=rows;actor={id:1};mutations=[];deleted=[];toasts=[];commitGate=null;commitStarted=false;commitSettled=0;session=0;ref.privacyGeneration=0;feature.resetTodoShortcutTarget();document.getElementById('todo-id').value='';render();},
 state:()=>({todos,mutations,deleted,toasts,commitStarted,commitSettled}),
 remap:(from,to)=>{todos=todos.map(todo=>String(todo.id)===String(from)?{...todo,id:to}:todo);feature.remapTodoId(from,to);render();},
 holdCommit:()=>{let release;const promise=new Promise(resolve=>{release=resolve;});commitGate={promise,release};},
 releaseCommit:()=>{commitGate?.release();},
 loseAccess:()=>{todos=[];ref.privacyGeneration++;render();},
 switchActor:()=>{actor={id:2};todos=todos.map(todo=>({...todo,title:'Other account Todo',user_id:2}));render();},
 switchSession:()=>{session++;},
 drop:()=>{todos=[];render();},
};
`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const todo = id => ({ id, title: 'Delete identity', user_id: 1, project_id: 9, status: 'pending', priority: 3 });
try {
  await page.route('http://todo-delete.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>.modal{display:none}.modal.active{display:block}</style></head><body>
      <input id="todo-id" type="hidden"><div id="todo-root"></div>
      <div id="confirm-modal" class="modal"><h2 id="confirm-title"></h2><p id="confirm-message"></p><button id="confirm-confirm-btn">Confirm</button><button id="confirm-cancel-btn">Cancel</button></div>
      <script type="module" src="/fixture.js"></script></body></html>` });
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: source });
    if (path.startsWith('/static/')) {
      try { return route.fulfill({ body: readFileSync(new URL(`../web${path}`, import.meta.url)), contentType: path.endsWith('.json') ? 'application/json' : path.endsWith('.css') ? 'text/css' : 'text/javascript' }); }
      catch { return route.fulfill({ status: 404, body: `Missing fixture asset: ${path}` }); }
    }
    return route.fulfill({ status: 404, body: 'No real network in this fixture' });
  });
  await page.goto('http://todo-delete.test/'); await page.waitForFunction(() => Boolean(window.test));
  const reset = async id => page.evaluate(row => window.test.reset([row]), todo(id));
  const hotkey = async () => {
    await page.locator('.todo-item').hover();
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Delete');
    await page.locator('#confirm-modal').waitFor({ state: 'visible' });
  };
  const confirm = async () => {
    await page.waitForFunction(() => document.activeElement?.id === 'confirm-confirm-btn');
    await page.keyboard.press('Enter');
    await page.locator('#confirm-modal').waitFor({ state: 'hidden' });
  };
  const state = () => page.evaluate(() => window.test.state());
  for (const mode of ['hotkey', 'modal']) {
    await reset('temp-delete-'+mode);
    if (mode === 'hotkey') await hotkey();
    else {
      await page.evaluate(() => { document.getElementById('todo-id').value='temp-delete-modal';window.pendingDelete=window.test.feature.deleteTodoFromModal(); });
      await page.locator('#confirm-modal').waitFor({ state: 'visible' });
    }
    await confirm();
    await page.waitForFunction(() => window.test.state().mutations.length === 1);
    const result = await state();
    assert.equal(result.mutations[0].data.id, 'temp-delete-'+mode);
    assert.deepEqual(result.mutations[0].data.local_todo, todo('temp-delete-'+mode));
    assert.equal(result.mutations[0].data.project_id, 9);
    assert.equal(result.todos.length, 0); assert.equal(result.toasts[0].action.id, 'temp-delete-'+mode);
  }

  await reset('temp-confirm'); await hotkey();
  await page.evaluate(() => { document.getElementById('todo-id').value='temp-confirm';window.test.remap('temp-confirm', 71); });
  assert.equal(await page.locator('#todo-id').inputValue(), '71');
  await confirm(); await page.waitForFunction(() => window.test.state().mutations.length === 1);
  assert.equal((await state()).mutations[0].data.id, 71, 'receipt during confirmation follows the original Todo');
  assert.equal((await state()).toasts[0].action.id, 71, 'Undo receives the confirmed identity');

  await reset('temp-commit'); await page.evaluate(() => window.test.holdCommit());
  await hotkey(); await confirm();
  await page.waitForFunction(() => window.test.state().commitStarted);
  await page.evaluate(() => { window.test.remap('temp-commit',72);window.test.releaseCommit(); });
  await page.waitForFunction(() => window.test.state().mutations.length === 1);
  assert.equal((await state()).mutations[0].data.id, 72, 'receipt while waiting for the commit lock is resolved inside the commit');

  // A receipt also updates the active hover target even without a confirmation.
  await reset('temp-hover'); await page.locator('.todo-item').hover();
  await page.evaluate(() => window.test.remap('temp-hover',73));
  await page.keyboard.press('Delete'); await page.locator('#confirm-modal').waitFor({ state: 'visible' });
  await confirm(); await page.waitForFunction(() => window.test.state().mutations.length === 1);
  assert.equal((await state()).mutations[0].data.id, 73);

  for (const change of ['loseAccess', 'switchActor', 'switchSession', 'drop']) {
    await reset('temp-'+change);
    await page.evaluate(id => { window.pendingDelete=window.test.feature.deleteTodo(id); }, 'temp-'+change);
    await page.locator('#confirm-modal').waitFor({ state: 'visible' });
    await page.evaluate(change => window.test[change](), change); await confirm();
    await page.evaluate(() => window.pendingDelete);
    assert.equal((await state()).mutations.length, 0, `${change} during confirmation must not delete`);
    assert.equal((await state()).deleted.length, 0); assert.equal((await state()).toasts.length, 0);
  }
  await reset('temp-account-commit'); await page.evaluate(() => window.test.holdCommit());
  await hotkey(); await confirm(); await page.waitForFunction(() => window.test.state().commitStarted);
  await page.evaluate(() => { window.test.switchActor();window.test.releaseCommit(); });
  await page.waitForFunction(() => window.test.state().commitSettled === 1);
  assert.equal((await state()).mutations.length,0); assert.equal((await state()).deleted.length,0);
  assert.deepEqual(errors, []);
  console.log('✅ Todo Delete hotkey/modal temporary IDs, held receipts and actor/access fences passed');
} finally { await browser.close(); }

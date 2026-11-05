import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const url = pathToFileURL(path.resolve('web/static/js/features/multi-add.js'));
let shared;
try { shared = await import(url); } catch (error) { assert.fail(`Shared multi-add API missing: ${error.message}`); }
assert.equal(typeof shared.createMultiAddFeature, 'function');
assert.equal(typeof shared.syncMultiAddNativeFields, 'function');
const nativeStates = new Map();
const nativeFields = [{required:true,disabled:false},{required:false,disabled:true}];
shared.syncMultiAddNativeFields(nativeFields,true,nativeStates);
assert.deepEqual(nativeFields,[{required:false,disabled:true},{required:false,disabled:true}]);
shared.syncMultiAddNativeFields(nativeFields,false,nativeStates);
assert.deepEqual(nativeFields,[{required:true,disabled:false},{required:false,disabled:true}]);
assert.equal(nativeStates.size,0);
assert.equal(typeof shared.renderMultiAddPanel, 'function');
assert.equal(typeof shared.renderMultiAddModeSwitch, 'function');
const switchHtml=shared.renderMultiAddModeSwitch({prefix:'sample',singleKey:'sample.single',multipleKey:'sample.multiple'});
assert.match(switchHtml, />Single<\/button>/, 'Mode buttons need an accessible fallback before translation hydration');
assert.match(switchHtml, />Multiple<\/button>/);
assert.deepEqual(shared.splitMultiAddPaste('- First\n2. Second\n• Third', 2), {values:['First','Second'],omittedCount:1});
const html = shared.renderMultiAddPanel({prefix:'sample',quickAddHintKey:'sample.hint',defaultsHtml:'<input id="custom-default">'});
assert.match(html, /id="sample-multi-add-rows"/);
assert.match(html, /capture\.multiAdd\.introTitle/);
assert.match(html, /custom-default/);
assert.doesNotMatch(html, /todo/);
console.log('✅ Shared multi-add API and neutral renderer passed');
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const browser = await chromium.launch({headless:true});
try {
 const page = await browser.newPage();
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('http://capture.test/**', async route => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname.endsWith('.js')) {
   try { return await route.fulfill({contentType:'text/javascript',body:await readFile(path.resolve('web/static/js/features', pathname.slice(1)), 'utf8')}); }
   catch { return route.fulfill({status:404,body:'Unknown module'}); }
  }
  await route.fulfill({contentType:'text/html',body:`<div id="sample-modal" class="active"><h2 id="sample-modal-title"></h2><form id="sample-form"><input id="single" required>${shared.renderMultiAddModeSwitch({prefix:'sample',singleKey:'one',multipleKey:'many'})}${html}<button id="sample-save-btn">Save</button></form></div><script type="module">
   import {createMultiAddFeature} from '/multi-add.js';
   window.parseCalls=0;window.saved=[];window.closeCount=0;window.toasts=[];window.captureErrors=[];window.context='one';window.defaults={group:1};window.parseImpl=async raw=>({title:raw,matches:[]});window.saveImpl=async rows=>{window.saved.push(rows);return rows;};
   window.feature=createMultiAddFeature({prefix:'sample',t:k=>k,copy:{count:'count',create:'create',singleTitle:'create',title:'multi'},getSingleFields:()=>document.querySelectorAll('#single'),readDefaults:()=>({...window.defaults}),getContext:()=>window.context,parse:(...args)=>{window.parseCalls++;return window.parseImpl(...args);},onSave:(...args)=>window.saveImpl(...args),onError:error=>window.captureErrors.push(error.message),showToast:text=>window.toasts.push(text),onSaved:()=>window.closeCount++});
   window.submitCount=0;document.getElementById('sample-form').addEventListener('submit',event=>{event.preventDefault();window.submitCount++;});
   window.feature.bind();window.feature.reset();window.feature.setMode('multi');window.ready=true;
  </script>`});
 });
 await page.goto('http://capture.test/');
 await page.waitForTimeout(200);
 assert.equal(await page.evaluate(()=>typeof window.feature?.bind),'function', 'Shared controller must expose bind');
 await page.waitForFunction(()=>window.ready,null,{timeout:2000});
 assert.equal(await page.locator('.ui-multi-add-input').count(),1);
 assert.equal(await page.locator('#single').evaluate(e=>e.required),false);
 await page.locator('.ui-multi-add-input').fill('First');
 await page.evaluate(()=>window.feature.save());
 assert.equal(await page.evaluate(()=>window.saved[0][0].title),'First');
 assert.equal(await page.evaluate(()=>window.closeCount),1);
 await page.evaluate(()=>{window.saveImpl=async()=>null;});
 await page.evaluate(()=>window.feature.save());
 assert.equal(await page.evaluate(()=>window.closeCount),1,'A rejected domain batch (null) must not close capture');
 await page.evaluate(()=>{window.saveImpl=async rows=>{window.saved.push(rows);return rows;};});
 // IME confirmation must never become a capture shortcut.
 await page.locator('.ui-multi-add-input').evaluate(input=>{
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true,cancelable:true}));
 });
 assert.equal(await page.locator('.ui-multi-add-input').count(),1,'IME Enter must not create a row');
 await page.locator('.ui-multi-add-input').evaluate(input=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true,bubbles:true,cancelable:true})));
 assert.equal(await page.locator('.ui-multi-add-input').count(),1);
 assert.equal(await page.evaluate(()=>window.submitCount),0,'Composing Ctrl+Enter must not submit');
 await page.locator('.ui-multi-add-input').press('Control+Enter');
 assert.equal(await page.evaluate(()=>window.submitCount),1,'Ctrl+Enter submits through the existing domain form');
 // Enter, Backspace, stable ARIA, mode preservation and native restoration.
 const first=page.locator('.ui-multi-add-input').first();
 const firstId=await first.getAttribute('id');
 const parseCallsBeforeBlur=await page.evaluate(()=>window.parseCalls);
 await first.press('Enter');
 await page.waitForTimeout(120);
 assert.equal(await page.evaluate(()=>window.parseCalls),parseCallsBeforeBlur,'Row blur/change must not trigger defaults reparsing');
 assert.equal(await page.locator('.ui-multi-add-input').count(),2);
 await page.locator('.ui-multi-add-input').nth(1).press('Backspace');
 assert.equal(await page.locator('.ui-multi-add-input').count(),1);
 assert.equal(await first.getAttribute('id'),firstId);
 assert.match(await first.getAttribute('aria-describedby'),/sample-multi-add-preview-/);
 await page.evaluate(()=>window.feature.setMode('single'));
 assert.equal(await page.locator('#single').evaluate(e=>[e.required,e.disabled].join()),'true,false');
 assert.equal(await page.evaluate(()=>document.activeElement.id),'single','Single mode must focus the restored native field');
 assert.equal(await page.locator('#sample-save-btn').isHidden(),false);
 await page.evaluate(()=>window.feature.setMode('multi'));
 assert.equal(await first.inputValue(),'First');
 // Paste strips bullet markers, reports omissions, and counts blank allocated rows.
 await first.evaluate(input=>input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:new DataTransfer()})));
 await first.evaluate(input=>{const data=new DataTransfer();data.setData('text/plain','- Same\n2. Same');input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});
 assert.equal(await page.locator('.ui-multi-add-input').count(),2);
 await page.evaluate(()=>window.feature.save());
 assert.equal(await page.evaluate(()=>window.saved.at(-1).length),2,'Duplicate warnings must not collapse distinct creates');
 assert.equal(await page.locator('.is-duplicate').count(),2);
 assert.equal(await page.locator('.ui-multi-add-row-message').first().textContent(),'capture.multiAdd.duplicate');
 await page.evaluate(()=>{window.feature.reset();window.feature.setMode('multi');});
 await page.locator('#sample-multi-add-more').click();
 await first.evaluate(input=>{const data=new DataTransfer();data.setData('text/plain',Array.from({length:55},(_,i)=>'Line '+i).join('\n'));input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});
 assert.equal(await page.locator('.ui-multi-add-input').count(),50);
 assert.equal(await page.locator('#sample-multi-add-more').isDisabled(),true);
 assert.deepEqual(await page.evaluate(()=>window.toasts),['capture.multiAdd.pasteOmitted.many']);
 await page.evaluate(()=>window.feature.save());
 assert.equal(await page.evaluate(()=>window.saved.at(-1).length),49,'Allocated blank rows count toward limit but never save');
 await page.evaluate(()=>{window.feature.reset();window.feature.setMode('multi');});
 await first.fill('x'.repeat(501));
 await page.waitForFunction(()=>document.querySelector('.ui-multi-add-input').getAttribute('aria-invalid')==='true');
 assert.equal(await page.locator('#sample-save-btn').isDisabled(),true);
 assert.equal(await first.getAttribute('maxlength'),'620');
 await first.fill('');
 await page.waitForFunction(()=>document.getElementById('sample-save-btn').hidden);
 // Save singleflight plus reset lifecycle must not close a newer dialog.
 await first.fill('Pending');
 await page.evaluate(()=>{
  window.saveImpl=async(rows,{isCurrent})=>{await new Promise(resolve=>window.releaseSave=resolve);if(!isCurrent())return false;window.saved.push(rows);return rows;};
  window.s1=window.feature.save();window.s2=window.feature.save();
 });
 await page.waitForFunction(()=>typeof window.releaseSave==='function');
 assert.equal(await page.evaluate(()=>window.s1===window.s2),true);
 assert.equal(await page.locator('#sample-multi-add-panel').getAttribute('inert'),'');
 const closedBefore=await page.evaluate(()=>window.closeCount);
 await page.evaluate(()=>{document.getElementById('sample-modal-title').textContent='Existing edit';window.feature.reset({editing:true});window.releaseSave();});
 await page.evaluate(()=>window.s1);
 assert.equal(await page.evaluate(()=>window.closeCount),closedBefore);
 assert.equal(await page.locator('#sample-create-mode-switch').isHidden(),true);
 assert.equal(await page.locator('#sample-modal-title').textContent(),'Existing edit','Reset/edit must preserve the domain-owned edit header');
 assert.equal(await page.locator('.ui-multi-add-input').count(),0);
 await page.evaluate(()=>{window.feature.setMode('multi');});
 assert.equal(await page.evaluate(()=>window.feature.isActive()),false,'Edit mode cannot enter multi capture');
 // Deferred parse may not render after reset, context change or closure.
 await page.evaluate(()=>{window.feature.reset();window.feature.setMode('multi');window.parseImpl=raw=>new Promise(resolve=>window.resolveParse=()=>resolve({title:raw,matches:[{type:'due',label:'Due',value:'stale'}]}));});
 await first.fill('Stale');
 await page.waitForFunction(()=>typeof window.resolveParse==='function');
 await page.evaluate(()=>{window.context='two';window.resolveParse();});
 await page.waitForTimeout(20);
 assert.equal(await page.locator('.quick-add-chip').count(),0);
 await page.evaluate(()=>{window.context={listId:'one'};});
 await first.fill('Mutable context');
 await page.waitForTimeout(110);
 await page.evaluate(()=>{window.context.listId='two';window.resolveParse();});
 await page.waitForTimeout(20);
 assert.equal(await page.locator('.quick-add-chip').count(),0,'Context identity must be captured before async parse, even for mutable adapter objects');
 await page.evaluate(()=>{window.feature.reset();window.feature.setMode('multi');});
 await first.fill('Closed');
 await page.waitForTimeout(110);
 await page.evaluate(()=>{document.getElementById('sample-modal').classList.remove('active');window.resolveParse();});
 await page.waitForTimeout(20);
 assert.equal(await page.evaluate(()=>window.feature.isActive()),false);
 assert.equal(await page.locator('.quick-add-chip').count(),0);
 // Async preview failures are handled only for the current adapter context.
 await page.evaluate(()=>{document.getElementById('sample-modal').classList.add('active');window.parseImpl=()=>new Promise((resolve,reject)=>window.rejectParse=reject);});
 await first.fill('Stale failure');
 await page.waitForTimeout(110);
 await page.evaluate(()=>{window.context.listId='three';window.rejectParse(new Error('stale failure'));});
 await page.waitForTimeout(20);
 assert.deepEqual(await page.evaluate(()=>window.captureErrors),[],'Stale context errors must not surface in the current capture');
 await page.evaluate(()=>{window.parseImpl=async()=>{throw new Error('parse failed');};});
 await first.fill('Failure');
 await page.waitForTimeout(120);
 assert.deepEqual(await page.evaluate(()=>window.captureErrors),['parse failed']);
 assert.deepEqual(errors,[]);

} finally {await browser.close();}
console.log('✅ Shared capture controller first consumer passed');

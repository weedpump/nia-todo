#!/usr/bin/env node
// Private browser origin only: no application service, database or LLM.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const webRoot = path.resolve(fileURLToPath(new URL('../web/', import.meta.url)));
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP5sAAAAASUVORK5CYII=';
const draft = { title: 'Apple cake', description: 'Original draft', base_servings: 4, prep_minutes: 10, cook_minutes: 30, tags: ['Family'],
  source_url: 'https://recipes.example/cake', source_name: 'Kitchen', source_author: 'Original author', source_yield: '4 servings',
  ingredient_groups: [{ client_key: 'g1', id: 30, name: 'Dough', ingredients: [{ client_key: 'i1', id: 40, name: 'Flour', quantity_value: 250, quantity_unit: 'g', quantity_text: null, note: '' }] }],
  steps: [{ client_key: 's1', id: 50, text: 'Mix the flour.', ingredients: [] }], image_data: image };
const fixture = `
import { initI18n,t } from '/static/js/i18n/index.js';
import { renderRecipeEditorModal,createRecipeEditorFeature } from '/static/js/features/recipe-editor.js';
import { renderRecipeImportModal,createRecipeImportFeature } from '/static/js/features/recipe-import.js';
import { bindUiHistory,requestCloseUiLayer } from '/static/js/features/ui-history.js';
localStorage.setItem('nia-todo-language','en');await initI18n();
document.body.innerHTML='<button data-recipe-action="import">Import</button>'+renderRecipeImportModal()+renderRecipeEditorModal();
bindUiHistory();document.addEventListener('click',event=>{const button=event.target.closest('[data-close-modal]');if(button)requestCloseUiLayer(button.dataset.closeModal);});
const draft=${JSON.stringify(draft)};
let recipe={...structuredClone(draft),id:20,cookbook_id:1,revision:7,can_edit:true};
let books=[{id:1,name:'Family',can_edit:true,recipes:[recipe]}];let access=false,session='1:first',online=true;
const calls=[],saves=[],errors=[];
const api={aiPreview:(body,{signal}={})=>new Promise((resolve,reject)=>calls.push({body,signal,resolve,reject})),importPreview:()=>{throw new Error('Unexpected URL call');}};
const editor=createRecipeEditorFeature({root:document,api,getBrainDumpAccess:()=>access,isOnline:()=>online,getCookbooks:()=>books,getSessionIdentity:()=>session,
  recipeController:{getRecipe:id=>String(id)==='20'?recipe:null,create:async(bookId,data,options)=>{saves.push({action:'create',bookId,data,options:{}});return{...data,id:21,cookbook_id:bookId};},update:async(id,data,options)=>{saves.push({action:'update',id,data,options:{expectedRevision:options.expectedRevision}});return{...recipe,...data};}},
  loadRecipeImage:async(img,record,options)=>{if(!options.isCurrent()||!record.image_data)return false;img.src=record.image_data;return true;},releaseRecipeImage:img=>img?.removeAttribute('src'),onError:error=>errors.push(error.message)});
const importer=createRecipeImportFeature({root:document,api,editor,getBrainDumpAccess:()=>access,isOnline:()=>online,getCookbooks:()=>books,getActiveCookbookId:()=>1,getSessionIdentity:()=>session,onError:error=>errors.push(error.message)});
editor.bind();importer.bind();
window.test={editor,importer,calls,saves,errors,t,draft,
  access:value=>{access=value;editor.reconcile();importer.reconcile();},session:value=>{session=value;editor.reconcile();importer.reconcile();},
  online:value=>{online=value;window.dispatchEvent(new Event(value?'online':'offline'));},
  permission:value=>{books[0].can_edit=value;editor.reconcile();importer.reconcile();},
  reset:()=>{editor.deactivate();importer.deactivate();session='1:first';online=true;books[0].can_edit=true;access=true;},
  resolve:(index,value)=>calls[index].resolve(value),reject:(index,code)=>calls[index].reject(Object.assign(new Error(code),{code})),
  showImport:()=>editor.showImport(draft,1),showEdit:()=>editor.showEdit(20)};
`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const screenshots=process.env.NIA_RECIPE_BRAINDUMP_SCREENSHOTS_DIR;
  async function capture(name){if(screenshots){await mkdir(screenshots,{recursive:true});await page.screenshot({path:path.join(screenshots,`nia-recipe-braindump-${name}.png`),animations:'disabled'});}}
  const pageErrors=[]; page.on('pageerror', error=>pageErrors.push(error.message));
  await page.route('http://recipe-ai.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/style.css"></head><body><script type="module" src="/fixture.js"></script></body></html>'});
    if (pathname === '/fixture.js') return route.fulfill({contentType:'text/javascript',body:fixture});
    const file=path.resolve(webRoot,`.${pathname}`);if(!file.startsWith(webRoot+path.sep))return route.abort();
    try{return route.fulfill({contentType:pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.json')?'application/json':'text/css',body:await readFile(file)});}catch{return route.fulfill({status:404});}
  });
  await page.goto('http://recipe-ai.test/');await page.waitForFunction(()=>Boolean(window.test));
  await page.evaluate(()=>window.test.showImport());
  assert.equal(await page.locator('#recipe-ai-refine-btn').isVisible(),false,'ungranted users never see BrainDump refinement');
  await page.evaluate(()=>window.test.editor.refineWithBrainDump());assert.equal(await page.evaluate(()=>window.test.calls.length),0);
  await page.evaluate(()=>{window.test.editor.deactivate();window.test.importer.show();});
  assert.equal(await page.locator('#recipe-import-mode').isVisible(),false);
  assert.equal(await page.evaluate(()=>window.test.importer.setMode('text')),false,'ungranted users cannot enter text mode');
  await page.evaluate(()=>{window.test.reset();window.test.showImport();});
  assert.equal(await page.locator('#recipe-ai-refine-btn').isVisible(),true);

  async function begin({edit=false}={}) {
    await page.evaluate(edit=>{window.test.reset();edit?window.test.showEdit():window.test.showImport();},edit);
    await page.fill('#recipe-description','Manually adjusted before BrainDump');
    await page.locator('#recipe-ai-refine-btn').click();
    return page.evaluate(()=>window.test.calls.length-1);
  }
  const answer = structuredClone(draft);answer.description='Polished description';answer.steps[0].ingredients=[{ingredient_client_key:'i1',show_quantity:true,quantity_value:125,quantity_text:null}];
  answer.source_author='Injected author';answer.source_url='https://other.example/';answer.id=999;answer.cookbook_id=999;answer.revision=999;
  answer.ingredient_groups[0].id=999;answer.ingredient_groups[0].ingredients[0].id=999;answer.steps[0].id=999;
  let index=await begin();
  const request=await page.evaluate(index=>window.test.calls[index].body,index);
  assert.equal(request.draft.description,'Manually adjusted before BrainDump');assert.equal('image_data' in request.draft,false,'image is not transmitted to the model');
  assert.equal(await page.locator('#recipe-save-btn').isDisabled(),true);
  assert.equal(await page.locator('#recipe-name').isDisabled(),true,'editor fields are locked while the current draft is being read');
  assert.equal(await page.evaluate(()=>window.test.saves.length),0);
  await page.evaluate(({index,answer})=>window.test.resolve(index,{draft:answer,warnings:['recipe.ai.reviewAssignments']}),{index,answer});
  await page.waitForFunction(()=>!document.getElementById('recipe-name').disabled);
  const refined=await page.evaluate(()=>window.test.editor.getDraft());
  assert.equal(refined.description,answer.description);assert.equal(refined.source_author,draft.source_author);assert.equal(refined.source_url,draft.source_url);assert.equal(refined.image_data,image);
  assert.deepEqual(refined.steps[0].ingredients,answer.steps[0].ingredients);assert.equal(await page.locator('#recipe-id').inputValue(),'');
  assert.equal(await page.locator('#recipe-cookbook-id').inputValue(),'1');assert.equal(await page.evaluate(()=>window.test.saves.length),0,'refinement never saves automatically');
  assert.equal(await page.locator('#recipe-import-review').isVisible(),true);
  await capture('editor-desktop');

  index=await begin({edit:true});
  assert.equal(await page.locator('#recipe-delete-btn').isDisabled(),true);
  const existingRequest=await page.evaluate(index=>window.test.calls[index].body.draft,index);
  assert.equal('id' in existingRequest.ingredient_groups[0],false);
  assert.equal('id' in existingRequest.ingredient_groups[0].ingredients[0],false);
  assert.equal('id' in existingRequest.steps[0],false,'persisted database IDs are not sent to the model API');
  await page.evaluate(({index,answer})=>window.test.resolve(index,{draft:answer,warnings:[]}),{index,answer});
  await page.waitForFunction(()=>!document.getElementById('recipe-name').disabled);
  assert.equal(await page.locator('#recipe-id').inputValue(),'20','persisted recipe identity must survive refinement');
  const edited=await page.evaluate(()=>window.test.editor.getDraft());
  assert.equal(edited.ingredient_groups[0].id,30);assert.equal(edited.ingredient_groups[0].ingredients[0].id,40);assert.equal(edited.steps[0].id,50);
  assert.equal(Object.hasOwn(edited,'image_data'),false,'existing private image is retained without synthesizing an upload');
  await page.locator('#recipe-save-btn').click();await page.waitForFunction(()=>window.test.saves.length===1);
  const saved=await page.evaluate(()=>window.test.saves[0]);assert.equal(saved.action,'update');assert.equal(saved.id,20);assert.equal(saved.options.expectedRevision,7);

  index=await begin();
  await page.evaluate(()=>{const field=document.getElementById('recipe-description');field.value='Newer manual edit';field.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.evaluate(({index,answer})=>window.test.resolve(index,{draft:answer}),{index,answer});
  await page.waitForFunction(()=>!document.getElementById('recipe-name').disabled);
  assert.equal(await page.locator('#recipe-description').inputValue(),'Newer manual edit','newer edits cannot be overwritten by a held response');

  index=await begin();await page.locator('#recipe-modal .modal-close-x').click();await page.locator('#recipe-modal').waitFor({state:'hidden'});
  await page.waitForFunction(index=>window.test.calls[index].signal.aborted,index);
  await page.evaluate(({index,answer})=>window.test.resolve(index,{draft:answer}),{index,answer});
  assert.equal(await page.locator('#recipe-modal').isVisible(),false);
  index=await begin();const old=index;const recent=await begin();
  await page.evaluate(({index,answer})=>window.test.resolve(index,{draft:answer}),{index:old,answer});
  assert.equal(await page.locator('#recipe-description').inputValue(),'Manually adjusted before BrainDump');
  await page.evaluate(({index,answer})=>window.test.resolve(index,{draft:answer}),{index:recent,answer});await page.waitForFunction(()=>!document.getElementById('recipe-name').disabled);

  for(const change of ['access','permission','session']){
    index=await begin();await page.evaluate(change=>window.test[change](change==='session'?'2:other':false),change);
    await page.evaluate(({index,answer})=>window.test.resolve(index,{draft:answer}),{index,answer});
    assert.notEqual(await page.locator('#recipe-description').inputValue(),answer.description,`${change} fence discards old output`);
  }
  index=await begin();await page.evaluate(index=>window.test.reject(index,'recipe.ai.unavailable'),index);
  await page.waitForFunction(()=>!document.getElementById('recipe-name').disabled);
  assert.equal(await page.locator('#recipe-description').inputValue(),'Manually adjusted before BrainDump','failed requests retain a manually editable draft');
  assert.equal(await page.locator('#recipe-ai-refine-btn').isEnabled(),true);

  await page.evaluate(()=>{window.test.reset();window.test.importer.show();});
  await page.locator('[data-recipe-import-mode="text"]').click();
  assert.equal(await page.locator('[data-recipe-import-mode="text"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('[data-recipe-import-mode="link"]').getAttribute('aria-pressed'),'false');
  await page.waitForFunction(()=>{
    const text=getComputedStyle(document.querySelector('[data-recipe-import-mode="text"]'));
    const link=getComputedStyle(document.querySelector('[data-recipe-import-mode="link"]'));
    return text.backgroundColor!=='rgba(0, 0, 0, 0)'&&link.backgroundColor==='rgba(0, 0, 0, 0)';
  });
  assert.equal(await page.locator('#recipe-import-text').isEnabled(),true);assert.equal(await page.locator('#recipe-import-url').isDisabled(),true);
  const raw='Crêpes pour quatre personnes\n250 g de farine\nMélanger la farine.';
  await page.fill('#recipe-import-text',raw);
  if(screenshots){await page.setViewportSize({width:390,height:844});await capture('text-mobile');await page.setViewportSize({width:1280,height:900});}
  await page.locator('#recipe-import-save-btn').click();index=await page.evaluate(()=>window.test.calls.length-1);
  assert.deepEqual(await page.evaluate(index=>window.test.calls[index].body,index),{text:raw});
  for(const width of [1280,390,320]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`no text-mode overflow at ${width}`);}
  await page.evaluate(({index,answer})=>window.test.resolve(index,{draft:{...answer,title:'Crêpes françaises'},warnings:['recipe.ai.review']}),{index,answer});
  await page.locator('#recipe-modal.active').waitFor();assert.equal(await page.locator('#recipe-name').inputValue(),'Crêpes françaises');
  assert.equal(await page.locator('#recipe-id').inputValue(),'');assert.equal(await page.evaluate(()=>window.test.saves.length),1,'text conversion opens only an unsaved editor');
  await page.evaluate(()=>{window.test.reset();window.test.importer.show();window.test.importer.setMode('text');});
  await page.fill('#recipe-import-text',raw);await page.locator('#recipe-import-save-btn').click();index=await page.evaluate(()=>window.test.calls.length-1);
  await page.evaluate(()=>window.test.access(false));await page.waitForFunction(index=>window.test.calls[index].signal.aborted,index);
  await page.evaluate(({index,answer})=>window.test.resolve(index,{draft:answer}),{index,answer});
  assert.equal(await page.locator('#recipe-modal').isVisible(),false);assert.equal(await page.locator('#recipe-import-url').isVisible(),true,'revocation keeps ordinary URL import available');
  assert.equal(await page.locator('#recipe-import-text').inputValue(),raw,'revocation preserves text instead of silently discarding it');
  assert.deepEqual(pageErrors,[]);
  console.log('PASS recipe BrainDump current-draft refinement, free text, unsaved identity/image, permission/session/edit fences, abort and responsive UI');
} finally { await browser.close(); }

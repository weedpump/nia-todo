#!/usr/bin/env node
// Real shared modal/editor at a private origin; no Nia service or database.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const webRoot = path.resolve(fileURLToPath(new URL('../web/', import.meta.url)));
const fixture = `
import { initI18n } from '/static/js/i18n/index.js';
import { renderRecipeEditorModal, createRecipeEditorFeature } from '/static/js/features/recipe-editor.js';
import { renderRecipeImportModal, createRecipeImportFeature } from '/static/js/features/recipe-import.js';
import { createRecipeController } from '/static/js/features/recipe-mutations.js';
import { renderRecipeSource } from '/static/js/features/recipe-view.js';
import { bindUiHistory, requestCloseUiLayer } from '/static/js/features/ui-history.js';
localStorage.setItem('nia-todo-language','en'); await initI18n();
document.body.innerHTML='<button data-recipe-action="import">Import</button>'+renderRecipeImportModal()+renderRecipeEditorModal();
bindUiHistory();
document.addEventListener('click',event=>{const button=event.target.closest('[data-close-modal]');if(button)requestCloseUiLayer(button.dataset.closeModal);});
let books=[{id:1,can_edit:true,name:'Own',created_by_user_id:11,recipes:[]},{id:2,can_edit:false,name:'Read only',recipes:[]}];
let session='11:first',online=true,brainDumpAccess=false,sequence=0;
const calls=[],queue=[],errors=[],saved=[];
const controller=createRecipeController({getCookbooks:()=>books,setCookbooks:value=>{books=value;},getSessionIdentity:()=>session,getCurrentUser:()=>({id:11}),
  createTempId:()=> 'temp-recipe-import-'+(++sequence),commitMutation:async build=>{const mutation=build();if(mutation)queue.push(structuredClone(mutation));return mutation;}});
const editor=createRecipeEditorFeature({root:document,getCookbooks:()=>books,recipeController:controller,getSessionIdentity:()=>session,
  loadRecipeImage:async(img,recipe,options)=>{if(!options.isCurrent()||!recipe.image_data)return false;img.src=recipe.image_data;return true;},releaseRecipeImage:img=>img?.removeAttribute('src'),onSaved:recipe=>saved.push(recipe),onError:error=>errors.push(error.message)});
const feature=createRecipeImportFeature({root:document,getCookbooks:()=>books,getActiveCookbookId:()=>1,getSessionIdentity:()=>session,editor,isOnline:()=>online,
  getBrainDumpAccess:()=>brainDumpAccess,
  api:{importPreview:(data,{signal}={})=>new Promise((resolve,reject)=>calls.push({data,signal,resolve,reject})),
    aiPreview:(data,{signal}={})=>new Promise((resolve,reject)=>calls.push({data,signal,resolve,reject}))},onError:error=>errors.push(error.message)});
editor.bind();feature.bind();
window.test={feature,editor,calls,queue,errors,saved,renderRecipeSource,books:()=>books,setBooks:value=>{books=value;feature.reconcile();editor.reconcile();},
  setSession:value=>{session=value;feature.reconcile();editor.reconcile();},setOnline:value=>{online=value;window.dispatchEvent(new Event(value?'online':'offline'));},
  setBrainDumpAccess:value=>{brainDumpAccess=value;feature.reconcile();},
  resolve:(index,response)=>calls[index].resolve(response),reject:(index,code)=>calls[index].reject(Object.assign(new Error(code),{code})),
  deactivate:()=>{feature.deactivate();editor.deactivate();},show:()=>feature.show(1)};
`;
const draft = {
  id: 999, cookbook_id: 2, revision: 99, can_edit: false,
  title: 'Apple <img src=x onerror="window.importXss=true"> cake', description: 'Imported recipe', base_servings: 4,
  prep_minutes: 10, cook_minutes: 30, tags: ['Family'],
  source_url: 'https://recipes.example/recipe', source_name: 'Recipe site', source_author: 'Author <script>', source_yield: '4 servings',
  ingredient_groups: [{ client_key: 'group-1', name: 'Dough', ingredients: [{ client_key: 'ingredient-1', name: 'Flour', quantity_value: 250, quantity_unit: 'g', quantity_text: null, note: '' }] }],
  steps: [{ client_key: 'step-1', text: 'Mix flour.', ingredients: [] }],
  image_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP5sAAAAASUVORK5CYII=',
};

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const screenshots = process.env.NIA_RECIPE_IMPORT_SCREENSHOTS_DIR;
  const captured = new Set();
  async function capture(name) {
    if (!screenshots || captured.has(name)) return;
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, `nia-recipe-import-${name}.png`), animations: 'disabled' });
    captured.add(name);
  }
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('http://recipe-import.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/style.css"></head><body><script type="module" src="/fixture.js"></script></body></html>' });
    if (pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: fixture });
    const file = path.resolve(webRoot, `.${pathname}`);
    if (!file.startsWith(webRoot + path.sep)) return route.abort();
    try { return route.fulfill({ contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.json') ? 'application/json' : 'text/css', body: await readFile(file) }); }
    catch { return route.fulfill({ status: 404, body: 'Missing fixture' }); }
  });
  await page.goto('http://recipe-import.test/');
  await page.waitForFunction(() => Boolean(window.test));
  assert.equal(await page.evaluate(() => window.test.feature.show(2)), false, 'read-only books cannot receive an import');
  await page.evaluate(() => { window.test.setOnline(false); window.test.show(); });
  assert.equal(await page.locator('#recipe-import-status').textContent(), 'An internet connection is required to import a link.');
  await page.evaluate(() => window.test.feature.submit());
  assert.equal(await page.evaluate(() => window.test.calls.length), 0);
  await page.evaluate(() => window.test.setOnline(true));
  await page.fill('#recipe-import-url', 'file:///etc/passwd');
  await page.evaluate(() => window.test.feature.submit());
  assert.equal(await page.evaluate(() => window.test.calls.length), 0, 'non-http inputs never reach the API');

  async function begin() {
    await page.evaluate(() => { window.test.deactivate(); window.test.show(); });
    await page.fill('#recipe-import-url', 'https://recipes.example/recipe');
    await capture(page.viewportSize().width > 768 ? 'dialog-desktop' : 'dialog-mobile');
    await page.locator('#recipe-import-save-btn').click();
    return page.evaluate(() => window.test.calls.length - 1);
  }
  let index = await begin();
  assert.equal(await page.evaluate(() => window.test.queue.length), 0, 'analysis never stores a recipe');
  assert.equal(await page.locator('#recipe-import-url').isDisabled(), true);
  assert.equal(await page.locator('#recipe-import-form').getAttribute('aria-busy'), 'true');
  await page.evaluate(({ index, draft }) => window.test.resolve(index, { draft, warnings: ['recipe.import.reviewIngredients'] }), { index, draft });
  await page.locator('#recipe-modal.active').waitFor();
  assert.equal(await page.locator('#recipe-id').inputValue(), '', 'preview opens as a new recipe, not a remote persisted identity');
  assert.equal(await page.locator('#recipe-cookbook-id').inputValue(), '1', 'source metadata cannot retarget the selected cookbook');
  assert.equal(await page.locator('#recipe-name').inputValue(), draft.title);
  assert.equal(await page.locator('#recipe-source-author').inputValue(), draft.source_author);
  assert.equal(await page.locator('#recipe-source-author').getAttribute('type'), 'hidden', 'author metadata is retained without an editor field');
  assert.equal(await page.getByLabel('Author', { exact: true }).count(), 0);
  const sourceHtml = await page.evaluate(draft => window.test.renderRecipeSource(draft), draft);
  assert.ok(!sourceHtml.includes('Author') && sourceHtml.includes('Amount in source recipe'), 'source display omits author and explains the original quantity');
  assert.equal(await page.evaluate(() => window.test.renderRecipeSource({source_author:'Hidden author only'})), '', 'author alone does not render an empty source block');
  assert.equal(await page.locator('#recipe-source-url').inputValue(), draft.source_url);
  assert.equal(await page.locator('#recipe-source-yield').inputValue(), draft.source_yield);
  assert.equal(await page.locator('#recipe-save-btn').isVisible(), true, 'an unchanged imported draft is immediately saveable');
  assert.equal(await page.locator('#recipe-import-review').isVisible(), true);
  assert.equal(await page.locator('.recipe-editor-source').getAttribute('open'), null, 'source metadata starts compact');
  assert.equal(await page.evaluate(() => Boolean(window.importXss)), false);
  await page.waitForFunction(() => Boolean(document.querySelector('#recipe-image-preview-img')?.getAttribute('src')));
  await capture('editor-desktop');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no body overflow at ${width}px`);
    await page.locator('.recipe-editor-source>summary').click();
    assert(await page.evaluate(() => document.querySelector('.recipe-editor-source').scrollWidth <= document.querySelector('.recipe-editor-source').clientWidth + 1), `source fields fit at ${width}px`);
    await page.locator('.recipe-editor-source>summary').click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#recipe-save-btn').click();
  await page.waitForFunction(() => window.test.saved.length === 1);
  const created = await page.evaluate(() => window.test.queue[0]);
  assert.equal(created.action, 'CREATE_RECIPE');
  assert.equal(created.data.cookbook_id, 1);
  assert.equal(created.data.source_url, draft.source_url);
  assert.equal(created.data.source_author, draft.source_author);
  assert.equal(created.data.source_yield, draft.source_yield);
  assert.equal(created.data.image_data, draft.image_data, 'image follows the existing durable create intent');
  assert.equal(Object.hasOwn(created.data, 'warnings'), false);

  index = await begin();
  await page.locator('#recipe-import-modal .modal-close-x').click();
  await page.locator('#recipe-import-modal').waitFor({ state: 'hidden' });
  await page.waitForFunction(index => window.test.calls[index].signal.aborted, index);
  await page.evaluate(({ index, draft }) => window.test.resolve(index, { draft }), { index, draft });
  assert.equal(await page.locator('#recipe-modal').isVisible(), false, 'a closed import cannot reopen the editor');

  index = await begin();
  const oldIndex = index;
  const newerIndex = await begin();
  await page.evaluate(({ index, draft }) => window.test.resolve(index, { draft }), { index: oldIndex, draft });
  assert.equal(await page.locator('#recipe-import-modal').isVisible(), true);
  assert.equal(await page.locator('#recipe-modal').isVisible(), false, 'an earlier request cannot replace a newer import');
  await page.evaluate(({ index, draft }) => window.test.resolve(index, { draft: { ...draft, title: 'Newer import' } }), { index: newerIndex, draft });
  await page.locator('#recipe-modal.active').waitFor();
  assert.equal(await page.locator('#recipe-name').inputValue(), 'Newer import');

  index = await begin();
  await page.evaluate(() => window.test.setSession('22:other'));
  await page.evaluate(({ index, draft }) => window.test.resolve(index, { draft }), { index, draft });
  assert.equal(await page.locator('#recipe-modal').isVisible(), false, 'account switches discard held responses');
  await page.evaluate(() => window.test.setSession('11:first'));
  index = await begin();
  await page.evaluate(() => window.test.setBooks(window.test.books().map(book => ({ ...book, can_edit: false }))));
  await page.evaluate(({ index, draft }) => window.test.resolve(index, { draft }), { index, draft });
  assert.equal(await page.locator('#recipe-modal').isVisible(), false, 'permission revocation discards held responses');
  await page.evaluate(() => window.test.setBooks(window.test.books().map(book => ({ ...book, can_edit: book.id === 1 }))));
  index = await begin();
  await page.evaluate(index => window.test.reject(index, 'recipe.import.notFound'), index);
  await page.waitForFunction(() => document.querySelector('#recipe-import-form').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('#recipe-import-modal').isVisible(), true, 'failed analysis preserves its input for retry');
  assert.equal(await page.locator('#recipe-import-url').inputValue(), 'https://recipes.example/recipe');
  assert.equal(await page.locator('#recipe-import-url').isDisabled(), false);
  await page.evaluate(() => window.test.setBrainDumpAccess(true));
  for (const width of [1280,390,320]) {
    await page.setViewportSize({width,height:844});
    for (const mode of ['link','text']) {
      await page.locator(`[data-recipe-import-mode="${mode}"]`).click();
      assert.equal(await page.locator(`[data-recipe-import-mode="${mode}"]`).getAttribute('aria-pressed'),'true');
      const layout=await page.evaluate(mode=>{
        const switcher=document.querySelector('#recipe-import-mode').getBoundingClientRect();
        const label=document.querySelector(mode==='text'?'#recipe-import-text-group>label':'#recipe-import-url-group>label').getBoundingClientRect();
        return {gap:label.top-switcher.bottom,overflow:document.documentElement.scrollWidth>innerWidth+1};
      },mode);
      assert.ok(layout.gap>=12,`${mode} field label stays separated from its mode switch at ${width}px: ${JSON.stringify(layout)}`);
      assert.equal(layout.overflow,false,`${mode} import fits at ${width}px`);
      await capture(`dialog-${mode}-${width}`);
    }
  }
  assert.deepEqual(pageErrors, []);
  console.log('✅ Recipe link import shared modal/editor, source/image durable create, desktop/mobile, cancellation and session/access fences passed');
} finally { await browser.close(); }

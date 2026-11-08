#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { waitForPageCondition } from './browser_page_condition.mjs';
import { ICONS } from '../web/static/js/icons/lucide-generated.js';

async function assertControlIcon(control, name) {
  assert.ok(ICONS[name] && ICONS[name] !== ICONS.circle, `${name} must be registered centrally`);
  const paths = Array.from(ICONS[name].matchAll(/<path d="([^"]+)"/g), match => match[1]);
  assert.ok(paths.length, `${name} must have a directional SVG path`);
  assert.deepEqual(await control.locator('svg').evaluate(svg => ({
    paths: Array.from(svg.querySelectorAll('path'), path => path.getAttribute('d')),
    circles: svg.querySelectorAll('circle').length,
  })), { paths, circles: 0 }, `${name} must render its actual central paths instead of a circle fallback`);
}

// Actual shared controllers, module shell and IndexedDB at a private mocked origin.
// No Nia service, SQLite database or real network API is used.
const fixture = `
import { initI18n } from '/static/js/i18n/index.js';
import { createModuleShell } from '/static/js/features/module-shell.js';
import { createModuleSwitcher } from '/static/js/features/module-switcher.js';
import { createUiShell } from '/static/js/features/ui-shell.js';
import { createConfirmDialogFeature } from '/static/js/features/confirm-dialog.js';
import { createCookbookNavigationFeature } from '/static/js/features/cookbook-navigation.js';
import { createRecipeViewFeature } from '/static/js/features/recipe-view.js';
import { createRecipeEditorFeature } from '/static/js/features/recipe-editor.js';
import { createRecipeController } from '/static/js/features/recipe-mutations.js';
import { createRecipeSyncAdapter } from '/static/js/features/recipe-sync.js';
import * as storage from '/static/js/storage/indexed-db.js';
localStorage.setItem('nia-todo-language','de'); localStorage.setItem('nia-active-module','recipes');
if (!sessionStorage.getItem('recipes-fixture-booted')) {
 localStorage.setItem('nia-recipes-active-cookbook','2');
 history.replaceState({niaModuleRoute:true,moduleId:'recipes',niaCookbookRoute:true,cookbookId:2,niaRecipeRoute:true,recipeId:22},'', '/');
}
await initI18n(); await storage.openDatabase();
for (const id of ['login-overlay','boot-overlay']) { document.getElementById(id).classList.add('hidden');document.getElementById(id).style.display='none'; }
const sample = {id:22,cookbook_id:2,title:'Pasta mit Tomaten',description:'Frische Zutaten.\\nFür jeden Tag.',base_servings:2,prep_minutes:10,cook_minutes:15,tags:['Schnell'],revision:1,can_edit:true,created_by_user_id:22,client_mutation_id:'existing-22',image_url:'/api/recipes/recipes/22/image?v='+ 'a'.repeat(64),image_version:'a'.repeat(64),
 ingredient_groups:[{id:50,client_key:'g-pasta',name:'Pasta',ingredients:[{id:60,client_key:'i-pasta',name:'Pasta',quantity_value:100,quantity_unit:'g',quantity_text:'',note:'Bissfest kochen'},{id:61,client_key:'i-salt',name:'Salz',quantity_value:null,quantity_unit:'',quantity_text:'nach Geschmack',note:''}]}],
 steps:[{id:70,client_key:'s-first',text:'Wasser erhitzen.\\nPasta kochen.'},{id:71,client_key:'s-second',text:'Tomaten hinzufügen.'}]};
let books=[],actor='11:session',sequence=0,deferredImage=null,deferredCommit=null,commits=0;
let serverRecipe={...sample,revision:5,title:'Server version'};
const initial=[{id:1,name:'Personal',can_manage:true,can_edit:true,created_by_user_id:11,recipes:[],recipe_count:0},{id:2,name:'Household member',owner_household_id:7,created_by_user_id:22,can_manage:false,can_edit:true,recipes:[sample],recipe_count:1},{id:3,name:'Read only',can_manage:false,can_edit:false,recipes:[{...sample,id:33,cookbook_id:3,can_edit:false}],recipe_count:1}];
let nav,view,editor;
const errors=[],imageCalls=[],mutations=[];
const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP5sAAAAASUVORK5CYII=';
const shellUi=createUiShell({renderMarkdown:String,showTodoModal(){throw new Error('Tasks must not open');}});
shellUi.bindModalCloseControls();shellUi.bindSidebarControls();shellUi.bindKeyboardShortcuts();
const confirmation=createConfirmDialogFeature();confirmation.bindConfirmDialog();
const publish=next=>{
 const previous=books.flatMap(book=>book.recipes||[]);
 nav.replaceCookbooks(next);
 for(const recipe of books.flatMap(book=>book.recipes||[])) if(recipe.created_by_user_id===11){const old=previous.find(row=>String(row.id).startsWith('temp-')&&row.created_by_user_id===11&&row.client_mutation_id===recipe.client_mutation_id);if(old&&old.id!==recipe.id){editor?.remapRecipeId(old.id,recipe.id);view?.remapRecipeId(old.id,recipe.id);}}
 editor?.reconcile();
};
const api={getRecipe:async()=>structuredClone(serverRecipe)};
const controller=createRecipeController({getCookbooks:()=>books,setCookbooks:publish,getSessionIdentity:()=>actor,getCurrentUser:()=>({id:11}),recipesApi:api,createTempId:()=> 'temp-recipe-ui-'+(++sequence),
 commitMutation:async build=>{commits++;try{if(deferredCommit)await deferredCommit.promise;const mutation=build();if(mutation){await storage.commitRecipeMutation(mutation);mutations.push(structuredClone(mutation));}return mutation;}finally{commits--;}}});
nav=createCookbookNavigationFeature({getCookbooks:()=>books,setCookbooks:next=>{books=next;},getActorId:()=>actor?11:null,closeSidebar:options=>shellUi.closeSidebar(options),cookbookApi:{listInvites:async()=>[]},onDeactivate:()=>{editor?.deactivate();}});
const images={load:async(img,recipe,options)=>{imageCalls.push({id:recipe.id,draft:options.draft||false,source:recipe.image_data??recipe.image_url});if(!options.isCurrent())return false;if(!recipe.image_data&&!recipe.image_url)return false;img.src=pixel;return true;},release:img=>img?.removeAttribute('src')};
view=createRecipeViewFeature({getCookbooks:()=>books,getActiveCookbookId:()=>nav.getActiveCookbookId(),getActorId:()=>actor?11:null,getSessionIdentity:()=>actor,recipeController:controller,confirmDanger:options=>confirmation.confirmDanger(options),onCreate:book=>editor.showCreate(book.id),onEdit:recipe=>editor.showEdit(recipe.id),loadRecipeImage:images.load,releaseRecipeImage:images.release,onError:error=>errors.push(error.message)});
editor=createRecipeEditorFeature({getCookbooks:()=>books,recipeController:controller,getSessionIdentity:()=>actor,confirmDanger:options=>confirmation.confirmDanger(options),
 prepareRecipeImage:async file=>{if(deferredImage)await deferredImage.promise;if(!file.type.startsWith('image/'))throw Object.assign(new Error('invalid'),{code:'recipe.image.invalid'});return pixel;},loadRecipeImage:images.load,releaseRecipeImage:images.release,
 onSaved:recipe=>view.selectRecipe(recipe.id),onDeleted:()=>view.showOverview({replaceHistory:true}),onError:error=>errors.push(error.message)});
nav.setRecipeView(view);
const beforeHydrate=localStorage.getItem('nia-recipes-active-cookbook');
const shell=createModuleShell({getUser:()=>({id:11,disabled_modules:[]})});shell.registerController('recipes',{onActivate:()=>nav.activate(),onDeactivate:()=>nav.deactivate(),onSearch:value=>nav.setSearchQuery(value)});shell.bind();
createModuleSwitcher({getModules:()=>shell.getEnabledModules(),onModuleChange:id=>shell.navigateToModule(id)}).bind();
editor.bind();view.bind();
const stored=await storage.getAll('cookbooks');const hydrated=stored.length?stored:initial;
if(!stored.length)for(const book of initial)await storage.put('cookbooks',book);
publish(hydrated);sessionStorage.setItem('recipes-fixture-booted','1');
document.getElementById('search-input').addEventListener('input',()=>shell.handleSearch());
const adapter=api=>createRecipeSyncAdapter({api,getCookbooks:()=>books,setCookbooks:publish,readQueue:()=>storage.getAll('syncQueue'),markAttempt:storage.markRecipeMutationAttempt,commitReplay:storage.commitRecipeReplay,onIdRemap:(from,to)=>{editor.remapRecipeId(from,to);view.remapRecipeId(from,to);}});
window.recipeTest={view,editor,nav,shell,controller,storage,errors,mutations,imageCalls,beforeHydrate,books:()=>structuredClone(books),queue:()=>storage.getAll('syncQueue'),pending:()=>commits,
 set:publish,setActor:value=>{actor=value;},setServer:value=>{serverRecipe=structuredClone(value);},
 deferImage:()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});deferredImage={promise,resolve};},releaseImage:()=>{const old=deferredImage;deferredImage=null;old?.resolve();},
 deferCommit:()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});deferredCommit={promise,resolve};},releaseCommit:()=>{const old=deferredCommit;deferredCommit=null;old?.resolve();},
 acknowledgeCreate:async id=>{const entry=(await storage.getAll('syncQueue')).find(row=>row.action==='CREATE_RECIPE'&&row.data.temp_id===id);return adapter({createRecipe:async(_book,data)=>({...data,id:101,cookbook_id:2,created_by_user_id:11,can_edit:true,revision:1,applied_revision:1,image_url:sample.image_url,image_version:sample.image_version,ingredient_groups:data.ingredient_groups.map((group,index)=>({...group,id:500+index,ingredients:group.ingredients.map((item,itemIndex)=>({...item,id:600+itemIndex}))})),steps:data.steps.map((step,index)=>({...step,id:700+index}))})}).replay(entry,{value:false,privacyGeneration:0},0);},
 conflict:async(id,operation='update')=>{const local=controller.getRecipe(id);const server={...local,title:'Server version',revision:5};serverRecipe=server;const next={...local,conflict:{local:structuredClone(local),server,operation}};const nextBooks=books.map(book=>({...book,recipes:book.recipes.map(recipe=>recipe.id===id?next:recipe)}));for(const book of nextBooks)await storage.put('cookbooks',book);publish(nextBooks);},
};
`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.route('http://recipes-ui.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') {
      const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      return route.fulfill({ contentType: 'text/html', body: html.replace('</body>', '<script type="module" src="/fixture.js"></script></body>') });
    }
    if (pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: fixture });
    if (pathname.startsWith('/static/')) {
      try { return route.fulfill({ body: readFileSync(new URL(`../web${pathname}`, import.meta.url)), contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.json') ? 'application/json' : pathname.endsWith('.css') ? 'text/css' : 'application/octet-stream' }); }
      catch { return route.fulfill({ status: 404, body: `Missing asset: ${pathname}` }); }
    }
    return route.fulfill({ status: 404, body: 'This fixture has no service' });
  });
  await page.goto('http://recipes-ui.test/');
  await page.waitForFunction(() => Boolean(window.recipeTest));
  assert.equal(await page.evaluate(() => window.recipeTest.beforeHydrate), '2', 'unhydrated construction must preserve the stored cookbook');
  assert.equal(await page.evaluate(() => window.recipeTest.nav.getActiveCookbookId()), 2);
  assert.equal(await page.evaluate(() => window.recipeTest.view.getActiveRecipeId()), 22, 'recipe history survives empty construction then hydration');
  assert.equal(await page.locator('.recipe-reading h1').textContent(), 'Pasta mit Tomaten');
  assert.equal(await page.locator('.recipe-metadata .recipe-tag').textContent(), 'Schnell', 'only user-provided tags are shown');
  const amount = page.locator('[data-recipe-amount="i-pasta"]');
  await assertControlIcon(page.locator('[data-recipe-action="less"]'), 'minus');
  await assertControlIcon(page.locator('[data-recipe-action="more"]'), 'plus');
  await page.locator('[data-recipe-action="more"]').click();
  assert.equal(await amount.textContent(), '150 g');
  assert.equal(await page.locator('[data-recipe-amount="i-salt"]').textContent(), 'nach Geschmack', 'free quantities do not scale');
  await page.locator('[data-recipe-ingredient="i-pasta"]').check();
  await page.evaluate(() => { const test=window.recipeTest;test.shell.navigateToModule('tasks');test.shell.navigateToModule('recipes'); });
  assert.equal(await page.evaluate(() => window.recipeTest.view.getActiveRecipeId()), 22);
  assert.equal(await page.locator('#recipe-view-servings').inputValue(), '3', 'module roundtrip preserves cooking portions');
  assert.equal(await page.locator('[data-recipe-ingredient="i-pasta"]').isChecked(), true);
  assert.equal(await page.locator('.recipe-steps li').count(), 2);
  assert.equal(await page.locator('.recipe-steps li p').first().textContent(), 'Wasser erhitzen.\nPasta kochen.');
  assert.equal(await page.locator('img[src^="/api/recipes"]').count(), 0, 'private image endpoints are never used as direct image src');

  const modal = page.locator('#recipe-modal');
  const close = async () => { await modal.locator('button[data-close-modal="recipe-modal"]').click(); await page.waitForFunction(() => document.getElementById('recipe-modal').getAttribute('aria-hidden') === 'true' && !(history.state?.niaTodoUi?.layers || []).includes('recipe-modal')); };
  const closed = () => page.waitForFunction(() => document.getElementById('recipe-modal').getAttribute('aria-hidden') === 'true' && !(history.state?.niaTodoUi?.layers || []).includes('recipe-modal'));
  await page.locator('[data-module-slot="floating"][data-module-panel="recipes"] [data-recipe-action="create"]').click();
  assert.equal(await page.locator('#recipe-name').isDisabled(), false, 'household participants can edit recipe content without metadata management');
  await page.fill('#recipe-name', 'Structured recipe'); await page.fill('#recipe-base-servings', '4');
  await page.locator('[data-recipe-editor-action="group-add"]').click();
  const group = page.locator('.recipe-editor-group').first();
  const groupKey = await group.getAttribute('data-key');
  await group.locator('[data-field="group-name"]').fill('Teig');
  await group.locator('[data-recipe-editor-action="ingredient-add"]').click();
  let ingredient = group.locator('.recipe-editor-ingredient').first();
  await ingredient.locator('[data-field="name"]').fill('Mehl'); await ingredient.locator('[data-field="quantity_value"]').fill('250'); await ingredient.locator('[data-field="quantity_unit"]').fill('g');
  await ingredient.locator('[data-field="quantity_text"]').fill('nach Bedarf');
  assert.equal(await page.locator('#recipe-save-btn').isHidden(), true, 'numeric and free quantities cannot both be submitted');
  assert.equal(await ingredient.locator('.recipe-quantity-error').isVisible(), true);
  await ingredient.locator('[data-field="quantity_text"]').fill(''); await ingredient.locator('[data-field="note"]').fill('fein gemahlen');
  await group.locator('[data-recipe-editor-action="ingredient-add"]').click();
  ingredient = group.locator('.recipe-editor-ingredient').nth(1);
  await ingredient.locator('[data-field="name"]').fill('Wasser'); await ingredient.locator('[data-field="quantity_text"]').fill('nach Bedarf');
  await page.locator('[data-recipe-editor-action="group-add"]').click();
  await page.locator('.recipe-editor-group').nth(1).locator('[data-field="group-name"]').fill('Belag');
  await page.locator('.recipe-editor-group').nth(1).locator('[data-recipe-editor-action="group-up"]').click();
  assert.deepEqual(await page.locator('.recipe-editor-group [data-field="group-name"]').evaluateAll(nodes => nodes.map(node => node.value)), ['Belag','Teig']);
  assert.equal(await page.locator(`.recipe-editor-group[data-key="${groupKey}"] [data-field="name"]`).first().inputValue(), 'Mehl');
  await page.locator('[data-recipe-editor-action="step-add"]').click();
  await page.locator('.recipe-editor-step textarea').first().fill('Erste Zeile.\nZweite Zeile.\n\nDritter Absatz.');
  await page.locator('[data-recipe-editor-action="step-add"]').click(); await page.locator('.recipe-editor-step textarea').nth(1).fill('Finish');
  await page.locator('.recipe-editor-step').nth(1).locator('[data-recipe-editor-action="step-up"]').click();
  for (const kind of ['group', 'ingredient', 'step']) {
    await assertControlIcon(page.locator(`[data-recipe-editor-action="${kind}-up"]`).first(), 'chevron-up');
    await assertControlIcon(page.locator(`[data-recipe-editor-action="${kind}-down"]`).first(), 'chevron-down');
  }
  await page.locator('[data-recipe-editor-action="tag-add"]').click(); await page.locator('#recipe-editor-tags input').first().fill('Familie');
  await page.locator('[data-recipe-editor-action="tag-add"]').click(); await page.locator('#recipe-editor-tags input').nth(1).fill('Saisonal');
  await page.locator('.recipe-editor-step textarea').nth(1).evaluate(node => { window.recipeTextareaBeforeLanguage = node; node.focus(); node.setSelectionRange(2, 6); });
  await page.locator(`.recipe-editor-group[data-key="${groupKey}"] [data-field="name"]`).first().evaluate(node => { window.recipeIngredientBeforeLanguage = node; });
  await page.evaluate(async () => { const { setLanguagePreference } = await import('/static/js/i18n/index.js'); await setLanguagePreference('en'); });
  assert.equal(await page.locator('label[for="recipe-base-servings"]').textContent(), 'Base servings');
  assert.equal(await page.locator('.recipe-editor-step [data-recipe-step-label]').nth(1).textContent(), 'Step 2');
  assert.equal(await page.locator('.recipe-editor-step textarea').nth(1).evaluate(node => node === window.recipeTextareaBeforeLanguage && document.activeElement === node && node.selectionStart === 2 && node.selectionEnd === 6), true, 'language changes preserve textarea node, draft, focus and selection');
  assert.equal(await page.locator(`.recipe-editor-group[data-key="${groupKey}"] [data-field="name"]`).first().evaluate(node => node === window.recipeIngredientBeforeLanguage && node.value === 'Mehl'), true);
  await page.evaluate(async () => { const { setLanguagePreference } = await import('/static/js/i18n/index.js'); await setLanguagePreference('de'); });
  await page.locator('#recipe-image-file').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: Buffer.from('mock image preparation input') });
  await page.waitForFunction(() => Boolean(window.recipeTest.editor.getDraft().image_data));
  await page.click('#recipe-save-btn'); await closed();
  const created = await waitForPageCondition(page, () => window.recipeTest.books().flatMap(book => book.recipes || []).find(recipe => recipe.title === 'Structured recipe'));
  const queue = await page.evaluate(() => window.recipeTest.queue());
  assert.equal(queue[0].action, 'CREATE_RECIPE'); assert.equal(queue[0].data.cookbook_id, 2);
  assert.deepEqual(queue[0].data.tags, ['Familie','Saisonal']); assert.equal(queue[0].data.steps.length, 2);
  assert.equal(queue[0].data.steps[1].text, 'Erste Zeile.\nZweite Zeile.\n\nDritter Absatz.', 'multiline text remains one ordered step');
  assert.equal(queue[0].data.ingredient_groups[1].ingredients[1].quantity_text, 'nach Bedarf');
  assert.equal(new Set(queue[0].data.ingredient_groups.flatMap(group => [group.client_key,...group.ingredients.map(item => item.client_key)])).size, 4);
  assert.ok(queue[0].data.image_data.startsWith('data:image/png;base64,'));
  await page.locator('[data-recipe-action="edit"]').click(); await page.fill('#recipe-name', 'Draft after acknowledgement');
  await page.evaluate(id => window.recipeTest.acknowledgeCreate(id), created.id);
  assert.equal(await page.locator('#recipe-id').inputValue(), '101'); assert.equal(await page.locator('#recipe-name').inputValue(), 'Draft after acknowledgement');
  assert.equal(await page.evaluate(() => window.recipeTest.editor.getDraft().steps[0].id), 700);
  await page.click('#recipe-save-btn'); await closed();
  const update = (await page.evaluate(() => window.recipeTest.queue()))[0];
  assert.deepEqual(Object.keys(update.data.changes), ['title'], 'receipt-only child IDs must not make unchanged arrays dirty');
  assert.equal(update.data.expected_revision, 1, 'an editor opened before its own create acknowledgement rebases only to revision1');
  await page.reload(); await page.waitForFunction(() => Boolean(window.recipeTest));
  assert.equal(await page.evaluate(() => window.recipeTest.view.getActiveRecipeId()), 101, 'reload restores the recipe from durable cache and clean history');
  assert.equal(await page.locator('.recipe-reading h1').textContent(), 'Draft after acknowledgement');
  await page.evaluate(() => window.recipeTest.conflict(101));
  const beforeObsoleteConflict = (await page.evaluate(() => window.recipeTest.queue())).length;
  await page.locator('.recipe-reading [data-recipe-action="keep-local"]').click();
  await page.locator('#confirm-modal').waitFor({ state: 'visible' });
  await page.evaluate(() => window.recipeTest.shell.navigateToModule('tasks'));
  await page.click('#confirm-confirm-btn');
  await page.locator('#confirm-modal').waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(() => window.recipeTest.queue())).length, beforeObsoleteConflict, 'a confirmation from a deactivated recipe view must not overwrite the server');
  assert.equal(await page.evaluate(() => Boolean(window.recipeTest.controller.getRecipe(101).conflict)), true);
  await page.evaluate(() => window.recipeTest.shell.navigateToModule('recipes'));
  await page.locator('.recipe-reading [data-recipe-action="use-server"]').click();
  await waitForPageCondition(page, () => !window.recipeTest.controller.getRecipe(101).conflict);
  assert.equal(await page.locator('.recipe-reading h1').textContent(), 'Server version');
  assert.equal((await page.evaluate(() => window.recipeTest.queue())).length, 0);
  await page.evaluate(() => window.recipeTest.controller.update(101, { title: 'Local retained' }));
  await page.evaluate(() => window.recipeTest.conflict(101));
  await page.locator('.recipe-reading [data-recipe-action="keep-local"]').click(); await page.click('#confirm-confirm-btn');
  await waitForPageCondition(page, () => !window.recipeTest.controller.getRecipe(101).conflict);
  assert.equal((await page.evaluate(() => window.recipeTest.queue()))[0].data.expected_revision, 5);
  assert.equal(await page.locator('.recipe-reading h1').textContent(), 'Local retained');

  await page.locator('[data-recipe-action="edit"]').click();
  await page.fill('#recipe-name', 'Additional unsaved draft');
  const unsavedStep = page.locator('#recipe-editor-steps textarea').first();
  await unsavedStep.fill('A later unsaved step.\nIts own second line.');
  await page.evaluate(() => window.recipeTest.conflict(101));
  assert.equal(await page.locator('#recipe-name').isDisabled(), true, 'a newly received conflict freezes the open draft');
  await page.locator('#recipe-editor-conflict [data-recipe-action="keep-local"]').click();
  await page.click('#confirm-confirm-btn');
  await waitForPageCondition(page, () => !window.recipeTest.controller.getRecipe(101).conflict);
  assert.equal(await page.locator('#recipe-name').inputValue(), 'Additional unsaved draft');
  assert.equal(await unsavedStep.inputValue(), 'A later unsaved step.\nIts own second line.', 'keep-local retains newer unsaved structured fields');
  assert.equal(await page.evaluate(() => window.recipeTest.controller.getRecipe(101).title), 'Local retained', 'resolution only commits the saved queue intent');
  await page.locator('#recipe-save-btn').waitFor({ state: 'visible' });
  await page.click('#recipe-save-btn'); await closed();
  assert.equal(await page.locator('.recipe-reading h1').textContent(), 'Additional unsaved draft');

  await page.locator('[data-recipe-action="edit"]').click();
  await page.locator('#recipe-image-remove').click();
  assert.equal(await page.evaluate(() => window.recipeTest.editor.getDraft().image_data), null, 'explicit image removal differs from preserving the current image');
  await close();
  await page.evaluate(() => window.recipeTest.editor.showCreate(2));
  await page.evaluate(() => window.recipeTest.deferImage());
  await page.locator('#recipe-image-file').setInputFiles({ name: 'late.png', mimeType: 'image/png', buffer: Buffer.from('late image') });
  await close(); await page.evaluate(() => window.recipeTest.editor.showCreate(2));
  await page.evaluate(() => window.recipeTest.releaseImage());
  assert.equal(await page.evaluate(() => Object.hasOwn(window.recipeTest.editor.getDraft(),'image_data')), false, 'late image preparation cannot populate a new draft');
  await close();
  await page.evaluate(() => window.recipeTest.nav.selectCookbook(3));
  assert.equal(await page.locator('[data-module-slot="floating"][data-module-panel="recipes"] [data-recipe-action="create"]').isHidden(), true);
  await page.locator('[data-recipe-action="open"]').click();
  assert.equal(await page.locator('[data-recipe-action="edit"]').count(), 0, 'read-only content has no editor entrypoint');
  await page.evaluate(() => window.recipeTest.conflict(33));
  assert.equal(await page.locator('.recipe-reading .recipe-conflict button:disabled').count(), 2, 'conflict actions respect revoked content editing');
  await page.evaluate(() => window.recipeTest.nav.selectCookbook(2)); await page.locator('[data-recipe-action="open"][data-recipe-id="101"]').click();
  await page.goBack(); await page.waitForFunction(() => window.recipeTest.view.getActiveRecipeId() === null);
  assert.equal(new URL(page.url()).pathname, '/');
  await page.locator('[data-recipe-action="open"][data-recipe-id="101"]').click();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.locator('.recipe-columns').evaluate(element => { const parts=Array.from(element.children).map(node=>node.getBoundingClientRect());return {left:parts[0].left,right:parts[1].left,top:parts[0].top,next:parts[1].top,overflow:document.documentElement.scrollWidth>innerWidth}; });
    assert.equal(layout.overflow,false);
    const contentBounds = await page.locator('.recipe-page').evaluate(node => ({ right: node.getBoundingClientRect().right, width: innerWidth, heading: node.querySelector('h1').getBoundingClientRect().right, image: node.querySelector('.recipe-title-image').getBoundingClientRect().right }));
    assert.ok(contentBounds.right <= contentBounds.width + 1 && contentBounds.heading <= contentBounds.width + 1 && contentBounds.image <= contentBounds.width + 1, `recipe content must fit the viewport: ${JSON.stringify(contentBounds)}`);
    assert.equal(width > 768 ? layout.right > layout.left : layout.next > layout.top, true, 'desktop columns and mobile stacking match the approved view');
    if (process.env.NIA_TODO_TEST_OUTPUT_DIR) { mkdirSync(process.env.NIA_TODO_TEST_OUTPUT_DIR,{recursive:true}); await page.screenshot({path:`${process.env.NIA_TODO_TEST_OUTPUT_DIR}/recipes-${width}.png`,fullPage:true,animations:'disabled'}); }
  }
  await page.locator('[data-recipe-action="edit"]').click();
  assert.equal(await modal.evaluate(node => node.querySelector('.modal-content').scrollWidth <= node.querySelector('.modal-content').clientWidth), true, 'structured mobile editor has no horizontal overflow');
  await page.locator('#recipe-name').press('Escape'); await closed();
  await page.locator('[data-recipe-action="edit"]').click();
  await page.locator('#recipe-detail-header-menu summary').click(); await page.click('#recipe-delete-btn');
  await page.click('#confirm-confirm-btn'); await closed();
  assert.equal(await page.evaluate(() => window.recipeTest.view.getActiveRecipeId()), null);
  assert.equal(await page.locator('[data-recipe-action="open"][data-recipe-id="101"]').count(), 0);
  const deletion = (await page.evaluate(() => window.recipeTest.queue())).find(entry => entry.action === 'DELETE_RECIPE');
  assert.equal(deletion.data.expected_revision, 5, 'deletion uses the editor baseline revision');
  await page.evaluate(() => window.recipeTest.editor.showCreate(2)); await page.fill('#recipe-name', 'Old account recipe');
  await page.evaluate(() => window.recipeTest.deferCommit()); await page.click('#recipe-save-btn');
  await page.evaluate(async () => { const test=window.recipeTest;test.setActor(null);await test.nav.suspendAccessPrivacy();test.set([]);test.releaseCommit(); });
  await closed(); await waitForPageCondition(page, () => window.recipeTest.pending() === 0);
  assert.equal((await page.evaluate(() => window.recipeTest.queue())).some(entry => entry.data.title === 'Old account recipe'), false, 'account transition must cancel delayed recipe creation');
  assert.deepEqual(await page.evaluate(() => window.recipeTest.errors),[]); assert.deepEqual(errors,[]);
  console.log('✅ Recipe overview/reading/editor, structured fields, image/session guards, conflicts, revisions, history and mobile layout passed');
} finally { await browser.close(); }

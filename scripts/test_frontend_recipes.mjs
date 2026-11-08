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

async function assertRecipeCardOverview(page) {
  const original = await page.evaluate(() => ({ books: window.recipeTest.books(), history: history.state }));
  const samples = [
    { id: 201, title: 'Alpha Salat', tags: ['Vegan', 'Schnell', '新鲜'], prep_minutes: 5, cook_minutes: 0, created_at: '2026-01-01T10:00:00Z', image: true },
    { id: 202, title: 'Beta Suppe', tags: ['Vegan'], prep_minutes: 10, cook_minutes: 20, created_at: '2026-06-01T10:00:00Z' },
    { id: 203, title: 'Gamma Brot – хлеб', tags: ['Schnell'], prep_minutes: null, cook_minutes: 5, created_at: '2026-03-01T10:00:00Z' },
    { id: 204, title: 'Delta Bowl', tags: ['Vegan', 'Schnell'], prep_minutes: 7, cook_minutes: 3, created_at: '2026-06-01T10:00:00Z' },
    { id: 205, title: 'Echo ohne Zeit', tags: ['Schnell'], prep_minutes: null, cook_minutes: null, created_at: '2026-04-01T10:00:00Z' },
    { id: 206, title: 'Zeta <img src=x onerror="window.recipeOverviewXss=true">', tags: ['<svg onload="window.recipeOverviewXss=true">'], prep_minutes: 0, cook_minutes: 0, created_at: '2026-07-01T10:00:00Z' },
  ];
  const defaultOrder = [201, 202, 204, 205, 203, 206];
  const cards = () => page.locator('.recipe-card.recipe-list-row[data-recipe-action="open"]');
  const card = id => page.locator(`.recipe-card[data-recipe-id="${id}"]`);
  const ids = () => cards().evaluateAll(nodes => nodes.map(node => Number(node.dataset.recipeId)));
  const tag = name => page.locator('[data-recipe-action="filter-tag"]').filter({ hasText: name });
  const selectedTags = () => page.locator('[data-recipe-action="filter-tag"][aria-pressed="true"]').evaluateAll(nodes => nodes.map(node => node.dataset.recipeTag).sort());
  const setLanguage = language => page.evaluate(async language => {
    const { setLanguagePreference } = await import('/static/js/i18n/index.js'); await setLanguagePreference(language);
  }, language);
  const publishSamples = recipes => page.evaluate(recipes => {
    const test = window.recipeTest, books = test.books(), sample = books.find(book => book.id === 2).recipes[0];
    test.set(books.map(book => book.id === 2 ? { ...book, recipes: recipes.map(recipe => ({
      ...sample, ...recipe, cookbook_id: 2, client_mutation_id: `overview-${recipe.id}`,
      image_url: recipe.image ? sample.image_url : null, image_version: recipe.image ? sample.image_version : null,
    })), recipe_count: recipes.length } : book));
  }, recipes);
  try {
    await publishSamples(samples);
    await page.evaluate(() => window.recipeTest.view.showOverview({ replaceHistory: true }));
    await cards().first().waitFor({ state: 'visible' });
    assert.deepEqual(await ids(), defaultOrder, 'overview defaults to locale-aware name order');
    assert.equal(await cards().evaluateAll(nodes => nodes.every(node => node.tagName === 'BUTTON' && node.type === 'button')), true, 'each complete card is one native keyboard-operable button');
    assert.equal(await card(201).locator('.recipe-tag').count(), 2, 'cards show at most two manually entered tags');
    assert.ok((await card(206).textContent()).includes(samples[5].title), 'recipe titles remain literal text');
    assert.equal(await card(206).locator('img[src="x"],svg[onload],[onerror]').count(), 0);
    assert.equal(await page.evaluate(() => Boolean(window.recipeOverviewXss)), false, 'recipe titles and tags cannot execute markup');
    await waitForPageCondition(page, () => {
      const img = document.querySelector('.recipe-card[data-recipe-id="201"] img');
      return img && !img.hidden && img.getAttribute('src')?.startsWith('data:');
    });
    assert.equal(await card(202).locator('.recipe-image-placeholder').isVisible(), true, 'missing private images retain a visible placeholder');
    assert.equal(await cards().locator('img[src^="/api/recipes"]').count(), 0, 'cards use the authenticated image callback instead of direct private URLs');

    await tag('Vegan').click(); assert.deepEqual(await ids(), [201, 202, 204]);
    await tag('Schnell').click(); assert.deepEqual(await ids(), [201, 204], 'selected tag filters combine with AND');
    assert.deepEqual(await selectedTags(), ['Schnell', 'Vegan']);
    await page.fill('#search-input', 'Alpha'); assert.deepEqual(await ids(), [201], 'shared topbar search combines with selected tags');
    await page.fill('#search-input', 'No matching recipe'); assert.deepEqual(await ids(), []);
    assert.equal(await page.locator('.recipe-empty').isVisible(), true);
    await page.locator('[data-recipe-action="clear-filters"]').click();
    assert.deepEqual(await selectedTags(), []); assert.deepEqual(await ids(), [], 'clear filters does not discard the shared search query');
    await page.fill('#search-input', ''); assert.deepEqual(await ids(), defaultOrder);
    await page.fill('#search-input', 'ХЛЕБ'); assert.deepEqual(await ids(), [203], 'shared search handles non-Latin recipe text case-insensitively');
    await page.fill('#search-input', '');
    await tag('新鲜').click(); assert.deepEqual(await ids(), [201], 'all user tags remain filterable, including tags beyond the two shown on a card');
    await page.locator('[data-recipe-action="clear-filters"]').click();
    await page.locator('#recipe-overview-sort').selectOption('newest', { force: true });
    assert.deepEqual(await ids(), [206, 202, 204, 205, 203, 201], 'newest sorts descending with an alphabetical timestamp tie');
    await publishSamples(samples.map(recipe => recipe.id === 202
      ? { ...recipe, created_at: '2026-06-01 10:30:00' } : recipe));
    assert.deepEqual(await ids(), [206, 202, 204, 205, 203, 201], 'SQLite UTC timestamps without a suffix sort by the same instant as pending ISO timestamps in a non-UTC browser');
    await publishSamples(samples);
    assert.deepEqual(await ids(), [206, 202, 204, 205, 203, 201], 'restoring equal timestamps retains the alphabetical newest tie-break');
    await page.locator('#recipe-overview-sort').selectOption('time', { force: true });
    assert.deepEqual(await ids(), [206, 201, 204, 202, 205, 203], 'only complete prep+cook totals sort before partial or unknown times; zero is known');
    assert.match(await card(201).textContent(), /5 Min\. gesamt/);
    assert.match(await card(203).textContent(), /5 Min\. Kochzeit/);
    assert.doesNotMatch(await card(203).textContent(), /gesamt/, 'a known single time component is not presented as the total');

    await tag('Vegan').click(); await tag('Schnell').click();
    await card(201).focus(); await card(201).press('Enter');
    assert.equal(await page.locator('.recipe-reading h1').textContent(), 'Alpha Salat', 'Enter on a card opens the reading view');
    await page.locator('[data-recipe-action="overview"]').click();
    assert.deepEqual(await selectedTags(), ['Schnell', 'Vegan']);
    assert.equal(await page.locator('#recipe-overview-sort').inputValue(), 'time', 'reading roundtrip retains overview state within the cookbook');
    assert.deepEqual(await ids(), [201, 204]);
    await publishSamples(samples.map(recipe => recipe.id === 202 ? { ...recipe, description: 'Updated remotely' } : recipe));
    assert.deepEqual(await selectedTags(), ['Schnell', 'Vegan'], 'live cookbook updates retain valid selected tags');
    assert.equal(await page.locator('#recipe-overview-sort').inputValue(), 'time');
    await page.locator('[data-recipe-action="clear-filters"]').click();
    assert.equal(await page.locator('#recipe-overview-sort').inputValue(), 'time', 'clearing tags leaves the selected sort unchanged');

    await setLanguage('en');
    assert.equal(await page.locator('#recipe-overview-sort option[value="time"]').textContent(), 'Total time');
    assert.match(await card(201).textContent(), /5 min total/);
    assert.match(await card(203).textContent(), /5 min\. cooking/);
    assert.deepEqual(await ids(), [206, 201, 204, 202, 205, 203], 'translation keeps the current sort');
    await setLanguage('de');
    await page.locator('#recipe-overview-sort').selectOption('name', { force: true });
    for (const [width, columns] of [[1280, 3], [390, 2], [320, 1]]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.locator('.recipe-list').evaluate(node => ({
        columns: getComputedStyle(node).gridTemplateColumns.split(' ').filter(Boolean).length,
        overflow: document.documentElement.scrollWidth > innerWidth,
        cardsFit: Array.from(node.querySelectorAll('.recipe-card')).every(card => {
          const box = card.getBoundingClientRect(); return box.left >= -1 && box.right <= innerWidth + 1;
        }),
        images: Array.from(node.querySelectorAll('.recipe-thumbnail')).map(image => {
          const box = image.getBoundingClientRect(); return box.width / box.height;
        }),
      }));
      assert.equal(layout.columns, columns, `${width}px overview has the expected column count`);
      assert.equal(layout.overflow, false, `${width}px overview has no horizontal body overflow`);
      assert.equal(layout.cardsFit, true, `${width}px cards stay inside the viewport`);
      assert.equal(layout.images.length, 6);
      assert.ok(layout.images.every(ratio => Math.abs(ratio - 1.5) < .02), 'card images and placeholders retain a 3:2 frame');
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const reset of ['book', 'session', 'deactivate']) {
      await tag('Vegan').click(); await page.locator('#recipe-overview-sort').selectOption('newest', { force: true });
      await page.evaluate(reset => {
        const test = window.recipeTest;
        if (reset === 'book') { test.nav.selectCookbook(1); test.nav.selectCookbook(2); }
        else if (reset === 'session') { test.setActor('11:overview-session'); test.nav.render(); test.setActor('11:session'); test.nav.render(); }
        else { test.shell.navigateToModule('tasks'); test.shell.navigateToModule('recipes'); }
      }, reset);
      assert.deepEqual(await selectedTags(), [], `${reset} resets selected tags`);
      assert.equal(await page.locator('#recipe-overview-sort').inputValue(), 'name', `${reset} resets sort to name`);
      assert.deepEqual(await ids(), defaultOrder);
    }
    await tag('Vegan').click();
    await publishSamples(samples.map(recipe => ({ ...recipe, tags: recipe.tags.filter(tag => tag !== 'Vegan') })));
    assert.deepEqual(await selectedTags(), [], 'a live update removes a filter that no longer exists in the cookbook');
    assert.equal(await cards().count(), 6);
  } finally {
    await page.fill('#search-input', '');
    await setLanguage('de');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(original => {
      const test = window.recipeTest; test.setActor('11:session'); test.set(original.books);
      test.nav.selectCookbook(2); test.view.selectRecipe(22, { replaceHistory: true });
      history.replaceState(original.history, '', '/');
    }, original);
  }
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
const shell=createModuleShell({getUser:()=>({id:11,disabled_modules:[]})});shell.registerController('recipes',{onActivate:()=>nav.activate(),onDeactivate:()=>nav.deactivate(),onSearch:value=>nav.setSearchQuery(value),onLanguageChange:()=>nav.render()});shell.bind();
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Europe/Berlin' });
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
  await assertRecipeCardOverview(page);
  assert.equal(await page.locator('.recipe-reading h1').textContent(), 'Pasta mit Tomaten');
  assert.equal(await page.locator('.recipe-metadata .recipe-tag').textContent(), 'Schnell', 'only user-provided tags are shown');
  const amount = page.locator('[data-recipe-amount="i-pasta"]');
  await assertControlIcon(page.locator('[data-recipe-action="less"]'), 'minus');
  await assertControlIcon(page.locator('[data-recipe-action="more"]'), 'plus');
  await page.locator('[data-recipe-action="more"]').click();
  assert.equal(await amount.textContent(), '150 g');
  await page.locator('#recipe-view-servings').fill('1.6666666666666667');
  assert.equal(await amount.textContent(), '83 g', 'cooking uses the same typed kitchen rounding as Shopping transfer');
  await page.locator('#recipe-view-servings').fill('3');
  assert.equal(await page.locator('[data-recipe-amount="i-salt"]').textContent(), 'nach Geschmack', 'free quantities do not scale');
  await page.locator('[data-recipe-ingredient="i-pasta"]').check();
  await page.evaluate(() => { const test=window.recipeTest;test.shell.navigateToModule('tasks');test.shell.navigateToModule('recipes'); });
  assert.equal(await page.evaluate(() => window.recipeTest.view.getActiveRecipeId()), 22);
  assert.equal(await page.locator('#recipe-view-servings').inputValue(), '3', 'module roundtrip preserves cooking portions');
  assert.equal(await page.locator('[data-recipe-ingredient="i-pasta"]').isChecked(), true);
  assert.equal(await page.locator('.recipe-steps li').count(), 2);
  assert.equal(await page.locator('.recipe-steps li h3').first().textContent(), 'Wasser erhitzen.');
  assert.equal(await page.locator('.recipe-steps li p').first().textContent(), 'Pasta kochen.');
  assert.equal(await page.locator('.recipe-steps li').nth(1).locator('h3').textContent(), 'Tomaten hinzufügen.');
  const stepText = await page.locator('.recipe-step-copy').first().evaluate(node => Array.from(node.children, child => child.textContent).join('\n'));
  assert.equal(stepText, 'Wasser erhitzen.\nPasta kochen.', 'heading and body preserve the complete ordered step');
  for (const { theme, width } of ['dark', 'light'].flatMap(theme => [1280, 390, 320].map(width => ({ theme, width })))) {
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
    await page.setViewportSize({ width, height: 900 });
    await waitForPageCondition(page, minimum => {
      const button = document.querySelector('[data-recipe-action="less"]').getBoundingClientRect();
      return button.width === minimum && button.height === minimum;
    }, width > 768 ? 34 : 44);
    const design = await page.locator('.recipe-reading').evaluate(node => {
      const style = selector => getComputedStyle(node.querySelector(selector));
      const box = selector => node.querySelector(selector).getBoundingClientRect();
      const checkbox = box('.ui-checkbox-label'), copy = style('.recipe-ingredient-copy');
      const control = box('.recipe-servings'), less = box('[data-recipe-action="less"]');
      return { control: control.width, button: less.width, buttonHeight: less.height,
        checkWidth: checkbox.width, checkHeight: checkbox.height, round: style('.ui-checkbox-box').borderRadius,
        checked: node.querySelector('[data-recipe-ingredient="i-pasta"]').checked,
        checkVisible: style('.ui-checkbox-box .ui-icon').opacity, strike: copy.textDecorationLine,
        titleSize: parseFloat(style('h1').fontSize), descriptionSize: parseFloat(style('.recipe-description').fontSize),
        bodySize: parseFloat(style('.recipe-step-copy p').fontSize), titleWeight: +style('h1').fontWeight,
        stepWeight: +style('.recipe-step-copy h3').fontWeight, bodyWeight: +style('.recipe-step-copy p').fontWeight,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    assert.ok(design.control <= (width > 768 ? 140 : 160), `compact portions at ${width}px: ${JSON.stringify(design)}`);
    assert.ok(design.button >= (width > 768 ? 34 : 44) && design.buttonHeight >= (width > 768 ? 34 : 44), `portion touch target at ${width}px: ${JSON.stringify(design)}`);
    assert.ok(design.checkWidth >= 44 && design.checkHeight >= 44, 'ingredient checkbox keeps a 44px hit area');
    assert.equal(design.round, '50%'); assert.equal(design.checked, true);
    assert.equal(design.checkVisible, '1'); assert.equal(design.strike, 'line-through');
    assert.ok(design.titleSize > design.descriptionSize && design.descriptionSize > design.bodySize);
    assert.ok(design.titleWeight >= 700 && design.stepWeight >= 700 && design.stepWeight > design.bodyWeight);
    assert.equal(design.overflow, false, `reading view must fit at ${width}px`);
    if (process.env.NIA_TODO_TEST_OUTPUT_DIR) { mkdirSync(process.env.NIA_TODO_TEST_OUTPUT_DIR, { recursive: true }); await page.screenshot({ path: `${process.env.NIA_TODO_TEST_OUTPUT_DIR}/recipes-reading-${theme}-${width}.png`, fullPage: true, animations: 'disabled' }); }
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const checkbox = page.locator('[data-recipe-ingredient="i-pasta"]');
  await checkbox.focus(); await checkbox.press('Space');
  assert.equal(await checkbox.isChecked(), false, 'native keyboard interaction remains available');
  assert.notEqual(await checkbox.locator('..').locator('.ui-checkbox-box').evaluate(node => getComputedStyle(node).boxShadow), 'none', 'keyboard focus is visible on the shared check control');
  await page.locator('.recipe-ingredient-copy').first().click();
  assert.equal(await checkbox.isChecked(), true, 'clicking the ingredient text toggles its labelled checkbox');
  await page.fill('#recipe-view-servings', '100000'); await page.locator('#recipe-view-servings').press('Tab');
  assert.equal(await page.locator('#recipe-view-servings').inputValue(), '100000');
  assert.equal(await page.locator('[data-recipe-action="more"]').isDisabled(), true);
  const numberFits = await page.locator('#recipe-view-servings').evaluate(input => {
    const style = getComputedStyle(input), canvas = document.createElement('canvas'), context = canvas.getContext('2d');
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return context.measureText(input.value).width <= input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  });
  assert.equal(numberFits, true, 'maximum portion value remains fully visible');
  await page.fill('#recipe-view-servings', '0.5'); await page.locator('#recipe-view-servings').press('Tab');
  assert.equal(await amount.textContent(), '25 g', 'fractional portions continue to scale');
  await page.fill('#recipe-view-servings', '3'); await page.locator('#recipe-view-servings').press('Tab');
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await page.locator('img[src^="/api/recipes"]').count(), 0, 'private image endpoints are never used as direct image src');

  const modal = page.locator('#recipe-modal');
  const close = async () => { await modal.locator('button[data-close-modal="recipe-modal"]').click(); await page.waitForFunction(() => document.getElementById('recipe-modal').getAttribute('aria-hidden') === 'true' && !(history.state?.niaTodoUi?.layers || []).includes('recipe-modal')); };
  const closed = () => page.waitForFunction(() => document.getElementById('recipe-modal').getAttribute('aria-hidden') === 'true' && !(history.state?.niaTodoUi?.layers || []).includes('recipe-modal'));
  const ingredientRow = key => modal.locator(`.recipe-editor-ingredient[data-key="${key}"]`);
  const setQuantityMode = (row, mode) => row.locator('select[data-field="quantity_mode"]').selectOption(mode, { force: true });
  const openIngredientEditors = () => modal.locator('.recipe-editor-ingredient-editor:not([hidden])');
  const ingredientSummary = row => row.locator('.recipe-editor-ingredient-summary').evaluate(node => (node.textContent || '').replace(/\s+/g, ' '));

  await page.locator('[data-recipe-action="edit"]').click();
  const pastaRow = ingredientRow('i-pasta'), saltRow = ingredientRow('i-salt');
  const beforeIngredientChanges = await page.evaluate(async () => ({
    queue: await window.recipeTest.queue(), mutations: window.recipeTest.mutations.length,
    recipe: structuredClone(window.recipeTest.controller.getRecipe(22)),
  }));
  assert.equal(await openIngredientEditors().count(), 0, 'existing ingredients start as closed list rows');
  assert.match(await ingredientSummary(pastaRow), /100.*g.*Pasta/);
  assert.match(await ingredientSummary(pastaRow), /Bissfest kochen/);
  assert.match(await ingredientSummary(saltRow), /nach Geschmack.*Salz/);
  const pastaSummary = pastaRow.locator('.recipe-editor-ingredient-summary');
  assert.equal(await pastaSummary.evaluate(node => node.tagName), 'BUTTON');
  assert.equal(await pastaSummary.getAttribute('data-recipe-editor-action'), 'ingredient-edit');
  assert.equal(await pastaSummary.locator('svg').count(), 0, 'the complete ingredient summary replaces the separate pencil button');
  assert.equal(await pastaRow.locator('[data-recipe-editor-action="ingredient-up"]').isHidden(), true, 'reorder actions belong to the open ingredient editor');
  assert.equal(await pastaRow.locator('[data-recipe-editor-action="ingredient-remove"]').isHidden(), true);
  assert.equal(await pastaRow.locator('[data-field="name"]').evaluate(input => {
    input.focus(); return document.activeElement === input;
  }), false, 'closed ingredient fields do not receive focus');
  assert.equal(await page.locator('#recipe-form').evaluate(form => form.checkValidity()), true, 'closed ingredient fields must not leave unfocusable invalid controls');

  const groupHeading = modal.locator('[data-field="group-name"]').first();
  assert.equal(await groupHeading.evaluate(input => input.classList.contains('ui-detail-title-field') && input.classList.contains('ui-detail-section-title-field')), true, 'group names use the shared editable heading');
  assert.equal(await groupHeading.evaluate(input => input.labels.length), 0, 'group headings have no separate visible label');
  assert.equal(await groupHeading.getAttribute('data-i18n-aria-label-key'), 'recipe.group.name');
  assert.equal(await groupHeading.getAttribute('placeholder'), await groupHeading.getAttribute('aria-label'));
  await page.locator('#recipe-name').focus();
  const restingHeading = await groupHeading.evaluate(input => ({ weight: +getComputedStyle(input).fontWeight, background: getComputedStyle(input).backgroundColor }));
  assert.ok(restingHeading.weight >= 700, 'the unfocused group name reads as a bold heading');
  await groupHeading.focus();
  await waitForPageCondition(page, original => getComputedStyle(document.querySelector('#recipe-modal [data-field="group-name"]')).backgroundColor !== original, restingHeading.background);
  assert.notEqual(await groupHeading.evaluate(input => getComputedStyle(input).backgroundColor), restingHeading.background, 'focus reveals the shared title editing field');
  await groupHeading.fill('Pasta heading draft'); await groupHeading.press('Enter');
  assert.equal(await modal.getAttribute('aria-hidden'), 'false', 'Enter on a group heading never submits the recipe');
  assert.deepEqual(await page.evaluate(() => window.recipeTest.queue()), beforeIngredientChanges.queue);
  assert.equal(await page.evaluate(() => window.recipeTest.editor.getDraft().ingredient_groups[0].name), 'Pasta heading draft');
  await groupHeading.fill('Pasta');

  await pastaSummary.click();
  await pastaRow.locator('[data-field="note"]').fill('Toggle draft note');
  await pastaSummary.click();
  assert.equal(await openIngredientEditors().count(), 0, 'clicking the same summary toggles its editor closed');
  assert.equal(await pastaRow.locator('[data-field="note"]').inputValue(), 'Toggle draft note');
  await pastaSummary.press('Enter');
  assert.equal(await openIngredientEditors().count(), 1, 'Enter opens the summary button');
  assert.equal(await pastaRow.locator('[data-field="note"]').inputValue(), 'Toggle draft note');
  await pastaSummary.press('Space');
  assert.equal(await openIngredientEditors().count(), 0, 'Space toggles the same summary closed');
  await pastaSummary.press('Space');
  assert.equal(await openIngredientEditors().count(), 1, 'Space also opens a closed summary');
  await pastaRow.locator('[data-field="note"]').fill('Bissfest kochen');
  await pastaRow.locator('[data-recipe-editor-action="ingredient-done"]').click();

  await pastaRow.locator('[data-recipe-editor-action="ingredient-edit"]').click();
  await pastaRow.locator('[data-field="name"]').fill('Canceled pasta');
  await pastaRow.locator('[data-field="note"]').fill('Canceled note');
  await pastaRow.locator('[data-recipe-editor-action="ingredient-cancel"]').click();
  assert.equal(await openIngredientEditors().count(), 0);
  assert.equal(await pastaRow.locator('[data-field="name"]').inputValue(), 'Pasta');
  assert.equal(await pastaRow.locator('[data-field="note"]').inputValue(), 'Bissfest kochen', 'cancel restores the entire opening snapshot');

  await pastaRow.locator('[data-recipe-editor-action="ingredient-edit"]').click();
  await pastaRow.locator('[data-field="name"]').fill('');
  await pastaSummary.click();
  assert.equal(await openIngredientEditors().count(), 0, 'even an invalid ingredient can be toggled closed');
  assert.equal(await pastaRow.locator('[data-field="name"]').isDisabled(), true);
  assert.equal(await pastaRow.locator('[data-field="name"]').inputValue(), '', 'closing never discards invalid draft data');
  assert.equal(await page.locator('#recipe-form').evaluate(form => form.checkValidity()), true, 'closed invalid controls do not block native focus validation');
  assert.equal(await page.locator('#recipe-save-btn').isHidden(), true, 'the invalid structured payload still blocks recipe save');
  assert.deepEqual(await page.evaluate(() => window.recipeTest.queue()), beforeIngredientChanges.queue);
  await pastaSummary.press('Enter');
  assert.equal(await pastaRow.locator('[data-field="name"]').isEnabled(), true, 'reopening exposes the invalid field for correction');
  await saltRow.locator('[data-recipe-editor-action="ingredient-edit"]').click();
  assert.equal(await openIngredientEditors().count(), 1);
  assert.equal(await pastaRow.locator('.recipe-editor-ingredient-editor').isVisible(), true, 'an invalid ingredient blocks switching to another row');
  assert.equal(await saltRow.locator('.recipe-editor-ingredient-editor').isHidden(), true);
  assert.equal(await pastaRow.locator('[data-field="name"]').evaluate(input => document.activeElement === input && !input.validity.valid), true, 'the invalid field receives native validation focus');
  await pastaRow.locator('[data-field="name"]').fill('Draft pasta');
  await saltRow.locator('[data-recipe-editor-action="ingredient-edit"]').click();
  assert.equal(await openIngredientEditors().count(), 1);
  assert.equal(await pastaRow.locator('.recipe-editor-ingredient-editor').isHidden(), true);
  assert.equal(await saltRow.locator('.recipe-editor-ingredient-editor').isVisible(), true);
  assert.equal(await pastaRow.locator('[data-field="name"]').inputValue(), 'Draft pasta', 'switching rows retains valid changes in the recipe draft');
  assert.match(await ingredientSummary(pastaRow), /Draft pasta/);
  await setQuantityMode(saltRow, 'number');
  await saltRow.locator('[data-field="quantity_value"]').fill('2');
  await saltRow.locator('[data-field="quantity_unit"]').fill('g');
  await saltRow.locator('[data-recipe-editor-action="ingredient-cancel"]').click();
  assert.equal(await saltRow.locator('select[data-field="quantity_mode"]').inputValue(), 'text');
  assert.equal(await saltRow.locator('[data-field="quantity_text"]').inputValue(), 'nach Geschmack', 'cancel also restores the original quantity mode and free amount');
  assert.equal(await saltRow.locator('[data-field="quantity_value"]').inputValue(), '');
  await pastaRow.locator('[data-recipe-editor-action="ingredient-edit"]').click();
  await pastaRow.locator('[data-field="note"]').fill('Draft note');
  await pastaRow.locator('[data-recipe-editor-action="ingredient-done"]').click();
  assert.equal(await openIngredientEditors().count(), 0);
  assert.match(await ingredientSummary(pastaRow), /Draft note/);
  assert.equal(await page.evaluate(() => window.recipeTest.editor.getDraft().ingredient_groups[0].ingredients[0].name), 'Draft pasta');

  const beforeEmptyCancel = await modal.locator('.recipe-editor-ingredient').count();
  await modal.locator('[data-recipe-editor-action="ingredient-add"]').first().click();
  assert.equal(await openIngredientEditors().count(), 1, 'adding a new ingredient opens it immediately');
  await openIngredientEditors().locator('[data-recipe-editor-action="ingredient-cancel"]').click();
  assert.equal(await modal.locator('.recipe-editor-ingredient').count(), beforeEmptyCancel, 'cancel removes a newly added empty ingredient');
  assert.equal(await page.locator('#recipe-form').evaluate(form => form.checkValidity()), true);
  assert.deepEqual(await page.evaluate(() => window.recipeTest.queue()), beforeIngredientChanges.queue);
  assert.equal(await page.evaluate(() => window.recipeTest.mutations.length), beforeIngredientChanges.mutations, 'Apply and Cancel only affect the recipe draft');
  assert.deepEqual(await page.evaluate(() => window.recipeTest.controller.getRecipe(22)), beforeIngredientChanges.recipe, 'inline editing never saves the aggregate by itself');
  await close();

  await page.locator('[data-module-slot="floating"][data-module-panel="recipes"] [data-recipe-action="create"]').click();
  assert.equal(await page.locator('#recipe-name').isDisabled(), false, 'household participants can edit recipe content without metadata management');
  assert.equal(await page.locator('#recipe-image-remove').isHidden(), true, 'a recipe without an image has no removal action');
  await page.fill('#recipe-name', 'Structured recipe'); await page.fill('#recipe-base-servings', '4');
  await page.locator('[data-recipe-editor-action="group-add"]').click();
  const group = page.locator('.recipe-editor-group').first();
  const groupKey = await group.getAttribute('data-key');
  await group.locator('[data-field="group-name"]').fill('Teig');
  await group.locator('[data-recipe-editor-action="ingredient-add"]').click();
  let ingredient = group.locator('.recipe-editor-ingredient').first();
  assert.equal(await ingredient.locator('.recipe-editor-ingredient-editor').isVisible(), true);
  await ingredient.locator('[data-field="name"]').fill('Mehl'); await ingredient.locator('[data-field="quantity_value"]').fill('250'); await ingredient.locator('[data-field="quantity_unit"]').fill('g');
  assert.equal(await ingredient.locator('[data-field="quantity_text"]').isDisabled(), true);
  await setQuantityMode(ingredient, 'text');
  assert.equal(await ingredient.locator('[data-field="quantity_value"]').inputValue(), '', 'switching to free quantity clears the numeric amount');
  assert.equal(await ingredient.locator('[data-field="quantity_unit"]').inputValue(), '');
  assert.equal(await ingredient.locator('[data-field="quantity_value"]').isDisabled(), true);
  await ingredient.locator('[data-field="quantity_text"]').fill('nach Bedarf');
  await setQuantityMode(ingredient, 'number');
  assert.equal(await ingredient.locator('[data-field="quantity_text"]').inputValue(), '', 'switching back clears the free quantity instead of preserving conflicting hidden data');
  assert.equal(await ingredient.locator('[data-field="quantity_text"]').isDisabled(), true);
  await ingredient.locator('[data-field="quantity_value"]').fill('0');
  assert.equal(await ingredient.locator('[data-field="quantity_value"]').evaluate(input => input.validity.valid), false);
  assert.equal(await page.locator('#recipe-save-btn').isHidden(), true, 'an invalid numeric amount cannot be saved');
  await ingredient.locator('[data-field="quantity_value"]').fill('250'); await ingredient.locator('[data-field="quantity_unit"]').fill('g');
  await ingredient.locator('[data-field="note"]').fill('fein gemahlen');
  await ingredient.locator('[data-recipe-editor-action="ingredient-done"]').click();
  assert.match(await ingredientSummary(ingredient), /250.*g.*Mehl/);
  assert.match(await ingredientSummary(ingredient), /fein gemahlen/);
  assert.equal(await ingredient.locator('[data-field="note"]').isVisible(), false);
  await group.locator('[data-recipe-editor-action="ingredient-add"]').click();
  ingredient = group.locator('.recipe-editor-ingredient').nth(1);
  await setQuantityMode(ingredient, 'text');
  const tagsBeforeModeRerender = await page.locator('#recipe-editor-tags input').count();
  await page.locator('[data-recipe-editor-action="tag-add"]').click();
  assert.equal(await ingredient.locator('select[data-field="quantity_mode"]').inputValue(), 'text', 'an empty free-quantity mode survives an unrelated row render');
  assert.equal(await ingredient.locator('[data-field="quantity_text"]').inputValue(), '');
  assert.equal(await ingredient.locator('[data-field="quantity_text"]').isVisible(), true);
  assert.equal(await ingredient.locator('[data-field="quantity_value"]').isDisabled(), true);
  assert.equal(await openIngredientEditors().count(), 1);
  await page.locator('[data-recipe-editor-action="tag-remove"]').last().click();
  assert.equal(await page.locator('#recipe-editor-tags input').count(), tagsBeforeModeRerender);
  assert.equal(await ingredient.locator('select[data-field="quantity_mode"]').inputValue(), 'text', 'cleaning up the temporary tag also preserves the selected quantity mode');
  await ingredient.locator('[data-field="name"]').fill('Wasser'); await ingredient.locator('[data-field="quantity_text"]').fill('nach Bedarf');
  await ingredient.locator('[data-recipe-editor-action="ingredient-up"]').click();
  assert.deepEqual(await group.locator('[data-field="name"]').evaluateAll(nodes => nodes.map(node => node.value)), ['Wasser', 'Mehl']);
  ingredient = group.locator('.recipe-editor-ingredient').first();
  await ingredient.locator('[data-recipe-editor-action="ingredient-down"]').click();
  ingredient = group.locator('.recipe-editor-ingredient').nth(1);
  await ingredient.locator('[data-recipe-editor-action="ingredient-done"]').click();
  assert.equal(await openIngredientEditors().count(), 0);
  assert.match(await ingredientSummary(ingredient), /nach Bedarf.*Wasser/);
  await page.locator('[data-recipe-editor-action="group-add"]').click();
  await page.locator('.recipe-editor-group').nth(1).locator('[data-field="group-name"]').fill('Belag');
  await page.locator('.recipe-editor-group').nth(1).locator('[data-recipe-editor-action="group-up"]').click();
  assert.deepEqual(await page.locator('.recipe-editor-group [data-field="group-name"]').evaluateAll(nodes => nodes.map(node => node.value)), ['Belag','Teig']);
  assert.equal(await page.locator(`.recipe-editor-group[data-key="${groupKey}"] [data-field="name"]`).first().inputValue(), 'Mehl');
  await page.locator('[data-recipe-editor-action="step-add"]').click();
  await page.locator('.recipe-editor-step textarea').first().fill('Erste Zeile.\nZweite Zeile.\n\nDritter Absatz.');
  await page.locator('[data-recipe-editor-action="step-add"]').click(); await page.locator('.recipe-editor-step textarea').nth(1).fill('Finish');
  await page.locator('.recipe-editor-step').nth(1).locator('[data-recipe-editor-action="step-up"]').click();
  const flourRow = modal.locator(`.recipe-editor-group[data-key="${groupKey}"] .recipe-editor-ingredient`).first();
  await flourRow.locator('[data-recipe-editor-action="ingredient-edit"]').click();
  for (const kind of ['group', 'ingredient', 'step']) {
    const scope = kind === 'ingredient' ? openIngredientEditors() : page;
    await assertControlIcon(scope.locator(`[data-recipe-editor-action="${kind}-up"]`).first(), 'chevron-up');
    await assertControlIcon(scope.locator(`[data-recipe-editor-action="${kind}-down"]`).first(), 'chevron-down');
    await assertControlIcon(scope.locator(`[data-recipe-editor-action="${kind}-remove"]`).first(), 'trash-2');
  }
  await flourRow.locator('[data-recipe-editor-action="ingredient-done"]').click();
  await page.locator('[data-recipe-editor-action="tag-add"]').click(); await page.locator('#recipe-editor-tags input').first().fill('Familie');
  await page.locator('[data-recipe-editor-action="tag-add"]').click(); await page.locator('#recipe-editor-tags input').nth(1).fill('Saisonal');
  await assertControlIcon(modal.locator('[data-recipe-editor-action="tag-remove"]').first(), 'trash-2');
  await assertControlIcon(modal.locator('.modal-close-x'), 'x');
  await page.locator('.recipe-editor-step textarea').nth(1).evaluate(node => { window.recipeTextareaBeforeLanguage = node; node.focus(); node.setSelectionRange(2, 6); });
  await page.locator(`.recipe-editor-group[data-key="${groupKey}"] [data-field="name"]`).first().evaluate(node => { window.recipeIngredientBeforeLanguage = node; });
  await page.evaluate(async () => { const { setLanguagePreference } = await import('/static/js/i18n/index.js'); await setLanguagePreference('en'); });
  assert.equal(await page.locator('label[for="recipe-base-servings"]').textContent(), 'Base servings');
  assert.equal((await modal.locator('[data-recipe-editor-action="ingredient-done"]').first().textContent()).trim(), 'Apply');
  assert.equal(await page.locator('.recipe-editor-step [data-recipe-step-label]').nth(1).textContent(), 'Step 2');
  assert.equal(await page.locator('.recipe-editor-step textarea').nth(1).evaluate(node => node === window.recipeTextareaBeforeLanguage && document.activeElement === node && node.selectionStart === 2 && node.selectionEnd === 6), true, 'language changes preserve textarea node, draft, focus and selection');
  assert.equal(await page.locator(`.recipe-editor-group[data-key="${groupKey}"] [data-field="name"]`).first().evaluate(node => node === window.recipeIngredientBeforeLanguage && node.value === 'Mehl'), true);
  await page.evaluate(async () => { const { setLanguagePreference } = await import('/static/js/i18n/index.js'); await setLanguagePreference('de'); });
  const imageChooser = page.waitForEvent('filechooser');
  await page.locator('#recipe-image-trigger').focus();
  await page.locator('#recipe-image-trigger').press('Enter');
  await (await imageChooser).setFiles({ name: 'cover.png', mimeType: 'image/png', buffer: Buffer.from('mock image preparation input') });
  await page.waitForFunction(() => Boolean(window.recipeTest.editor.getDraft().image_data));
  await page.locator('#recipe-image-preview').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#recipe-image-remove').isHidden(), true, 'image actions stay hidden until the preview is activated');
  await page.locator('#recipe-image-trigger').hover();
  await waitForPageCondition(page, () => getComputedStyle(document.querySelector('.ui-image-picker-overlay')).opacity === '1');
  await page.locator('#recipe-image-trigger').press('Enter');
  assert.equal(await page.locator('#recipe-image-remove').isVisible(), true, 'activating the preview exposes its actions');
  await page.locator('#recipe-image-choose').press('Escape');
  assert.equal(await page.locator('#recipe-image-remove').isHidden(), true, 'Escape dismisses only the image menu');
  assert.equal(await modal.getAttribute('aria-hidden'), 'false');
  assert.equal(await page.locator('#recipe-image-trigger').evaluate(node => node === document.activeElement), true, 'Escape restores image-trigger focus');
  await page.locator('#recipe-image-trigger').click();
  await page.locator('#recipe-name').click();
  assert.equal(await page.locator('#recipe-image-remove').isHidden(), true, 'outside clicks dismiss the image menu');
  const imageBeforeCancel = await page.evaluate(() => window.recipeTest.editor.getDraft().image_data);
  await page.locator('#recipe-image-trigger').click();
  const replacementChooser = page.waitForEvent('filechooser');
  await page.locator('#recipe-image-choose').click();
  await (await replacementChooser).setFiles([]);
  assert.equal(await page.evaluate(() => window.recipeTest.editor.getDraft().image_data), imageBeforeCancel, 'canceling replacement preserves the existing image');
  assert.equal(await page.locator('#recipe-image-remove').isHidden(), true);
  assert.equal(await page.locator('#recipe-image-file').getAttribute('tabindex'), '-1', 'the preview owns keyboard entry to the native picker');
  assert.equal(await page.locator('.recipe-editor-step textarea').first().evaluate(node => node.labels?.length), 1, 'step labels remain associated after moving row actions');
  await flourRow.locator('[data-recipe-editor-action="ingredient-edit"]').click();
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
    for (const width of [1280, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await modal.evaluate(node => {
        const content = node.querySelector('.modal-content'), preview = node.querySelector('#recipe-image-preview').getBoundingClientRect();
        return { overflow: content.scrollWidth > content.clientWidth,
          borders: Array.from(node.querySelectorAll('#recipe-form>.ui-detail-section'), section => [getComputedStyle(section).borderLeftWidth, getComputedStyle(section).borderRightWidth]),
          imageWidth: preview.width, imageHeight: preview.height, modalWidth: content.getBoundingClientRect().width,
          imageLeft: preview.left, imageTop: preview.top,
          titleRight: node.querySelector('#recipe-name').getBoundingClientRect().right,
          titleTop: node.querySelector('#recipe-name').getBoundingClientRect().top,
          descriptionTop: node.querySelector('#recipe-description').getBoundingClientRect().top };
      });
      assert.equal(layout.overflow, false, `editor fits ${theme} at ${width}px: ${JSON.stringify(layout)}`);
      // Shared buttons animate their size when the viewport crosses a breakpoint.
      if (width <= 768) await waitForPageCondition(page, () => Array.from(document.querySelectorAll('.recipe-editor-ingredient-editor:not([hidden]) button:not(:disabled)')).filter(button => button.getBoundingClientRect().width > 0).every(button => button.getBoundingClientRect().height >= 44));
      const ingredientLayout = await openIngredientEditors().evaluate(node => ({
        overflow: node.scrollWidth > node.clientWidth,
        actions: Array.from(node.querySelectorAll('button:not(:disabled)')).filter(button => button.getBoundingClientRect().width > 0).map(button => ({ label: button.textContent || button.getAttribute('aria-label'), classes: button.className, width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
      }));
      assert.equal(ingredientLayout.overflow, false, `open ingredient fits ${theme} at ${width}px`);
      if (width <= 768) assert.ok(ingredientLayout.actions.every(button => button.height >= 44), `open ingredient actions keep mobile touch targets: ${JSON.stringify(ingredientLayout)}`);
      await waitForPageCondition(page, minimum => Array.from(document.querySelectorAll('#recipe-form .btn-icon'))
        .filter(button => button.getClientRects().length > 0)
        .every(button => { const box = button.getBoundingClientRect(); return box.width >= minimum && box.height >= minimum && Math.abs(box.width - box.height) < .5; }), width <= 768 ? 44 : 36);
      const iconButtons = await modal.locator('#recipe-form .btn-icon').evaluateAll(buttons => buttons
        .filter(button => button.getClientRects().length > 0)
        .map(button => ({ action: button.dataset.recipeEditorAction, width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })));
      assert.ok(iconButtons.some(button => button.action === 'tag-remove'), 'icon geometry includes tag deletion as well as reorder actions');
      assert.ok(iconButtons.some(button => button.action === 'ingredient-remove'));
      assert.ok(iconButtons.every(button => Math.abs(button.width - button.height) < .5 && button.width >= (width <= 768 ? 44 : 36)), `all content icon buttons stay circular at ${width}px: ${JSON.stringify(iconButtons)}`);
      assert.ok(layout.borders.every(sides => sides.every(side => side === '0px')), 'editor sections use shared dividers without enclosing card borders');
      assert.ok(layout.imageWidth <= 112 && layout.imageHeight <= 84, 'editor image stays a compact title control');
      assert.ok(layout.imageLeft > layout.titleRight && layout.imageTop < layout.descriptionTop, 'preview sits beside the title above the description');
      if (width > 1180) assert.ok(layout.modalWidth <= 960, 'desktop editor respects its content width');
      if (process.env.NIA_TODO_TEST_OUTPUT_DIR) {
        await page.locator('#recipe-name').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${process.env.NIA_TODO_TEST_OUTPUT_DIR}/recipes-editor-${theme}-${width}.png`, fullPage: true, animations: 'disabled' });
        await openIngredientEditors().scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${process.env.NIA_TODO_TEST_OUTPUT_DIR}/recipes-ingredient-${theme}-${width}.png`, fullPage: true, animations: 'disabled' });
      }
    }
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.click('#recipe-save-btn'); await closed();
  const created = await waitForPageCondition(page, () => window.recipeTest.books().flatMap(book => book.recipes || []).find(recipe => recipe.title === 'Structured recipe'));
  const queue = await page.evaluate(() => window.recipeTest.queue());
  assert.equal(queue[0].action, 'CREATE_RECIPE'); assert.equal(queue[0].data.cookbook_id, 2);
  assert.deepEqual(queue[0].data.tags, ['Familie','Saisonal']); assert.equal(queue[0].data.steps.length, 2);
  assert.equal(queue[0].data.steps[1].text, 'Erste Zeile.\nZweite Zeile.\n\nDritter Absatz.', 'multiline text remains one ordered step');
  assert.equal(queue[0].data.ingredient_groups[1].ingredients[1].quantity_text, 'nach Bedarf');
  assert.equal(queue[0].data.ingredient_groups[1].ingredients[0].note, 'fein gemahlen', 'ingredient notes survive Apply, closing and row reordering');
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
  assert.equal(await page.locator('#recipe-image-trigger').getAttribute('aria-disabled'), 'true', 'conflicts disable the image control along with the content fields');
  await page.locator('#recipe-editor-conflict [data-recipe-action="keep-local"]').click();
  await page.click('#confirm-confirm-btn');
  await waitForPageCondition(page, () => !window.recipeTest.controller.getRecipe(101).conflict);
  assert.equal(await page.locator('#recipe-name').inputValue(), 'Additional unsaved draft');
  assert.equal(await page.locator('#recipe-image-trigger').getAttribute('aria-disabled'), 'false', 'resolving a conflict re-enables the same image control');
  assert.equal(await page.locator('#recipe-image-file').isDisabled(), false);
  assert.equal(await unsavedStep.inputValue(), 'A later unsaved step.\nIts own second line.', 'keep-local retains newer unsaved structured fields');
  assert.equal(await page.evaluate(() => window.recipeTest.controller.getRecipe(101).title), 'Local retained', 'resolution only commits the saved queue intent');
  await page.locator('#recipe-save-btn').waitFor({ state: 'visible' });
  await page.click('#recipe-save-btn'); await closed();
  assert.equal(await page.locator('.recipe-reading h1').textContent(), 'Additional unsaved draft');

  await page.locator('[data-recipe-action="edit"]').click();
  await page.locator('#recipe-image-trigger').click();
  await page.locator('#recipe-image-remove').click();
  assert.equal(await page.evaluate(() => window.recipeTest.editor.getDraft().image_data), null, 'explicit image removal differs from preserving the current image');
  assert.equal(await page.locator('#recipe-image-remove').isHidden(), true, 'removing an image hides its removal action');
  await close();
  const beforePendingRemoval = await page.evaluate(() => window.recipeTest.books());
  await page.evaluate(books => window.recipeTest.set(books.map(book => ({ ...book, recipes: book.recipes.map(recipe => recipe.id === 101 ? { ...recipe, image_data: null } : recipe) }))), beforePendingRemoval);
  assert.ok(await page.evaluate(() => window.recipeTest.controller.getRecipe(101).image_url), 'pending removal still retains the previous server image URL');
  await page.locator('[data-recipe-action="edit"]').click();
  assert.equal(await page.locator('#recipe-image-picker').getAttribute('data-has-image'), 'false', 'pending null image data takes precedence over the old server URL');
  const pendingRemovalChooser = page.waitForEvent('filechooser');
  await page.locator('#recipe-image-trigger').press('Enter');
  await (await pendingRemovalChooser).setFiles([]);
  await close();
  await page.evaluate(books => window.recipeTest.set(books), beforePendingRemoval);
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
  await modal.locator('[data-recipe-editor-action="ingredient-edit"]').first().click();
  assert.equal(await openIngredientEditors().count(), 1, 'the Escape regression includes an expanded ingredient editor');
  assert.equal(await modal.locator('details[data-ui-editor-menu][open]').count(), 0, 'ingredient content is never registered as a popover menu');
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

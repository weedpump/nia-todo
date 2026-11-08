#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { waitForPageCondition } from './browser_page_condition.mjs';

// Private browser origin, real view/navigation/history and no service or DB.
const fixture = `
import { initI18n,setLanguagePreference } from '/static/js/i18n/index.js';
import { createRecipeViewFeature } from '/static/js/features/recipe-view.js';
import { createCookbookNavigationFeature } from '/static/js/features/cookbook-navigation.js';
localStorage.setItem('nia-todo-language','de');await initI18n();
let actor=1,session='1:one',books=[],transfers=[];
const recipe={id:10,cookbook_id:1,title:'Kochrezept <script>unsafe</script>',description:'Long description must stay in reading only',base_servings:2,revision:1,can_edit:false,tags:[],ingredient_groups:[{client_key:'group',name:'',ingredients:[
 {client_key:'water',name:'Wasser <img src=x>',quantity_value:50,quantity_unit:'ml'},
 {client_key:'pasta',name:'Pasta',quantity_value:100,quantity_unit:'g'},
 {client_key:'salt',name:'Salz',quantity_value:2,quantity_unit:'g'},
 {client_key:'herbs',name:'Kräuter',quantity_value:null,quantity_text:'nach Bedarf'}]}],steps:[
 {client_key:'heat',text:'Wasser erhitzen\\nLangsam aufkochen.',ingredients:[{ingredient_client_key:'water',show_quantity:true},{ingredient_client_key:'pasta',show_quantity:true},{ingredient_client_key:'salt',show_quantity:false}]},
 {client_key:'mix',text:'Pasta mischen\\nMehrere Zeilen\\nbleiben erhalten.',ingredients:[{ingredient_client_key:'pasta',show_quantity:true},{ingredient_client_key:'herbs',show_quantity:true}]},
 {client_key:'finish',text:'Servieren'}]};
const original=()=>[{id:1,name:'Nur lesen',can_edit:false,recipes:[structuredClone(recipe)]},{id:2,name:'Andere Sammlung',can_edit:false,recipes:[{...structuredClone(recipe),id:20,cookbook_id:2}]}];
if(!history.state?.niaRecipeRoute)history.replaceState({niaModuleRoute:true,moduleId:'recipes',niaCookbookRoute:true,cookbookId:1,niaRecipeRoute:true,recipeId:10},'', '/');
const nav=createCookbookNavigationFeature({getCookbooks:()=>books,setCookbooks:next=>{books=next;},getActorId:()=>actor,cookbookApi:{listInvites:async()=>[]}});
const view=createRecipeViewFeature({getCookbooks:()=>books,getActiveCookbookId:()=>nav.getActiveCookbookId(),getActorId:()=>actor,getSessionIdentity:()=>session,
 onTransfer:(recipe,options)=>transfers.push({id:recipe.id,...options})});
nav.setRecipeView(view);nav.activate();view.bind();nav.replaceCookbooks(original());
window.test={view,nav,transfers,books:()=>structuredClone(books),publish:next=>nav.replaceCookbooks(next),original,
 language:async value=>{await setLanguagePreference(value);},actor:()=>{actor=2;session='2:two';view.render();}};
`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('http://recipe-cooking.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/style.css"></head><body><main class="main"><div id="cookbook-navigation-main"></div></main><div id="dialogs"></div><script type="module" src="/fixture.js"></script></body></html>` });
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: fixture });
    if (path.startsWith('/static/')) {
      try { return route.fulfill({ contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.json') ? 'application/json' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream', body: readFileSync(new URL(`../web${path}`, import.meta.url)) }); }
      catch { return route.fulfill({ status: 404 }); }
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('http://recipe-cooking.test/');
  await page.waitForFunction(() => Boolean(window.test));
  const action = name => page.locator(`[data-recipe-action="${name}"]`);
  const step = () => page.locator('.recipe-cooking-step');
  const readStep = key => page.locator(`.recipe-steps>li[data-recipe-step-key="${key}"]`);
  const amount = () => page.locator('[data-step-ingredient-amount="water"]');
  const mode = () => page.locator('.recipe-view-mode');
  assert.deepEqual(await mode().locator('button').allTextContents(), ['Lesemodus', 'Kochmodus']);
  assert.equal(await action('exit-cooking').getAttribute('aria-pressed'), 'true', 'reading is the default mode');
  assert.equal(await action('cook').getAttribute('aria-pressed'), 'false');
  await action('exit-cooking').click();
  assert.equal(await page.locator('.recipe-reading').count(), 1, 'selected reading mode stays in the recipe');
  assert.equal(await mode().evaluate(node => node.getBoundingClientRect().height), await action('transfer').evaluate(node => node.getBoundingClientRect().height), 'desktop mode switch matches action button height');
  assert.equal(await readStep('heat').locator('.recipe-step-ingredient').count(), 3);
  assert.equal(await readStep('heat').locator('.recipe-step-ingredient-partial').count(), 2, 'repeated and explicitly partial ingredients do not claim a whole amount');
  assert.equal(await readStep('finish').locator('.recipe-step-ingredients').count(), 0, 'legacy steps have no empty chip section');
  assert.equal(await readStep('heat').locator('img,script').count(), 0, 'ingredient text stays escaped');
  assert.equal(await amount().textContent(), '50 ml');
  await page.fill('#recipe-view-servings', '4');
  assert.equal(await amount().textContent(), '100 ml', 'reading step chips follow shared portions');
  assert.equal(await readStep('mix').locator('[data-step-ingredient-amount="herbs"]').textContent(), 'nach Bedarf');
  assert.equal(await action('edit').count(), 0, 'source edit permission is unnecessary for cooking');
  await action('cook').focus(); await action('cook').press('Enter');
  assert.equal(await action('cook').getAttribute('aria-pressed'), 'true');
  assert.equal(await action('exit-cooking').getAttribute('aria-pressed'), 'false');
  assert.equal(await step().getAttribute('data-recipe-step-key'), 'heat');
  assert.equal(await action('previous-step').isDisabled(), true);
  assert.equal(await page.locator('.recipe-cooking .recipe-description,.recipe-cooking img').count(), 0);
  assert.equal(await page.locator('#recipe-view-servings').inputValue(), '4');
  const historyLength = await page.evaluate(() => history.length);
  await action('next-step').click();
  assert.equal(await step().getAttribute('data-recipe-step-key'), 'mix');
  assert.match(await step().locator('p').textContent(), /Mehrere Zeilen\nbleiben erhalten/);
  await action('next-step').focus(); await action('next-step').press('Enter');
  assert.equal(await step().getAttribute('data-recipe-step-key'), 'finish');
  assert.equal(await action('next-step').isDisabled(), true);
  assert.equal(await step().locator('.recipe-step-ingredients').count(), 0);
  assert.equal(await page.evaluate(() => history.length), historyLength, 'step changes replace history rather than adding entries');
  await action('previous-step').click();
  await page.reload();await page.waitForFunction(() => Boolean(window.test));
  assert.equal(await step().getAttribute('data-recipe-step-key'), 'mix', 'same actor reload restores the stable cooking step');
  assert.equal(await page.locator('#recipe-view-servings').inputValue(), '4', 'reload retains validated cooking portions');
  await page.evaluate(() => { const books=window.test.books();books[0].recipes[0].steps=[books[0].recipes[0].steps[2],books[0].recipes[0].steps[0],books[0].recipes[0].steps[1]];window.test.publish(books); });
  assert.equal(await step().getAttribute('data-recipe-step-key'), 'mix', 'authoritative reorder retains stable current step');
  assert.match(await page.locator('.recipe-cooking-progress').textContent(), /3.*3/);
  await page.evaluate(() => { const books=window.test.books();books[0].recipes[0].steps=books[0].recipes[0].steps.filter(step=>step.client_key!=='mix');window.test.publish(books); });
  assert.equal(await step().getAttribute('data-recipe-step-key'), 'heat', 'removed step clamps to remaining index');
  await action('transfer').click();
  assert.deepEqual(await page.evaluate(() => window.test.transfers), [{ id: 10, servings: 4 }]);
  await page.evaluate(() => { const dialog=document.createElement('div');dialog.id='held-editor';dialog.className='modal active';dialog.setAttribute('role','dialog');dialog.innerHTML='<input id="held-input">';document.body.append(dialog);document.getElementById('held-input').focus(); });
  await page.locator('#held-input').press('ArrowRight'); await page.locator('#held-input').press('Escape');
  assert.equal(await step().getAttribute('data-recipe-step-key'), 'heat', 'typing/modal keys never navigate or close cooking');
  await page.evaluate(() => document.getElementById('held-editor').remove());
  await page.evaluate(() => window.test.language('en'));
  assert.equal(await action('exit-cooking').textContent(), 'Reading mode');
  assert.equal(await step().getAttribute('data-recipe-step-key'), 'heat');
  for (const width of [320,390,1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal body overflow at ${width}px`);
    await waitForPageCondition(page, () => document.querySelector('.recipe-view-mode').getBoundingClientRect().height === document.querySelector('[data-recipe-action="transfer"]').getBoundingClientRect().height);
    assert.equal(await mode().evaluate(node => node.getBoundingClientRect().height), await action('transfer').evaluate(node => node.getBoundingClientRect().height), `mode switch and actions have consistent responsive heights at ${width}px`);
    if (width <= 768) assert.equal(await action('cook').evaluate(node => node.getBoundingClientRect().height >= 44), true, 'mode toggle is touch-sized');
    assert.equal(await action('next-step').evaluate(node => node.getBoundingClientRect().height >= 44), true, 'cooking controls have touch targets');
  }
  await page.goBack();
  await page.locator('.recipe-reading').waitFor();
  assert.equal(await page.locator('#recipe-view-servings').inputValue(), '4', 'Back exits cooking before leaving the recipe');
  await action('cook').click(); await action('exit-cooking').focus(); await action('exit-cooking').press('Enter');
  await waitForPageCondition(page, () => !history.state.recipeCooking && Boolean(document.querySelector('.recipe-reading')));
  assert.equal(await action('exit-cooking').evaluate(node => node === document.activeElement), true, 'selected reading option retains keyboard focus after history navigation');
  await action('exit-cooking').press('Enter');
  assert.equal(await page.locator('.recipe-reading').count(), 1, 'Enter on selected reading mode does not reopen cooking');
  await action('cook').click();
  await page.evaluate(() => {window.test.view.deactivate();window.test.view.activate();window.test.nav.render();});
  assert.equal(await page.locator('.recipe-cooking').count(), 0, 'module deactivation resets cooking');
  await action('cook').click();await page.goBack();await page.locator('.recipe-reading').waitFor();
  assert.equal(await page.locator('.recipe-cooking').count(), 0, 'reentering after deactivation still has a reading Back entry');
  await action('cook').click(); await page.evaluate(() => window.test.actor());
  assert.equal(await page.locator('.recipe-cooking').count(), 0, 'session boundary resets cooking');
  await page.evaluate(() => {window.test.nav.selectCookbook(2);window.test.view.selectRecipe(20);});
  await action('cook').click();
  await page.evaluate(() => window.test.publish(window.test.books().filter(book=>book.id!==2)));
  assert.equal(await page.locator('.recipe-cooking').count(), 0, 'source revocation clears cooking');
  assert.equal(await page.locator('.recipe-page').textContent().then(text => text.includes('Andere Sammlung')), false);
  await page.evaluate(() => {const books=window.test.original();books[0].recipes[0].steps=[];window.test.publish(books);window.test.nav.selectCookbook(1);window.test.view.selectRecipe(10);});
  assert.equal(await action('cook').count(), 0, 'recipes without steps have no cooking action');
  assert.deepEqual(errors, []);
  console.log('PASS recipe step ingredients, portions, cooking, history, stable keys, access and mobile controls');
} finally { await browser.close(); }

#!/usr/bin/env node
// Actual app/API/parser/editor/PWA; only external webpage/image transport mocked.
import assert from 'node:assert/strict';
import { startPrivateApp } from './private_app_test_server.mjs';
import { waitForPageCondition } from './browser_page_condition.mjs';

const sourceUrl = 'https://public.example/recipe';
const sourceAuthor = 'Zoë Müller';
const title = 'Crêpes für die Familie';
const html = '<!doctype html><html><head><meta property="og:site_name" content="Public Recipe Kitchen"><script type="application/ld+json">' + JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Recipe', name: title, description: 'Ein Rezept für vier Personen.',
  author: { '@type': 'Person', name: sourceAuthor }, recipeYield: '4 Portionen', prepTime: 'PT10M', cookTime: 'PT15M',
  image: 'https://public.example/recipe.png', recipeIngredient: ['250 g Mehl', '0,5 l Milch', '2 Eier'],
  recipeInstructions: [{ '@type': 'HowToStep', text: 'Mehl, Milch und Eier verrühren.' }, { '@type': 'HowToStep', text: 'In der Pfanne ausbacken.' }],
}) + '</script></head><body><h1>Rezept</h1></body></html>';
const pythonPreamble = `
import io
from PIL import Image
from services import recipe_import
from services.public_fetch import PublicResponse
_image_output = io.BytesIO()
Image.new('RGB', (320, 200), '#ffd15c').save(_image_output, format='PNG')
def _fixture_fetch(url, **kwargs):
    if url == ${JSON.stringify(sourceUrl)}:
        return PublicResponse(url, ${JSON.stringify(html)}.encode('utf-8'), 'text/html', 'utf-8')
    if url == 'https://public.example/recipe.png' and kwargs.get('image'):
        return PublicResponse(url, _image_output.getvalue(), 'image/png')
    raise AssertionError('Unexpected external request in private recipe import fixture')
recipe_import.fetch_public = _fixture_fetch
`;

let app, client, phase = 'starting private app';
try {
  app = await startPrivateApp({ name: 'recipe-import', pythonPreamble });
  process.env.NIA_TODO_URL = app.base;
  process.env.NIA_TODO_DEV_DIR = app.root;
  process.env.NIA_TODO_DATA_DIR = app.privateDir;
  process.env.NIA_TODO_DB_NAME = 'e2e.db';
  process.env.NIA_TODO_TEST_ISOLATED_NETWORK = '1';
  const { launchPage, USERNAME, USER_PASSWORD, ADMIN_PASSWORD, BASE_URL } = await import('./frontend_test_lib.mjs');
  assert.equal(BASE_URL, app.base, 'Browser helpers must address only this disposable child');
  async function setup(path, data) {
    const response = await fetch(`${app.base}${path}`, { method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', 'X-Setup-Token': app.setupToken }, body: JSON.stringify(data) });
    assert.equal(response.status, 200, `Private setup failed: ${path}`);
  }
  phase = 'private setup and authentication';
  await setup('/api/setup/admin', { admin_password: ADMIN_PASSWORD });
  await setup('/api/setup/first-user', { username: USERNAME, password: USER_PASSWORD, email: 'recipe-import@example.invalid', display_name: 'Recipe import E2E' });
  const anonymous = await fetch(`${app.base}/api/recipes/import-preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: sourceUrl }) });
  assert([401, 403].includes(anonymous.status), 'an unauthenticated request cannot analyze a page');
  client = await launchPage({ serviceWorkers: 'allow' });
  const { page } = client;
  const previews = [], browserRequests = [];
  page.context().on('request', request => {
    browserRequests.push(new URL(request.url()).origin);
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/recipes/import-preview') {
      previews.push({ body: request.postDataJSON(), csrf: Boolean(request.headers()['x-csrf-token']) });
    }
  });
  await page.context().route('**/*', route => new URL(route.request().url()).origin === app.base ? route.continue() : route.abort('blockedbyclient'));
  await client.loginApp();
  const withoutCsrf = await page.evaluate(async () => (await import('/static/js/api/http.js')).getAuthHeaders());
  delete withoutCsrf['X-CSRF-Token'];
  assert.equal((await fetch(`${app.base}/api/me`, { headers: withoutCsrf })).status, 200, 'the test request is otherwise authenticated');
  assert.equal((await fetch(`${app.base}/api/recipes/import-preview`, { method: 'POST', headers: withoutCsrf, body: JSON.stringify({ url: sourceUrl }) })).status,
    403, 'authenticated import still requires the shared CSRF token');
  const poll = (predicate, arg) => waitForPageCondition(page, predicate, arg, { timeout: 30000 });
  const queueEmpty = () => poll(async () => typeof window.dbGetAll === 'function' && !(await window.dbGetAll('syncQueue')).length);
  const book = await page.evaluate(async () => (await import('/static/js/api/recipes.js')).recipesApi.createCookbook({ name: 'Imported family recipes', client_mutation_id: 'import-e2e-book' }));
  await poll(async id => typeof window.dbGetAll === 'function' && (await window.dbGetAll('cookbooks')).some(book => book.id === id), book.id);
  await page.click('#module-switcher-button');
  await page.click('[data-module-action="select"][data-module-id="recipes"]');
  await page.locator(`#cookbook-sidebar [data-entity-sidebar-action="select"][data-entity-id="${book.id}"]`).click();
  const serverRecipes = () => page.evaluate(async id => (await (await import('/static/js/api/recipes.js')).recipesApi.getCookbook(id)).recipes, book.id);
  phase = 'actual URL import and unsaved preview';
  async function importThroughUi(includeImage) {
    await page.locator('[data-recipe-action="import"]').click();
    await page.fill('#recipe-import-url', sourceUrl);
    await page.locator('#recipe-import-include-image').setChecked(includeImage);
    await page.locator('#recipe-import-save-btn').click();
    await page.locator('#recipe-modal.active').waitFor({ timeout: 30000 });
  }
  await importThroughUi(true);
  assert.equal((await serverRecipes()).length, 0, 'an import preview must not persist a recipe');
  assert.equal(await page.locator('#recipe-id').inputValue(), '');
  assert.equal(await page.locator('#recipe-name').inputValue(), title);
  assert.equal(await page.locator('#recipe-base-servings').inputValue(), '4');
  assert.equal(await page.locator('#recipe-source-author').inputValue(), sourceAuthor);
  assert.equal(await page.locator('#recipe-source-url').inputValue(), sourceUrl);
  assert.equal(await page.locator('#recipe-source-yield').inputValue(), '4 Portionen');
  const draft = await page.evaluate(() => document.querySelector('#recipe-image-preview-img').getAttribute('src'));
  assert.match(draft, /^data:image\/webp;base64,/, 'downloaded image is normalized before it reaches the browser');
  assert.equal(await page.locator('.recipe-editor-ingredient').count(), 3);
  assert.equal(await page.locator('.recipe-editor-step').count(), 2);
  assert.equal(await page.locator('#recipe-save-btn').isVisible(), true);
  await page.locator('#recipe-save-btn').click();
  await page.locator('#recipe-modal').waitFor({ state: 'hidden' }); await queueEmpty();
  let stored = (await serverRecipes())[0];
  assert.equal(stored.source_url, sourceUrl); assert.equal(stored.source_author, sourceAuthor);
  assert.equal(stored.source_yield, '4 Portionen'); assert.equal(stored.base_servings, 4);
  assert.equal(stored.ingredient_groups.flatMap(group => group.ingredients).find(item => item.name === 'Milch').quantity_unit, 'l');
  assert.match(stored.image_url, /^\/api\/recipes\/recipes\/\d+\/image/);
  const authenticatedImage = await page.evaluate(async url => {
    const headers = (await import('/static/js/api/http.js')).getAuthHeaders();
    const response = await fetch(url, { headers });
    return { status: response.status, type: response.headers.get('content-type'), length: (await response.arrayBuffer()).byteLength };
  }, stored.image_url);
  assert.equal(authenticatedImage.status, 200); assert.equal(authenticatedImage.type, 'image/webp'); assert(authenticatedImage.length > 0);
  assert.equal((await fetch(`${app.base}${stored.image_url}`)).status, 401, 'imported title images remain private');
  phase = 'source metadata and image survive real app reload';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.recipe-reading').waitFor();
  assert.equal(await page.locator('.recipe-source a').getAttribute('href'), sourceUrl);
  assert((await page.locator('.recipe-source').textContent()).includes(sourceAuthor));
  await poll(() => document.querySelector('.recipe-title-image img')?.naturalWidth > 0);
  await client.dismissWhatsNewIfVisible();
  await page.locator('[data-recipe-action="overview"]').click();
  phase = 'mobile preview saved offline and durable PWA reload';
  await page.setViewportSize({ width: 390, height: 844 });
  await importThroughUi(false);
  assert.equal(await page.locator('#recipe-image-preview').isVisible(), false, 'unchecked optional image does not enter the draft');
  await page.fill('#recipe-name', 'Offline imported crêpes');
  await poll(() => navigator.serviceWorker?.controller?.state === 'activated');
  await page.context().setOffline(true); await poll(() => navigator.onLine === false);
  await page.locator('#recipe-save-btn').click();
  await page.locator('#recipe-modal').waitFor({ state: 'hidden' });
  const pending = await poll(async () => (await window.dbGetAll('syncQueue')).find(entry => entry.action === 'CREATE_RECIPE'));
  assert.equal(pending.data.source_url, sourceUrl); assert.equal(pending.data.source_author, sourceAuthor);
  assert(!pending.data.image_data, 'optional-image choice survives the durable intent');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#login-overlay').waitFor({ state: 'hidden' });
  await poll(async mutation => typeof window.dbGetAll === 'function' && (await window.dbGetAll('syncQueue')).some(entry => entry.action === 'CREATE_RECIPE' && entry.data.client_mutation_id === mutation), pending.data.client_mutation_id);
  assert.equal(await page.locator('.recipe-source a').getAttribute('href'), sourceUrl);
  phase = 'offline import reconnect and authoritative persistence';
  await page.context().setOffline(false); await queueEmpty();
  await poll(async id => (await window.dbGetAll('cookbooks')).find(book => book.id === id)?.recipes.some(recipe => recipe.title === 'Offline imported crêpes' && !String(recipe.id).startsWith('temp-')), book.id);
  const all = await serverRecipes(); assert.equal(all.length, 2, 'reconnect creates each imported recipe exactly once');
  const offlineRecipe = all.find(recipe => recipe.title === 'Offline imported crêpes');
  assert.equal(offlineRecipe.source_url, sourceUrl); assert.equal(offlineRecipe.source_author, sourceAuthor); assert.equal(offlineRecipe.image_url, null);
  assert.deepEqual(previews.map(request => request.body.include_image), [true, false]);
  assert(previews.every(request => request.csrf), 'actual import endpoint requests carry the shared CSRF header');
  assert(browserRequests.every(origin => origin === app.base), 'remote image/page URLs are never fetched by the client');
  assert.deepEqual(client.pageErrors, []);
  console.log('✅ Private real-app URL import/parser/auth/CSRF, unsaved editor, private image, source metadata, mobile offline reload and exactly-once reconnect passed');
} catch (error) {
  console.error(`Recipe import E2E failed during: ${phase}`); throw error;
} finally {
  try { await client?.browser.close(); } finally { await app?.stop(); }
}

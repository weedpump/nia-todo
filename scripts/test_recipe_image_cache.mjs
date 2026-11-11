#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { waitForPageCondition } from './browser_page_condition.mjs';

// Private origin, mocked image transport, real IndexedDB and commit locks.
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('http://recipe-image-cache.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><img id="first"><img id="second"><img id="late"><script type="module">
      import * as storage from '/static/js/storage/indexed-db.js';
      import { createRecipeImagesFeature, prepareRecipeImage } from '/static/js/features/recipe-images.js';
      import { acquireSyncCommitLock } from '/static/js/features/todo-pending.js';
      Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>true});
      localStorage.setItem('jwt_token','header.payload.signature'); await storage.openDatabase();
      let session='1:first'; let books=[{id:7,can_edit:true,recipes:[1,2].map(id=>({id,cookbook_id:7,title:'Image '+id,image_version:'a'.repeat(64),image_url:'/api/recipes/recipes/'+id+'/image?v='+'a'.repeat(64)}))}];
      const ref={value:false}; const canvas=document.createElement('canvas');canvas.width=400;canvas.height=200;
      canvas.getContext('2d').fillRect(0,0,400,200);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      const feature=createRecipeImagesFeature({getCookbooks:()=>books,getCurrentUser:()=>({id:Number(session?.split(':')[0])}),getSessionIdentity:()=>session,syncInProgressRef:ref});
      window.test={storage,ref,feature,blob,prepareRecipeImage,acquireSyncCommitLock,books:()=>books,setBooks:value=>{books=value;},setSession:value=>{session=value;},requests:[]};
      window.fetch=async(url,options)=>{window.test.requests.push({url,headers:options.headers});return new Response(blob,{headers:{'Content-Type':'image/png'}});};
    </script>` });
    try { return route.fulfill({ contentType: 'text/javascript', body: readFileSync(new URL(`../web${path}`, import.meta.url), 'utf8') }); }
    catch { return route.fulfill({ status: 404 }); }
  });
  await page.goto('http://recipe-image-cache.test/');
  await page.waitForFunction(() => Boolean(window.test));
  const populated = await page.evaluate(async () => {
    const t = window.test;
    const recipes = t.books()[0].recipes;
    const loaded = await Promise.all(recipes.map((recipe, index) => t.feature.load(document.getElementById(index ? 'second' : 'first'), recipe)));
    const source = document.getElementById('first').src;
    await t.feature.load(document.getElementById('first'), recipes[0]);
    const stableSource = source === document.getElementById('first').src;
    const rows = await t.storage.getAll('entityImages');
    const prepared = await t.prepareRecipeImage(new File([t.blob], 'photo.png', { type: 'image/png' }));
    return { loaded, stableSource, ids: rows.map(row => row.id), scope: rows.map(row => [row.user_id, row.cookbook_id, row.recipe_id]),
      prepared: prepared.slice(0, 30), preparedLength: prepared.length, auth: t.requests[0].headers.Authorization };
  });
  const preflight = await page.evaluate(async () => {
    const t = window.test;
    let decodeCalls = 0;
    const original = Image.prototype.decode;
    Image.prototype.decode = function (...args) { decodeCalls++; return original.apply(this, args); };
    const header = new Uint8Array(32); header.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(header.buffer); view.setUint32(8, 13); header.set([73, 72, 68, 82], 12);
    view.setUint32(16, 10000); view.setUint32(20, 10000);
    let code;
    try { await t.prepareRecipeImage(new File([header], 'oversized.png', { type: 'image/png' })); }
    catch (error) { code = error.code; }
    finally { Image.prototype.decode = original; }
    const { rasterImageDimensions } = await import('/static/js/core/raster-image.js');
    const canvas = document.createElement('canvas'); canvas.width = 27; canvas.height = 19;
    const formats = [];
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, type));
      formats.push(rasterImageDimensions(await blob.arrayBuffer()));
    }
    return { code, decodeCalls, formats };
  });
  assert.equal(preflight.code, 'recipe.image.tooLarge');
  assert.equal(preflight.decodeCalls, 0, 'oversized headers must be rejected before browser bitmap decoding');
  for (const dimensions of preflight.formats) assert.ok(dimensions.every(item => item.width === 27 && item.height === 19));
  assert.deepEqual(populated.loaded, [true, true]);
  assert.equal(populated.stableSource, true, 'unchanged rerenders reuse the existing decoded image URL');
  assert.equal(new Set(populated.ids).size, 2, 'two recipe images must not share the avatar or each other cache key');
  assert.deepEqual(populated.scope, [[1, 7, 1], [1, 7, 2]]);
  assert.match(populated.prepared, /^data:image\/(webp|png|jpeg);base64,/);
  assert.ok(populated.preparedLength < 430000);
  assert.equal(populated.auth, 'Bearer header.payload.signature');

  await page.reload(); await page.waitForFunction(() => Boolean(window.test));
  const offline = await page.evaluate(async () => {
    const t = window.test; window.fetch = async () => { throw new TypeError('offline'); };
    return t.feature.load(document.getElementById('first'), t.books()[0].recipes[0]);
  });
  assert.equal(offline, true, 'a cached private recipe image must survive a real reload without network');
  const localImage = await page.evaluate(async () => {
    const t = window.test; const recipe = t.books()[0].recipes[0];
    const prepared = await t.prepareRecipeImage(new File([t.blob], 'photo.png', { type: 'image/png' }));
    const pending = { ...recipe, image_data: prepared };
    t.setBooks([{ ...t.books()[0], recipes: [pending] }]);
    const ok = await t.feature.load(document.getElementById('first'), pending);
    const src = document.getElementById('first').src;
    const removed = { ...pending, image_data: null }; t.setBooks([{ ...t.books()[0], recipes: [removed] }]);
    const cleared = await t.feature.load(document.getElementById('first'), removed);
    return { ok, src, cleared };
  });
  assert.equal(localImage.ok, true); assert.match(localImage.src, /^data:image\//);
  assert.equal(localImage.cleared, false, 'an offline image removal must hide its old canonical image');

  await page.evaluate(async () => {
    const t = window.test;
    await t.storage.clear('entityImages');
    const old = { id: 4, cookbook_id: 7, image_version: 'c'.repeat(64), image_url: '/api/recipes/recipes/4/image?v=' + 'c'.repeat(64) };
    t.setBooks([{ id: 7, can_edit: true, recipes: [old] }]);
    t.oldFetchStarted = false;
    window.fetch = async () => { t.oldFetchStarted = true; return new Promise(resolve => { t.denyOld = () => resolve(new Response('', { status: 404 })); }); };
    t.oldLoading = t.feature.load(document.getElementById('second'), old);
  });
  await waitForPageCondition(page, () => window.test.oldFetchStarted);
  const lateDenial = await page.evaluate(async () => {
    const t = window.test;
    const newer = { ...t.books()[0].recipes[0], image_version: 'd'.repeat(64), image_url: '/api/recipes/recipes/4/image?v=' + 'd'.repeat(64) };
    t.setBooks([{ id: 7, can_edit: true, recipes: [newer] }]);
    window.fetch = async () => new Response(t.blob);
    const image = document.getElementById('second');
    const loaded = await t.feature.load(image, newer), source = image.src;
    t.denyOld(); const obsolete = await t.oldLoading;
    const rows = await t.storage.getAll('entityImages');
    return { loaded, obsolete, sameSource: image.src === source, versions: rows.map(row => row.version) };
  });
  assert.deepEqual(lateDenial, { loaded: true, obsolete: false, sameSource: true, versions: ['d'.repeat(64)] },
    'a stale image denial cannot evict or clear the newer loaded version');

  await page.evaluate(async () => {
    const t = window.test;
    await t.storage.clear('entityImages');
    const recipe = { id: 3, cookbook_id: 7, image_version: 'b'.repeat(64), image_url: '/api/recipes/recipes/3/image?v=' + 'b'.repeat(64) };
    t.setBooks([{ id: 7, can_edit: true, recipes: [recipe] }]);
    t.release = await t.acquireSyncCommitLock(t.ref);
    const gate = t.ref.commitGate;
    t.ref.commitGate = { then(resolve) { t.waiting = true; return gate.then(resolve); } };
    window.fetch = async () => new Response(t.blob);
    t.loading = t.feature.load(document.getElementById('late'), recipe);
  });
  await waitForPageCondition(page, () => window.test.waiting === true);
  const revoked = await page.evaluate(async () => {
    const t = window.test;
    await t.storage.evictPendingCookbookEntities([7]); t.setBooks([]);
    t.ref.privacyGeneration = 1; t.release();
    return { loaded: await t.loading, cache: (await t.storage.getAll('entityImages')).length, source: document.getElementById('late').getAttribute('src') };
  });
  assert.deepEqual(revoked, { loaded: false, cache: 0, source: null }, 'a cache write waiting behind revocation cannot resurrect private image bytes');
  assert.deepEqual(errors, []);
  console.log('✅ Recipe image keys, compression, offline reload, pending image edits and revocation cache-write race passed');
} finally { await browser.close(); }

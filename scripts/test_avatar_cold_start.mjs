#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

// Private browser origin and real IndexedDB; no application service or DB.
const origin = 'http://avatar-cold-start.test';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin, 'the fixture must never contact another server');
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <link rel="stylesheet" href="/static/css/12-overview-dashboard.css">
      <div id="stats-bar"></div><img id="menu-avatar" alt="">
      <style>:root{--text-primary:#eee;--text-muted:#999;--accent:#7777ff}body{background:#17172a;color:#eee}</style>` });
    try {
      return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
        body: readFileSync(new URL(`../web${url.pathname}`, import.meta.url), 'utf8') });
    } catch { return route.fulfill({ status: 404 }); }
  });

  await page.goto(origin);
  await page.evaluate(async () => {
    const storage = await import('/static/js/storage/indexed-db.js');
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    canvas.getContext('2d').fillRect(0, 0, 32, 32);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    await storage.openDatabase();
    await storage.putAvatarWhenReady({ id: `${location.origin}|7`, version: 'v1', blob });
  });

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload(); // New JS realm: in-memory URLs cannot satisfy this test.
    await page.evaluate(async () => {
      localStorage.setItem('jwt_token', 'header.payload.signature');
      const storage = await import('/static/js/storage/indexed-db.js');
      const { loadAuthenticatedImage } = await import('/static/js/core/authenticated-image.js');
      const { createAppRenderingFeature } = await import('/static/js/features/app-rendering.js');
      const user = { id: 7, display_name: 'Tobi', avatar_url: '/api/avatars/user-7.webp', avatar_updated_at: 'v1' };
      const requests = [];
      // Any avatar request remains blocked. A cold cache hit must never wait on it.
      window.fetch = async url => { requests.push(String(url)); return new Promise(() => {}); };
      const earlyLoad = loadAuthenticatedImage(document.getElementById('menu-avatar'), `${user.avatar_url}?v=v1`, { userId: user.id, version: user.avatar_updated_at });
      const rendering = createAppRenderingFeature({
        appVersion: 'test', escapeHtml: String, escapeHtmlAttr: String,
        getTodos: () => [], getProjects: () => [], getSections: () => [],
        getCurrentFilter: () => 'all', getCurrentProjectId: () => null,
        getCurrentWorkspaceId: () => null, getCurrentUser: () => user,
        getDashboardPreferences: () => ({}), getMinimalTodos: () => false,
        getFocusFilters: () => ({}), sortTodoList: items => items,
        renderTodoItem: () => '', renderSectionHeader: () => '',
      });
      window.fixture = { storage, user, requests, earlyLoad, rendering };
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.equal(await page.evaluate(() => window.fixture.requests.length), 0, 'opening the UI before IndexedDB must not start an avatar request');
    await page.evaluate(async () => { await window.fixture.storage.openDatabase(); });
    await page.waitForFunction(() => document.getElementById('menu-avatar').src.startsWith('blob:'));
    const firstPaint = await page.evaluate(async () => {
      window.fixture.rendering.renderStats();
      const image = document.querySelector('[data-auth-avatar]');
      const synchronousSource = image.src;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const fallback = document.querySelector('.overview-avatar-initial');
      return { synchronousSource, visibleAvatar: (Number(getComputedStyle(image).opacity) > 0 && image.naturalWidth > 0)
        || (getComputedStyle(fallback).visibility !== 'hidden' && Number(getComputedStyle(fallback).opacity) > 0) };
    });
    assert.match(firstPaint.synchronousSource, /^blob:/, 'the dashboard synchronously reuses the avatar warmed during cache initialization');
    assert.equal(firstPaint.visibleAvatar, true, 'the first visible frame contains a decoded avatar or its initial, never a blank image');
    await page.waitForFunction(() => document.querySelector('[data-auth-avatar]')?.classList.contains('is-ready'));
    assert.equal(await page.evaluate(() => window.fixture.requests.length), 0, 'the cached avatar is displayed without any server request on desktop and mobile cold starts');
    assert.ok(await page.locator('[data-auth-avatar]').evaluate(image => image.complete && image.naturalWidth > 0));
  }

  await page.evaluate(async () => {
    const fixture = window.fixture;
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext('2d'); context.fillStyle = '#7a7aff'; context.fillRect(0, 0, 32, 32);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    window.fetch = async url => { fixture.requests.push(String(url)); return new Response(blob); };
    // Same metadata update used by the websocket callback.
    fixture.user.avatar_updated_at = 'v2';
    fixture.rendering.renderStats();
  });
  await page.waitForFunction(() => document.querySelector('[data-auth-avatar]')?.dataset.authAvatarSrc?.endsWith('?v=v2'));
  assert.equal(await page.evaluate(() => window.fixture.requests.length), 1, 'a changed avatar version downloads exactly once');
  assert.equal(await page.evaluate(async () => (await window.fixture.storage.getAvatarWhenReady(`${location.origin}|7`)).version), 'v2');

  await page.evaluate(async () => {
    const fixture = window.fixture;
    fixture.user.avatar_updated_at = 'corrupt';
    await fixture.storage.putAvatarWhenReady({ id: `${location.origin}|7`, version: 'corrupt', blob: new Blob(['invalid image bytes']) });
    fixture.rendering.renderStats();
  });
  await page.waitForFunction(() => {
    const image = document.querySelector('[data-auth-avatar]');
    return image && !image.dataset.authAvatarPendingSrc && !image.getAttribute('src');
  });
  assert.equal(await page.evaluate(async () => window.fixture.storage.getAvatarWhenReady(`${location.origin}|7`)), null,
    'a real decode error evicts the corrupt persisted blob');
  assert.equal(await page.evaluate(() => window.fixture.requests.length), 1);
  await page.evaluate(() => window.fixture.rendering.renderStats());
  await page.waitForFunction(() => document.querySelector('[data-auth-avatar]')?.classList.contains('is-ready'));
  assert.equal(await page.evaluate(() => window.fixture.requests.length), 2, 'decode recovery fetches fresh bytes rather than retrying the same corrupt cache');
  assert.deepEqual(errors, []);
  console.log('✅ Desktop/mobile cold starts use persisted avatars without network; first paint, version refresh and corrupt-cache recovery passed');
} finally {
  await browser.close();
}

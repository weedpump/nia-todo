#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(root, 'web/static/style.css'), 'utf8');
const authSession = readFileSync(join(root, 'web/static/js/features/auth-session.js'), 'utf8');

assert(css.includes('flex: 1 0 max-content'), 'login auth buttons must wrap from intrinsic label width, not from a fixed flex basis');
assert(css.includes('max-width: 100%'), 'login auth buttons must stay within the login form when stacked');
assert(!css.includes('.login-auth-alternatives.stacked') && !authSession.includes("classList.toggle('stacked'"), 'login auth alternative layout must not rely on stale JS stacked state');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });

async function renderAuthButtons({ containerWidth, oidcLabel, passkeyLabel = 'Sign in with passkey' }) {
  await page.setContent(`
    <!doctype html>
    <meta charset="utf-8">
    <style>${css}</style>
    <div class="login-auth-alternatives" style="width: ${containerWidth}px">
      <div class="login-auth-divider"><span>or</span></div>
      <button type="button" class="login-passkey-btn" id="login-oidc-btn"></button>
      <button type="button" class="login-passkey-btn" id="login-passkey-btn"></button>
    </div>
  `);
  await page.locator('#login-oidc-btn').evaluate((button, text) => { button.textContent = text; }, oidcLabel);
  await page.locator('#login-passkey-btn').evaluate((button, text) => { button.textContent = text; }, passkeyLabel);
}

async function buttonMetrics() {
  return page.locator('.login-auth-alternatives .login-passkey-btn').evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
    };
  }));
}

function sameRow([first, second]) {
  return Math.abs(first.top - second.top) < 1;
}

function stackedFullWidth(metrics, containerWidth) {
  return !sameRow(metrics) && metrics.every((item) => Math.abs(item.width - containerWidth) < 1);
}

await renderAuthButtons({ containerWidth: 380, oidcLabel: 'Sign in with OIDC' });
let metrics = await buttonMetrics();
assert(sameRow(metrics), 'desktop: normal OIDC/passkey labels should sit side-by-side');
assert(metrics.every((item) => item.width >= 148), 'desktop: side-by-side buttons should keep a usable minimum width');

await page.locator('#login-oidc-btn').evaluate((button) => { button.textContent = 'Sign in with a very very long corporate identity provider name'; });
metrics = await buttonMetrics();
assert(stackedFullWidth(metrics, 380), 'desktop: a long provider label should stack both auth buttons full-width');

await page.locator('#login-oidc-btn').evaluate((button) => { button.textContent = 'Sign in with OIDC'; });
metrics = await buttonMetrics();
assert(sameRow(metrics), 'desktop: shortening the provider label again should return to side-by-side without stale state');

await renderAuthButtons({ containerWidth: 320, oidcLabel: 'Sign in with OIDC' });
metrics = await buttonMetrics();
assert(sameRow(metrics), 'mobile: normal OIDC/passkey labels should sit side-by-side when they fit');

await page.locator('#login-oidc-btn').evaluate((button) => { button.textContent = 'Sign in with an extremely long mobile provider label'; });
metrics = await buttonMetrics();
assert(stackedFullWidth(metrics, 320), 'mobile: a long provider label should stack both auth buttons full-width');

await browser.close();
console.log('✅ Frontend login auth layout test passed');

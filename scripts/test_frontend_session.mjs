#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { withFreshDb, launchPage, BASE_URL } from './frontend_test_lib.mjs';

function createNearExpiryToken() {
  const output = execFileSync('python3', ['-'], {
    cwd: '~/projects/nia-todo-dev/api',
    env: { ...process.env, NIA_TODO_DB: 'nia-todo-dev.db' },
    encoding: 'utf8',
    input: `
import json
import time
import jwt as pyjwt
from db import get_db
from services.auth import get_jwt_secret

with get_db() as db:
    user = db.execute("SELECT id, username, token_version FROM users WHERE username = ?", ("frontenduser",)).fetchone()
    secret = get_jwt_secret(db)

now = int(time.time())
payload = {
    "user_id": user["id"],
    "username": user["username"],
    "token_version": user["token_version"],
    "iat": now - 86400 * 29,
    "exp": now + 3600,
}
print(json.dumps({"token": pyjwt.encode(payload, secret, algorithm="HS256"), "user_id": user["id"]}))
`,
  });
  return JSON.parse(output);
}

async function run() {
  console.log('🔐 Running frontend sliding-session test...');
  const { token, user_id: userId } = createNearExpiryToken();
  const { browser, page, consoleErrors, pageErrors, assertNoFrontendErrors } = await launchPage();

  try {
    await page.addInitScript(({ token, userId }) => {
      localStorage.setItem('jwt_token', token);
      localStorage.setItem('last_user_id', String(userId));
      localStorage.removeItem('csrf_token');
    }, { token, userId });

    const meResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/me'), { timeout: 10000 });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    const meResponse = await meResponsePromise;
    const meData = await meResponse.json();
    if (!meData.access_token) throw new Error(`/api/me did not return a refreshed token: ${JSON.stringify(meData)}`);

    await page.locator('#boot-overlay.hidden').waitFor({ state: 'attached', timeout: 10000 });
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 10000 });
    await page.locator('#user-menu-button').waitFor({ state: 'visible', timeout: 10000 });

    const result = await page.evaluate((oldToken) => {
      const parseJwt = (jwt) => JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      const newToken = localStorage.getItem('jwt_token');
      const csrf = localStorage.getItem('csrf_token');
      const payload = parseJwt(newToken);
      return {
        tokenChanged: newToken !== oldToken,
        csrfStored: Boolean(csrf),
        lifetimeDays: Math.round((payload.exp - payload.iat) / 86400),
      };
    }, token);

    if (!result.tokenChanged) throw new Error(`Near-expiry JWT was not stored by the frontend; result=${JSON.stringify(result)}`);
    if (!result.csrfStored) throw new Error('Sliding refresh did not store a fresh CSRF token');
    if (result.lifetimeDays !== 30) throw new Error(`Refreshed JWT lifetime should be 30 days, got ${result.lifetimeDays}`);

    const offlineReady = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker?.ready?.catch(() => null);
      return {
        hasController: Boolean(navigator.serviceWorker?.controller),
        hasRegistration: Boolean(reg),
        cachedUser: Boolean(localStorage.getItem('cached_user')),
      };
    });
    if (!offlineReady.cachedUser) throw new Error(`Successful auth did not cache user profile: ${JSON.stringify(offlineReady)}`);
    assertNoFrontendErrors();
    const offlineConsoleStart = consoleErrors.length;
    const offlinePageErrorStart = pageErrors.length;

    await page.context().setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#boot-overlay.hidden').waitFor({ state: 'attached', timeout: 10000 });
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 10000 });
    await page.locator('#user-menu-button').waitFor({ state: 'visible', timeout: 10000 });

    const offlineSession = await page.evaluate(() => ({
      tokenKept: Boolean(localStorage.getItem('jwt_token')),
      cachedUserKept: Boolean(localStorage.getItem('cached_user')),
      online: navigator.onLine,
      loginHidden: document.getElementById('login-overlay')?.classList.contains('hidden'),
      hasCurrentUser: Boolean(window.currentUser || document.getElementById('settings-username')?.textContent),
    }));
    if (!offlineSession.tokenKept || !offlineSession.cachedUserKept || !offlineSession.loginHidden) {
      throw new Error(`Offline cold start did not keep the cached session: ${JSON.stringify(offlineSession)}`);
    }

    await page.context().setOffline(false);
    const offlinePageErrors = pageErrors.slice(offlinePageErrorStart);
    const unexpectedOfflineConsoleErrors = consoleErrors.slice(offlineConsoleStart).filter(msg => {
      if (msg.includes("WebSocket connection to 'ws://localhost:8754/ws' failed")) return false;
      if (msg.includes('[WS] Error: Event')) return false;
      if (msg.includes('Failed to load resource: net::ERR_INTERNET_DISCONNECTED')) return false;
      if (msg.includes('Failed to load resource: the server responded with a status of 404')) return false;
      return true;
    });
    if (offlinePageErrors.length || unexpectedOfflineConsoleErrors.length) {
      throw new Error(`Offline cold start emitted unexpected errors:\npageErrors=${JSON.stringify(offlinePageErrors)}\nconsoleErrors=${JSON.stringify(unexpectedOfflineConsoleErrors)}`);
    }
    console.log('✅ Frontend sliding/offline-session test passed');
  } finally {
    await browser.close();
  }
}

withFreshDb(run);

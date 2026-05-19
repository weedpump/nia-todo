#!/usr/bin/env node
/**
 * nia-todo Frontend Smoke Test (Playwright)
 *
 * Runs against the dev service with an isolated temporary DB:
 * 1. backup current dev DB
 * 2. restart service with empty DB
 * 3. perform setup via API
 * 4. drive the real frontend in headless Chromium
 * 5. restore original DB
 *
 * Usage:
 *   npx --yes -p playwright node scripts/test_frontend.mjs
 */
import { chromium } from 'playwright';
import { existsSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE_URL = process.env.NIA_TODO_URL || 'http://localhost:8754';
const SERVICE = process.env.NIA_TODO_SERVICE || 'nia-todo-dev';
const DB_PATH = '~/projects/nia-todo-dev/api/data/nia-todo-dev.db';
const DB_BACKUP = '~/projects/nia-todo-dev/api/data/nia-todo-dev.db.frontend-test-backup';
const ADMIN_PASSWORD = 'FrontendAdmin123!';
const USERNAME = 'frontenduser';
const USER_PASSWORD = 'FrontendPass123!';

function sh(command, args = [], options = {}) {
  return execFileSync(command, args, { stdio: 'pipe', encoding: 'utf8', ...options });
}

function service(action) {
  sh('systemctl', [action, SERVICE]);
}

async function waitForService(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/setup/status`);
      if (response.ok) return;
    } catch (_) {
      // retry
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Service not ready: ${BASE_URL}`);
}

async function api(method, path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

function backupDb() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  if (existsSync(DB_BACKUP)) unlinkSync(DB_BACKUP);
  if (existsSync(DB_PATH)) renameSync(DB_PATH, DB_BACKUP);
}

function restoreDb() {
  try { service('stop'); } catch (_) {}
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  if (existsSync(DB_BACKUP)) renameSync(DB_BACKUP, DB_PATH);
  service('start');
}

async function prepareFreshDb() {
  backupDb();
  service('restart');
  await waitForService();
  await api('POST', '/api/setup/admin', { admin_password: ADMIN_PASSWORD });
  await api('POST', '/api/setup/first-user', {
    username: USERNAME,
    password: USER_PASSWORD,
    display_name: 'Frontend Test User',
  });
}

async function runBrowserSmokeTest() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', error => pageErrors.push(error.message));

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.locator('#login-overlay').waitFor({ state: 'visible' });
    await page.fill('#login-username', USERNAME);
    await page.fill('#login-password', USER_PASSWORD);
    await page.click('button.login-btn');

    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 10_000 });
    await page.locator('#user-name').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#user-name')?.textContent?.includes('Frontend Test User'));

    // Create project through real UI.
    await page.click('button[onclick="showProjectModal()"]');
    await page.fill('#project-name', 'Frontend Smoke Project');
    await page.fill('#project-color', '#ff8800');
    await page.click('button[form="project-form"]');
    await page.locator('#project-modal').waitFor({ state: 'hidden' });
    await page.getByText('Frontend Smoke Project').waitFor({ state: 'visible' });

    // Create todo through real UI.
    await page.getByRole('button', { name: /Neues Todo/ }).click();
    await page.fill('#todo-title', 'Frontend Smoke Todo');
    await page.fill('#todo-desc', '**Smoke** test via Playwright');
    await page.selectOption('#todo-project', { label: 'Frontend Smoke Project' });
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden' });
    await page.getByText('Frontend Smoke Todo').waitFor({ state: 'visible' });

    // Search + status toggle smoke.
    await page.fill('#search-input', 'Smoke Todo');
    await page.getByText('Frontend Smoke Todo').waitFor({ state: 'visible' });
    const todoCheck = page.locator('.todo-item').filter({ hasText: 'Frontend Smoke Todo' }).locator('.todo-check').first();
    await todoCheck.click(); // pending -> in_progress
    await todoCheck.click(); // in_progress -> done
    await page.getByText(/Todo erledigt|Todo wiedereröffnet/).waitFor({ state: 'visible' });

    if (pageErrors.length || consoleErrors.length) {
      throw new Error(`Frontend emitted errors:\npageErrors=${JSON.stringify(pageErrors)}\nconsoleErrors=${JSON.stringify(consoleErrors)}`);
    }

    console.log('✅ Frontend smoke test passed');
  } finally {
    await page.screenshot({ path: '/tmp/nia-todo-frontend-smoke.png', fullPage: true }).catch(() => {});
    await browser.close();
  }
}

let ok = false;
try {
  console.log('📦 Backup DB + prepare fresh frontend test DB...');
  await prepareFreshDb();
  console.log('🌐 Running Playwright frontend smoke test...');
  await runBrowserSmokeTest();
  ok = true;
} finally {
  console.log('🔄 Restoring original dev DB...');
  restoreDb();
  await waitForService().catch(() => {});
}

if (!ok) process.exit(1);

#!/usr/bin/env node
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
function service(action) { sh('systemctl', [action, SERVICE]); }
async function waitForService(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/setup/status`);
      if (response.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
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
  try { service('stop'); } catch {}
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
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => pageErrors.push(error.message));
  const visible = (sel, timeout = 5000) => page.locator(sel).waitFor({ state: 'visible', timeout });
  const hidden = (sel, timeout = 5000) => page.locator(sel).waitFor({ state: 'hidden', timeout });

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await visible('#login-overlay');
    await page.fill('#login-username', USERNAME);
    await page.fill('#login-password', USER_PASSWORD);
    await page.click('button.login-btn');

    await hidden('#login-overlay', 10_000);
    await visible('#user-name');
    await page.waitForFunction(() => document.querySelector('#user-name')?.textContent?.includes('Frontend Test User'));

    await visible('#sidebar');
    await page.click('#theme-toggle-btn');
    await page.click('#theme-toggle-btn');
    await page.locator('#update-btn').waitFor({ state: 'attached' });

    await page.click('button[onclick="showProjectModal()"]');
    await page.fill('#project-name', 'Frontend Smoke Project');
    await page.fill('#project-color', '#ff8800');
    await page.click('button[form="project-form"]');
    await hidden('#project-modal');
    await visible('text=Frontend Smoke Project');

    await page.getByRole('button', { name: /Neues Todo/ }).click();
    await page.fill('#todo-title', 'Frontend Smoke Todo');
    await page.fill('#todo-desc', '**Smoke** test via Playwright');
    await page.selectOption('#todo-project', { label: 'Frontend Smoke Project' });
    await page.click('button[form="todo-form"]');
    await hidden('#todo-modal');
    await page.getByText('Frontend Smoke Todo', { exact: true }).waitFor({ state: 'visible' });

    await page.click('button[onclick="showTodoModal()"]');
    await page.fill('#todo-title', 'Frontend Smoke Todo 2');
    await page.click('button[form="todo-form"]');
    await hidden('#todo-modal');
    await visible('text=Frontend Smoke Todo 2');

    await page.fill('#search-input', 'Smoke Todo');
    await page.getByText('Frontend Smoke Todo', { exact: true }).waitFor({ state: 'visible' });
    await page.fill('#search-input', '');

    const todoItem = page.locator('.todo-item').filter({ hasText: 'Frontend Smoke Todo' }).first();
    await todoItem.locator('.todo-check').click();
    await todoItem.locator('.todo-check').click();
    await page.getByText(/Todo erledigt|Todo wiedereröffnet/).waitFor({ state: 'visible' });

    await page.click('#toggle-done-btn');
    await page.click('#sort-toggle-btn');
    await page.click('#sort-toggle-btn');

    await todoItem.click();
    await visible('#todo-modal');
    await page.click('button[onclick="deleteTodoFromModal()"]');
    await page.waitForTimeout(800);
    await page.click('#toast-undo');
    await page.getByText('Frontend Smoke Todo', { exact: true }).waitFor({ state: 'visible' });

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

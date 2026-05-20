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
  page.on('dialog', dialog => dialog.accept());
  const visible = (sel, timeout = 5000) => page.locator(sel).waitFor({ state: 'visible', timeout });
  const hidden = (sel, timeout = 5000) => page.locator(sel).waitFor({ state: 'hidden', timeout });
  const waitForText = (text, timeout = 10000) => page.waitForFunction(
    value => document.body.innerText.includes(value),
    text,
    { timeout },
  );
  const clickProjectNav = async (name) => {
    await page.locator('.nav-btn').filter({ hasText: name }).first().click();
    await page.locator('.add-section-row').waitFor({ state: 'visible' });
  };
  const openTodoModal = async () => {
    await page.getByRole('button', { name: /Neues Todo/ }).click();
    await visible('#todo-modal');
  };

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

    await clickProjectNav('Frontend Smoke Project');

    const createSection = async (name) => {
      await page.evaluate((sectionName) => {
        window.showAddSectionForm();
      }, name);
      const input = page.locator('#new-section-name');
      await input.waitFor({ state: 'visible' });
      await input.fill(name);
      await page.evaluate(() => window.saveNewSection());
      await page.getByText(name, { exact: true }).waitFor({ state: 'visible' });
    };

    await createSection('Frontend Section A');
    await createSection('Frontend Section B');

    await page.click('button[onclick="showProjectModal()"]');
    await page.fill('#project-name', 'Frontend Smoke Project 2');
    await page.fill('#project-color', '#00aa88');
    await page.click('button[form="project-form"]');
    await hidden('#project-modal');
    await visible('text=Frontend Smoke Project 2');

    const ensureSectionOptions = async (expectedLabels, { disabled = false } = {}) => {
      await page.waitForFunction(({ labels, disabled }) => {
        const sel = document.querySelector('#todo-section');
        if (!sel) return false;
        if (sel.disabled !== disabled) return false;
        const optionTexts = Array.from(sel.options).map(o => o.textContent || '');
        return labels.every(label => optionTexts.some(text => text.includes(label)));
      }, { labels: expectedLabels, disabled }, { timeout: 10000 });
    };

    await openTodoModal();
    await page.fill('#todo-title', 'Frontend Section Todo');
    await page.selectOption('#todo-project', { label: 'Frontend Smoke Project' });
    await ensureSectionOptions(['Keine Section', 'Frontend Section A', 'Frontend Section B']);
    await page.selectOption('#todo-section', { label: 'Frontend Section A' });
    await page.click('button[form="todo-form"]');
    await hidden('#todo-modal');

    await clickProjectNav('Frontend Smoke Project');
    await page.waitForFunction(() => {
      const headers = Array.from(document.querySelectorAll('.section-header .section-name'));
      return headers.some(el => el.textContent?.includes('Frontend Section A'))
        && document.body.innerText.includes('Frontend Section Todo');
    }, { timeout: 10000 });

    const sectionHeaderA = page.locator('.section-header').filter({ hasText: 'Frontend Section A' }).first();
    await sectionHeaderA.waitFor({ state: 'visible' });
    await page.locator('.section-todos[data-section-id]').filter({ has: page.getByText('Frontend Section Todo', { exact: true }) }).first().waitFor({ state: 'visible' });

    await sectionHeaderA.locator('.section-name').click();
    const renameInput = page.locator('input[id^="edit-section-name-"]');
    await renameInput.first().waitFor({ state: 'visible' });
    await renameInput.first().fill('Frontend Section A Renamed');
    await renameInput.first().press('Enter');
    await page.getByText('Frontend Section A Renamed', { exact: true }).waitFor({ state: 'visible' });

    await openTodoModal();
    await page.fill('#todo-title', 'Frontend Project Switch Todo');
    await page.selectOption('#todo-project', { label: 'Frontend Smoke Project' });
    await ensureSectionOptions(['Frontend Section A Renamed', 'Frontend Section B']);
    await page.selectOption('#todo-project', { label: 'Frontend Smoke Project 2' });
    await ensureSectionOptions(['Keine Section'], { disabled: false });
    await page.waitForFunction(() => {
      const sel = document.querySelector('#todo-section');
      if (!sel) return false;
      const optionTexts = Array.from(sel.options).map(o => o.textContent || '');
      return !optionTexts.some(text => text.includes('Frontend Section A Renamed') || text.includes('Frontend Section B'));
    }, { timeout: 10000 });
    await page.selectOption('#todo-project', { label: 'Frontend Smoke Project' });
    await ensureSectionOptions(['Frontend Section A Renamed', 'Frontend Section B']);
    await page.selectOption('#todo-section', { label: 'Frontend Section B' });
    await page.click('button[form="todo-form"]');
    await hidden('#todo-modal');
    await clickProjectNav('Frontend Smoke Project');
    await waitForText('Frontend Project Switch Todo');

    const deleteSectionButton = page.locator('.section-header').filter({ hasText: 'Frontend Section A Renamed' }).first().locator('.section-delete');
    await deleteSectionButton.click();
    await page.waitForFunction(() => {
      const sectionNames = Array.from(document.querySelectorAll('.section-header .section-name')).map(el => el.textContent || '');
      const unsortedBlocks = Array.from(document.querySelectorAll('.section-header')).filter(el => el.textContent?.includes('Unsortiert'));
      return !sectionNames.some(name => name.includes('Frontend Section A Renamed'))
        && unsortedBlocks.length > 0
        && document.body.innerText.includes('Frontend Section Todo');
    }, { timeout: 10000 });

    await openTodoModal();
    await page.fill('#todo-title', 'Frontend Smoke Todo');
    await page.fill('#todo-desc', '**Smoke** test via Playwright');
    await page.selectOption('#todo-project', { label: 'Frontend Smoke Project' });
    await page.click('button[form="todo-form"]');
    await hidden('#todo-modal');
    await clickProjectNav('Frontend Smoke Project');
    await waitForText('Frontend Smoke Todo');

    await page.click('button[onclick="showTodoModal()"]');
    await visible('#todo-modal');
    await page.fill('#todo-title', 'Frontend Smoke Todo 2');
    await page.click('button[form="todo-form"]');
    await hidden('#todo-modal');
    await visible('text=Frontend Smoke Todo 2');

    await page.fill('#search-input', 'Smoke Todo');
    await waitForText('Frontend Smoke Todo');
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
    await clickProjectNav('Frontend Smoke Project');
    await waitForText('Frontend Smoke Todo');

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

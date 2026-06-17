#!/usr/bin/env node
import { chromium } from 'playwright';
import { existsSync, renameSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

export const BASE_URL = process.env.NIA_TODO_URL || 'http://localhost:8754';
export const SERVICE = process.env.NIA_TODO_SERVICE || 'nia-todo-dev';
export const DB_PATH = '~/projects/nia-todo-dev/api/data/nia-todo-dev.db';
export const DB_BACKUP = '~/projects/nia-todo-dev/api/data/nia-todo-dev.db.frontend-test-backup';
export const ATTACHMENT_DIR = '~/projects/nia-todo-dev/api/data/attachments';
export const ATTACHMENT_BACKUP = '~/projects/nia-todo-dev/api/data/attachments.frontend-test-backup';
export const ADMIN_PASSWORD = 'FrontendAdmin123!';
export const USERNAME = 'frontenduser';
export const USER_PASSWORD = 'FrontendPass123!';

function sh(command, args = [], options = {}) {
  return execFileSync(command, args, { stdio: 'pipe', encoding: 'utf8', ...options });
}

export function service(action) {
  if (action === 'start') {
    try {
      sh('systemctl', ['reset-failed', SERVICE]);
    } catch {}
  }
  sh('systemctl', [action, SERVICE]);
}

export async function waitForService(timeoutMs = 60_000) {
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

export async function api(method, path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

export function backupDb() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  if (existsSync(DB_BACKUP)) unlinkSync(DB_BACKUP);
  if (existsSync(DB_PATH)) renameSync(DB_PATH, DB_BACKUP);
  if (existsSync(ATTACHMENT_BACKUP)) rmSync(ATTACHMENT_BACKUP, { recursive: true, force: true });
  if (existsSync(ATTACHMENT_DIR)) renameSync(ATTACHMENT_DIR, ATTACHMENT_BACKUP);
}

export function restoreDb() {
  try { service('stop'); } catch {}
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  if (existsSync(DB_BACKUP)) renameSync(DB_BACKUP, DB_PATH);
  if (existsSync(ATTACHMENT_DIR)) rmSync(ATTACHMENT_DIR, { recursive: true, force: true });
  if (existsSync(ATTACHMENT_BACKUP)) renameSync(ATTACHMENT_BACKUP, ATTACHMENT_DIR);
  service('start');
}

export async function prepareFreshDb() {
  try { service('stop'); } catch {}
  backupDb();
  service('start');
  await waitForService();
  await api('POST', '/api/setup/admin', { admin_password: ADMIN_PASSWORD });
  await api('POST', '/api/setup/first-user', {
    username: USERNAME,
    email: 'frontenduser@example.invalid',
    password: USER_PASSWORD,
    display_name: 'Frontend Test User',
  });
}

export async function launchPage() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('dialog', dialog => dialog.accept());

  const helpers = {
    visible: (sel, timeout = 5000) => page.locator(sel).waitFor({ state: 'visible', timeout }),
    hidden: (sel, timeout = 5000) => page.locator(sel).waitFor({ state: 'hidden', timeout }),
    waitForText: (text, timeout = 10000) => page.waitForFunction(value => document.body.innerText.includes(value), text, { timeout }),
    clickProjectNav: async (name) => {
      await page.locator('.nav-btn').filter({ hasText: name }).first().click();
      await page.locator('.add-section-row').waitFor({ state: 'visible' });
    },
    openTodoModal: async () => {
      await page.getByRole('button', { name: /Neues Todo|New todo/i }).click();
      await page.locator('#todo-modal').waitFor({ state: 'visible', timeout: 5000 });
    },
    ensureSectionOptions: async (expectedLabels, { disabled = false } = {}) => {
      await page.waitForFunction(({ labels, disabled }) => {
        const labelVariants = {
          'Keine Section': ['Keine Section', 'No section'],
          'Keine Section (Unsortiert)': ['Keine Section (Unsortiert)', 'No section (unsorted)'],
        };
        const sel = document.querySelector('#todo-section');
        if (!sel) return false;
        if (sel.disabled !== disabled) return false;
        const optionTexts = Array.from(sel.options).map(o => o.textContent || '');
        return labels.every(label => (labelVariants[label] || [label]).some(variant => optionTexts.some(text => text.includes(variant))));
      }, { labels: expectedLabels, disabled }, { timeout: 10000 });
    },
    createSection: async (name) => {
      await page.evaluate(() => window.showAddSectionForm());
      const input = page.locator('#new-section-name');
      await input.waitFor({ state: 'visible' });
      await input.fill(name);
      await page.evaluate(() => window.saveNewSection());
      await page.getByText(name, { exact: true }).waitFor({ state: 'visible' });
    },
    loginApp: async () => {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('#login-username').waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('button.login-btn').waitFor({ state: 'visible', timeout: 10000 });
      await page.fill('#login-username', USERNAME);
      await page.fill('#login-password', USER_PASSWORD);
      await page.click('button.login-btn');
      await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 15000 });
      await page.locator('#user-menu-button').waitFor({ state: 'visible', timeout: 10000 });
    },
    assertNoFrontendErrors: () => {
      const filtered = consoleErrors.filter(msg => !msg.includes('Failed to load resource: the server responded with a status of 404'));
      if (pageErrors.length || filtered.length) {
        throw new Error(`Frontend emitted errors:\npageErrors=${JSON.stringify(pageErrors)}\nconsoleErrors=${JSON.stringify(filtered)}`);
      }
    },
    dumpErrors: () => ({ pageErrors: [...pageErrors], consoleErrors: [...consoleErrors] }),
  };

  return { browser, page, consoleErrors, pageErrors, ...helpers };
}

export async function withFreshDb(run) {
  let ok = false;
  try {
    console.log('📦 Backup DB + prepare fresh frontend test DB...');
    await prepareFreshDb();
    await run();
    ok = true;
  } finally {
    console.log('🔄 Restoring original dev DB...');
    restoreDb();
    if (ok) {
      await waitForService();
    } else {
      await waitForService().catch(() => {});
    }
  }
  if (!ok) process.exit(1);
}

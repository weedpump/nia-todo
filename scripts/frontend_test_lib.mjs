#!/usr/bin/env node
import { chromium } from 'playwright';
import { existsSync as nodeExistsSync, renameSync, unlinkSync, mkdirSync, rmSync, copyFileSync, cpSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const BASE_URL = process.env.NIA_TODO_URL || 'http://localhost:8754';
export const SERVICE = process.env.NIA_TODO_SERVICE || 'nia-todo-dev';
export const DEV_DIR = process.env.NIA_TODO_DEV_DIR || dirname(dirname(fileURLToPath(import.meta.url)));
// sudo resets PATH to secure_path, so a bare "python3" would miss the app's
// venv (and thus fastapi) when scripts import the app's own modules.
export const APP_PYTHON = nodeExistsSync(`${DEV_DIR}/.venv/bin/python3`) ? `${DEV_DIR}/.venv/bin/python3` : 'python3';
const DATA_DIR = process.env.NIA_TODO_DATA_DIR || `${DEV_DIR}/api/data`;
const DB_NAME = process.env.NIA_TODO_DB_NAME || 'nia-todo-dev.db';
export const DB_PATH = `${DATA_DIR}/${DB_NAME}`;
export const DB_BACKUP = `${DATA_DIR}/${DB_NAME}.frontend-test-backup`;
export const DB_SUITE_BACKUP = `${DATA_DIR}/${DB_NAME}.frontend-suite-backup`;
export const ATTACHMENT_DIR = `${DATA_DIR}/attachments`;
export const ATTACHMENT_BACKUP = `${DATA_DIR}/attachments.frontend-test-backup`;
export const ATTACHMENT_SUITE_BACKUP = `${DATA_DIR}/attachments.frontend-suite-backup`;
export const ADMIN_PASSWORD = 'FrontendAdmin123!';
export const USERNAME = 'frontenduser';
export const USER_PASSWORD = 'FrontendPass123!';
const SUDO_FS = process.env.NIA_TODO_TEST_SUDO_FS === '1';
const SERVICE_USER = process.env.NIA_TODO_TEST_SERVICE_USER || SERVICE;

function sh(command, args = [], options = {}) {
  return execFileSync(command, args, { stdio: 'pipe', encoding: 'utf8', ...options });
}

function sudo(args, options = {}) {
  return sh('sudo', ['-n', ...args.map(String)], options);
}

function fsExists(path) {
  if (!SUDO_FS) return nodeExistsSync(path);
  try {
    sudo(['test', '-e', path]);
    return true;
  } catch {
    return false;
  }
}

function fsMkdir(path) {
  if (SUDO_FS) sudo(['mkdir', '-p', path]);
  else mkdirSync(path, { recursive: true });
}

function fsUnlink(path) {
  if (!fsExists(path)) return;
  if (SUDO_FS) sudo(['rm', '-f', path]);
  else unlinkSync(path);
}

function fsRm(path) {
  if (!fsExists(path)) return;
  if (SUDO_FS) sudo(['rm', '-rf', path]);
  else rmSync(path, { recursive: true, force: true });
}

function fsCopy(source, target, recursive = false) {
  if (!fsExists(source)) return;
  if (SUDO_FS) {
    sudo(recursive ? ['cp', '-a', source, target] : ['cp', source, target]);
    sudo(['chown', '-R', `${SERVICE_USER}:${SERVICE_USER}`, target]);
  } else if (recursive) {
    cpSync(source, target, { recursive: true });
  } else {
    copyFileSync(source, target);
  }
}

function fsMove(source, target) {
  if (!fsExists(source)) return;
  if (SUDO_FS) {
    sudo(['mv', source, target]);
    sudo(['chown', '-R', `${SERVICE_USER}:${SERVICE_USER}`, target]);
  } else {
    renameSync(source, target);
  }
}

export function sqlitePython(script, options = {}) {
  const command = SUDO_FS ? 'sudo' : APP_PYTHON;
  const args = SUDO_FS ? ['-n', APP_PYTHON, '-c', script] : ['-c', script];
  return sh(command, args, options);
}

export function service(action) {
  if (action === 'start') {
    try {
      sh('sudo', ['-n', 'systemctl', 'reset-failed', SERVICE]);
    } catch {}
  }
  sh('sudo', ['-n', 'systemctl', action, SERVICE]);
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

function devDbUsers(path = DB_PATH) {
  if (!fsExists(path)) return null;
  const script = `
import json, sqlite3, sys
path = ${JSON.stringify(path)}
con = sqlite3.connect(path)
try:
    tables = {row[0] for row in con.execute("select name from sqlite_master where type='table'")}
    if "users" not in tables:
        print(json.dumps([]))
    else:
        print(json.dumps([
            {"username": username, "email": email}
            for username, email in con.execute("select username, email from users order by id")
        ]))
finally:
    con.close()
`;
  return JSON.parse(sqlitePython(script).trim());
}

function assertRestorableDevDb(path = DB_PATH, context = 'backup') {
  const users = devDbUsers(path);
  if (users === null) return;
  if (users.length <= 0 && process.env.NIA_TODO_ALLOW_EMPTY_DEV_DB_BACKUP !== '1') {
    throw new Error(`${context} refused: ${path} has users=${users.length}. Refusing to treat an empty dev DB as the original DB.`);
  }
}

function assertNotFrontendTestOnlyDb(path = DB_PATH, context = 'backup') {
  const users = devDbUsers(path);
  if (users === null) return;
  const usernames = users.map(user => user.username).sort();
  if (usernames.length === 1 && usernames[0] === USERNAME) {
    throw new Error(`${context} refused: ${path} only contains ${USERNAME}. Refusing to preserve a frontend test DB as the dev DB.`);
  }
}

function suiteDbManaged() {
  return process.env.NIA_TODO_FRONTEND_DB_SUITE === '1';
}

function sharedSuiteDbManaged() {
  return suiteDbManaged() && process.env.NIA_TODO_FRONTEND_DB_SHARED === '1';
}

function removeTransientFrontendState() {
  fsUnlink(DB_PATH);
  fsRm(ATTACHMENT_DIR);
}

export function beginFrontendDbSuite() {
  fsMkdir(dirname(DB_PATH));
  try { service('stop'); } catch {}
  assertRestorableDevDb(DB_PATH, 'Frontend suite DB backup');
  assertNotFrontendTestOnlyDb(DB_PATH, 'Frontend suite DB backup');
  if (fsExists(DB_SUITE_BACKUP)) {
    throw new Error(`${DB_SUITE_BACKUP} already exists. Refusing to overwrite a possible original DB backup.`);
  }
  if (fsExists(ATTACHMENT_SUITE_BACKUP)) {
    throw new Error(`${ATTACHMENT_SUITE_BACKUP} already exists. Refusing to overwrite a possible original attachment backup.`);
  }
  fsUnlink(DB_BACKUP);
  fsRm(ATTACHMENT_BACKUP);
  fsCopy(DB_PATH, DB_SUITE_BACKUP);
  fsCopy(ATTACHMENT_DIR, ATTACHMENT_SUITE_BACKUP, true);
  removeTransientFrontendState();
}

export function restoreFrontendDbSuite() {
  try { service('stop'); } catch {}
  removeTransientFrontendState();
  fsCopy(DB_SUITE_BACKUP, DB_PATH);
  fsCopy(ATTACHMENT_SUITE_BACKUP, ATTACHMENT_DIR, true);
  assertRestorableDevDb(DB_PATH, 'Frontend suite DB restore');
  assertNotFrontendTestOnlyDb(DB_PATH, 'Frontend suite DB restore');
  fsUnlink(DB_SUITE_BACKUP);
  fsRm(ATTACHMENT_SUITE_BACKUP);
  service('start');
}

export function backupDb() {
  fsMkdir(dirname(DB_PATH));
  if (suiteDbManaged()) {
    try { service('stop'); } catch {}
    removeTransientFrontendState();
    return;
  }
  assertRestorableDevDb(DB_PATH, 'Frontend test DB backup');
  fsUnlink(DB_BACKUP);
  fsMove(DB_PATH, DB_BACKUP);
  fsRm(ATTACHMENT_BACKUP);
  fsMove(ATTACHMENT_DIR, ATTACHMENT_BACKUP);
}

export function restoreDb() {
  try { service('stop'); } catch {}
  if (suiteDbManaged()) {
    removeTransientFrontendState();
    service('start');
    return;
  }
  fsUnlink(DB_PATH);
  fsMove(DB_BACKUP, DB_PATH);
  fsRm(ATTACHMENT_DIR);
  fsMove(ATTACHMENT_BACKUP, ATTACHMENT_DIR);
  assertRestorableDevDb(DB_PATH, 'Frontend test DB restore');
  service('start');
}

export async function prepareFreshDb() {
  try { service('stop'); } catch {}
  if (suiteDbManaged()) {
    removeTransientFrontendState();
  } else {
    backupDb();
  }
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

export async function launchPage({ serviceWorkers = 'block' } = {}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers });
  const page = await context.newPage();
  if (serviceWorkers === 'block') {
    await page.addInitScript(() => {
      const mockRegistration = {
        scope: `${window.location.origin}/`,
        active: null,
        waiting: null,
        installing: null,
        update: async () => undefined,
        unregister: async () => true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      };
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          controller: null,
          ready: Promise.resolve(null),
          register: async () => mockRegistration,
          getRegistrations: async () => [],
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        },
      });
    });
  }
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  if (process.env.NIA_TODO_FRONTEND_ENABLE_WHATS_NEW !== '1') {
    await page.route('**/static/content/whats-new.json', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"releases":[]}',
    }));
  }

  async function dismissWhatsNewIfVisible() {
    const modal = page.locator('#whats-new-modal.active');
    const appeared = await modal.waitFor({ state: 'visible', timeout: 1500 }).then(() => true).catch(() => false);
    if (!appeared) return false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const done = modal.locator('[data-whats-new-action="done"]');
      if (await done.isVisible().catch(() => false)) {
        await done.click();
        await modal.waitFor({ state: 'hidden', timeout: 5000 });
        return true;
      }
      const next = modal.locator('[data-whats-new-action="next"]');
      if (!(await next.isVisible().catch(() => false))) break;
      await next.click();
    }
    throw new Error("What's new modal did not reach the done action");
  }

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
      await page.locator('[data-section-action="show-add"]').click();
      const input = page.locator('#new-section-name');
      await input.waitFor({ state: 'visible' });
      await input.fill(name);
      await page.locator('[data-section-action="save-new"]').click();
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
      await dismissWhatsNewIfVisible();
    },
    dismissWhatsNewIfVisible,
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
  if (sharedSuiteDbManaged()) {
    await waitForService();
    await run();
    return;
  }

  let ok = false;
  try {
    if (suiteDbManaged()) {
      console.log('🧪 Preparing isolated frontend test DB...');
    } else {
      console.log('📦 Backup DB + prepare fresh frontend test DB...');
    }
    await prepareFreshDb();
    await run();
    ok = true;
  } finally {
    if (suiteDbManaged()) {
      console.log('🧹 Cleaning frontend test DB...');
    } else {
      console.log('🔄 Restoring original dev DB...');
    }
    restoreDb();
    if (ok) {
      await waitForService();
    } else {
      await waitForService().catch(() => {});
    }
  }
  if (!ok) process.exit(1);
}

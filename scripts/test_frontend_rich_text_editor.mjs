#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const API_DIR = join(ROOT, 'api');
const PYTHON = process.env.NIA_TODO_APP_PYTHON
  || (existsSync(join(ROOT, '.venv/bin/python3')) ? join(ROOT, '.venv/bin/python3') : null)
  || 'python3';
const ADMIN_PASSWORD = 'RichTextAdmin123!';
const USERNAME = 'richtextuser';
const USER_PASSWORD = 'RichTextUser123!';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for local rich text test server');
}

async function api(baseUrl, method, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function selectContents(locator) {
  await locator.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

async function placeCaretAtEnd(locator) {
  await locator.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

async function exerciseToggle(page, {
  name,
  text,
  buttonSelector,
  formattedSelector,
  formattedMarkdown,
  resetWithCaret = false,
}) {
  const editor = page.locator('#todo-desc-rich-editor');
  await editor.fill(text);
  await selectContents(editor);
  await page.click(buttonSelector);

  const applied = await page.evaluate(({ formattedSelector }) => ({
    hasFormatting: Boolean(document.querySelector(`#todo-desc-rich-editor ${formattedSelector}`)),
    markdown: document.getElementById('todo-desc')?.value || '',
  }), { formattedSelector });
  if (!applied.hasFormatting || applied.markdown !== formattedMarkdown) {
    throw new Error(`${name} formatting setup failed: ${JSON.stringify(applied)}`);
  }

  const formatted = page.locator(`#todo-desc-rich-editor ${formattedSelector}`);
  if (resetWithCaret) await placeCaretAtEnd(formatted);
  else await selectContents(formatted);
  await page.click(buttonSelector);

  return page.evaluate(({ formattedSelector }) => ({
    hasFormatting: Boolean(document.querySelector(`#todo-desc-rich-editor ${formattedSelector}`)),
    markdown: document.getElementById('todo-desc')?.value || '',
  }), { formattedSelector });
}

async function run() {
  console.log('🌐 Running rich text editor toggle regression test...');
  const dataDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'nia-todo-rich-text-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverOutput = [];
  const server = spawn(PYTHON, ['run_server.py'], {
    cwd: API_DIR,
    env: {
      ...process.env,
      NIA_TODO_DATA_DIR: dataDir,
      NIA_TODO_DB: 'rich-text-test.db',
      NIA_TODO_HOST: '127.0.0.1',
      NIA_TODO_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => serverOutput.push(chunk.toString()));
  server.stderr.on('data', chunk => serverOutput.push(chunk.toString()));

  let browser;
  try {
    await waitFor(async () => (await fetch(`${baseUrl}/api/setup/status`)).ok);
    const setupToken = await waitFor(() => {
      const path = join(dataDir, 'setup-token');
      return existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
    });
    const setupHeaders = { 'X-Setup-Token': setupToken };
    await api(baseUrl, 'POST', '/api/setup/admin', { admin_password: ADMIN_PASSWORD }, setupHeaders);
    await api(baseUrl, 'POST', '/api/setup/first-user', {
      username: USERNAME,
      email: 'richtext@example.invalid',
      password: USER_PASSWORD,
      display_name: 'Rich Text Test User',
    }, setupHeaders);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/static/content/whats-new.json', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"releases":[]}',
    }));

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.fill('#login-username', USERNAME);
    await page.fill('#login-password', USER_PASSWORD);
    await page.click('button.login-btn');
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 15_000 });
    await page.getByRole('button', { name: /Neues Todo|New todo/i }).click();
    await page.locator('#todo-modal').waitFor({ state: 'visible' });
    await page.fill('#todo-title', 'Rich text toggle regression');
    await page.click('#todo-desc-preview');

    const results = {
      codeSelection: await exerciseToggle(page, {
        name: 'Code',
        text: 'Code text',
        buttonSelector: '.todo-desc-rich-toolbar button[data-rich-format="code"]',
        formattedSelector: 'code',
        formattedMarkdown: '`Code text`',
      }),
      codeCaret: await exerciseToggle(page, {
        name: 'Code',
        text: 'Code text',
        buttonSelector: '.todo-desc-rich-toolbar button[data-rich-format="code"]',
        formattedSelector: 'code',
        formattedMarkdown: '`Code text`',
        resetWithCaret: true,
      }),
      quoteSelection: await exerciseToggle(page, {
        name: 'Quote',
        text: 'Quote text',
        buttonSelector: '.todo-desc-rich-toolbar button[data-rich-block="blockquote"]',
        formattedSelector: 'blockquote',
        formattedMarkdown: '> Quote text',
      }),
      quoteCaret: await exerciseToggle(page, {
        name: 'Quote',
        text: 'Quote text',
        buttonSelector: '.todo-desc-rich-toolbar button[data-rich-block="blockquote"]',
        formattedSelector: 'blockquote',
        formattedMarkdown: '> Quote text',
        resetWithCaret: true,
      }),
    };

    const failures = Object.entries(results)
      .filter(([, result]) => result.hasFormatting || result.markdown.includes('`') || result.markdown.startsWith('> '));
    if (failures.length) {
      throw new Error(`Expected Code and Quote toolbar actions to reset formatting: ${JSON.stringify(Object.fromEntries(failures))}`);
    }
    const filteredConsoleErrors = consoleErrors.filter(message => !message.includes('Failed to load resource: the server responded with a status of 404'));
    if (pageErrors.length || filteredConsoleErrors.length) {
      throw new Error(`Frontend emitted errors: page=${JSON.stringify(pageErrors)} console=${JSON.stringify(filteredConsoleErrors)}`);
    }
    console.log('✅ Rich text editor toggle regression test passed');
  } catch (error) {
    if (server.exitCode !== null) {
      error.message += `\nLocal server exited with ${server.exitCode}:\n${serverOutput.join('')}`;
    }
    throw error;
  } finally {
    await browser?.close();
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise(resolve => server.once('exit', resolve));
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await run();

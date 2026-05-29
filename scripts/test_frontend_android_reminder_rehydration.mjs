#!/usr/bin/env node
import { withFreshDb, launchPage, BASE_URL, USERNAME, USER_PASSWORD } from './frontend_test_lib.mjs';

async function loginSession() {
  const response = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: USER_PASSWORD }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Login failed: ${response.status} ${JSON.stringify(data)}`);
  return { token: data.access_token, csrfToken: data.csrf_token };
}

async function createReminderTodo(session, title) {
  const remindAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const response = await fetch(`${BASE_URL}/api/todos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`,
      'X-CSRF-Token': session.csrfToken,
      Cookie: `csrf_token=${session.csrfToken}`,
    },
    body: JSON.stringify({ title, status: 'pending', priority: 2, remind_at: remindAt }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Create reminder todo failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function installAndroidNativeStub(page) {
  await page.addInitScript(({ baseUrl }) => {
    Object.defineProperty(navigator, 'userAgent', {
      get: () => 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
    });
    window.__androidReminderSchedules = [];
    window.NiaAndroidNative = {
      requestNotificationPermission: () => 'granted',
      notificationPermissionState: () => 'granted',
      scheduleReminders: (payload) => {
        const reminders = JSON.parse(payload || '[]');
        window.__androidReminderSchedules.push(reminders);
        localStorage.setItem('__androidReminderSchedules', JSON.stringify(window.__androidReminderSchedules));
        return reminders.length;
      },
      setConfiguredServerUrl: () => true,
    };
    window.__TAURI__ = {
      core: {
        invoke: async (command) => {
          if (command === 'desktop_get_settings') return { serverUrl: baseUrl, notifications: true };
          return null;
        },
      },
    };
  }, { baseUrl: BASE_URL });
}

async function run() {
  console.log('🔔 Running Android reminder rehydration test...');
  const title = 'Existing Android Reminder Todo';
  const session = await loginSession();
  const todo = await createReminderTodo(session, title);
  const { browser, page, dumpErrors, assertNoFrontendErrors } = await launchPage();
  try {
    await installAndroidNativeStub(page);
    await page.goto(`${BASE_URL}?nativeApp=tauri`, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10_000 });
    await page.fill('#login-username', USERNAME);
    await page.fill('#login-password', USER_PASSWORD);
    await page.click('button.login-btn');
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 15_000 });
    await page.waitForFunction(({ id, title }) => {
      const batches = window.__androidReminderSchedules || [];
      return batches.some((batch) => batch.some((reminder) => String(reminder.id) === String(id) && reminder.body === title));
    }, { id: todo.id, title }, { timeout: 10_000 });

    const matchingBatch = await page.evaluate(({ id }) => {
      const batches = window.__androidReminderSchedules || [];
      return batches.find((batch) => batch.some((reminder) => String(reminder.id) === String(id))) || [];
    }, { id: todo.id });
    const scheduled = matchingBatch.find((reminder) => String(reminder.id) === String(todo.id));
    if (!scheduled?.dueAtMs || scheduled.dueAtMs <= Date.now()) {
      throw new Error(`Expected future Android reminder schedule, got ${JSON.stringify(scheduled)}`);
    }
    assertNoFrontendErrors();
    console.log('✅ Android reminder rehydration test passed');
  } catch (error) {
    const debugState = await page.evaluate(() => ({
      schedules: window.__androidReminderSchedules || [],
      text: document.body.innerText.slice(0, 500),
      runtime: window.NIA_TODO_RUNTIME,
      todos: window.todos || null,
      localSchedules: localStorage.getItem('__androidReminderSchedules'),
    })).catch((debugError) => ({ debugError: debugError.message }));
    console.log('DEBUG frontend state:', JSON.stringify(debugState));
    console.log('DEBUG frontend errors:', JSON.stringify(dumpErrors()));
    throw error;
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);

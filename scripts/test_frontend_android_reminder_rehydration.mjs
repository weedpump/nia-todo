#!/usr/bin/env node
import { withFreshDb, launchPage, BASE_URL, USERNAME, USER_PASSWORD, DB_PATH, sqlitePython } from './frontend_test_lib.mjs';

function createExistingReminderTodo(title) {
  const remindAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const script = `
import json, sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)})
conn.row_factory = sqlite3.Row
user = conn.execute("SELECT id FROM users WHERE username = ?", (${JSON.stringify(USERNAME)},)).fetchone()
if not user:
    raise SystemExit("frontend test user missing")
project = conn.execute("SELECT id FROM projects WHERE user_id = ? AND COALESCE(is_inbox, 0) = 1 ORDER BY id LIMIT 1", (user["id"],)).fetchone()
if not project:
    raise SystemExit("frontend test inbox missing")
cur = conn.execute("""INSERT INTO todos
    (title, description, priority, is_pinned, status, project_id, section_id, due_date, completed_at, updated_at, user_id)
    VALUES (?, '', 2, 0, 'pending', ?, NULL, NULL, NULL, datetime('now'), ?)""", (${JSON.stringify(title)}, project["id"], user["id"]))
todo_id = cur.lastrowid
conn.execute("INSERT INTO reminders (todo_id, remind_at, user_id) VALUES (?, ?, ?)", (todo_id, ${JSON.stringify(remindAt)}, user["id"]))
conn.commit()
print(json.dumps({"id": todo_id, "title": ${JSON.stringify(title)}, "remind_at": ${JSON.stringify(remindAt)}}))
`;
  return JSON.parse(sqlitePython(script, { encoding: 'utf8' }));
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
  const todo = createExistingReminderTodo(title);
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

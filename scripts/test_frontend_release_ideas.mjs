#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function authedFetch(page, path, options = {}) {
  return page.evaluate(async ({ path, options }) => {
    const jwt = localStorage.getItem('jwt_token');
    const csrf = localStorage.getItem('csrf_token');
    const headers = { ...(options.headers || {}), Authorization: `Bearer ${jwt}` };
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { ...options, headers, credentials: 'include' });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${options.method || 'GET'} ${path} failed ${res.status}: ${text}`);
    return data;
  }, { path, options });
}

async function run() {
  console.log('🧪 Running next-release feature regression test...');
  const { browser, page, loginApp, openTodoModal, assertNoFrontendErrors } = await launchPage();
  try {
    await loginApp();

    const project = await authedFetch(page, '/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Needle Project', color: '#8b5cf6', icon: 'folder', sort_order: 0 }),
    });
    const section = await authedFetch(page, `/api/sections/by-project/${project.id}`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Needle Section', sort_order: 0 }),
    });

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    nextWeek.setHours(9, 0, 0, 0);

    const laterTodo = await authedFetch(page, '/api/todos', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Needle later task',
        description: 'Search body',
        priority: 3,
        is_pinned: false,
        status: 'pending',
        project_id: project.id,
        section_id: section.id,
        due_date: nextWeek.toISOString(),
      }),
    });
    const soonerTodo = await authedFetch(page, '/api/todos', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Needle sooner task',
        description: 'Search body',
        priority: 3,
        is_pinned: false,
        status: 'pending',
        project_id: project.id,
        section_id: section.id,
        due_date: tomorrow.toISOString(),
      }),
    });
    const duplicateSource = await authedFetch(page, '/api/todos', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Duplicate source task',
        description: 'Clone me',
        priority: 1,
        is_pinned: true,
        status: 'in_progress',
        project_id: project.id,
        section_id: section.id,
        due_date: tomorrow.toISOString(),
        remind_at: tomorrow.toISOString(),
        recurring_rule: { frequency: 'weekly', interval: 1 },
      }),
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#user-menu-button').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => typeof window.renderTodos === 'function' && typeof window.cycleSort === 'function', null, { timeout: 10000 });

    await page.fill('#search-input', 'Needle Project');
    await page.waitForTimeout(150);
    const projectSearchVisible = await page.locator('.todo-item').count();
    if (projectSearchVisible !== 0) throw new Error('Search matched project name, but search must stay todo-only');

    await page.fill('#search-input', 'Needle');
    await page.waitForFunction(() => document.querySelectorAll('.todo-item').length >= 2, null, { timeout: 5000 });
    const searchGroupingText = await page.locator('.todo-group').first().innerText();
    if (!searchGroupingText.includes('Needle Project') || !searchGroupingText.includes('Needle Section')) {
      throw new Error(`Search results were not grouped by project + section: ${searchGroupingText}`);
    }
    const searchContextPills = await page.locator('.todo-search-context').count();
    if (searchContextPills !== 0) throw new Error('Search rendered project/section context pills instead of headings');

    await page.fill('#search-input', '');
    await page.evaluate(() => window.cycleSort());
    await page.waitForTimeout(150);
    const orderedTitles = await page.$$eval('.todo-title', els => els.map(el => el.textContent.trim()));
    const soonerIndex = orderedTitles.indexOf('Needle sooner task');
    const laterIndex = orderedTitles.indexOf('Needle later task');
    if (soonerIndex < 0 || laterIndex < 0 || soonerIndex > laterIndex) {
      throw new Error(`Due-date sort did not place sooner todo first: ${orderedTitles.join(' | ')}`);
    }

    await page.evaluate((id) => window.duplicateTodo(id), duplicateSource.id);
    await page.waitForFunction(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', { headers: { Authorization: `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      return data.todos.filter(todo => todo.title === 'Duplicate source task').length >= 2;
    }, null, { timeout: 10000 });
    const duplicatedTodos = await authedFetch(page, '/api/todos').then(data => data.todos.filter(todo => todo.title === 'Duplicate source task'));
    const clone = duplicatedTodos.find(todo => String(todo.id) !== String(duplicateSource.id));
    if (!clone) throw new Error('Duplicate todo was not created');
    if (clone.status !== 'pending' || clone.completed_at) throw new Error(`Clone status/completed_at wrong: ${JSON.stringify({ status: clone.status, completed_at: clone.completed_at })}`);
    if (!clone.is_pinned || clone.priority !== 1 || String(clone.project_id) !== String(project.id) || String(clone.section_id) !== String(section.id)) {
      throw new Error(`Clone did not preserve pinned/project/section/priority: ${JSON.stringify(clone)}`);
    }
    const cloneReminder = clone.remind_at || clone.reminders?.[0]?.remind_at;
    if (!clone.due_date || !cloneReminder || clone.recurring_rule?.frequency !== 'weekly') {
      throw new Error(`Clone did not preserve schedule/reminder/recurring: ${JSON.stringify(clone)}`);
    }

    await page.evaluate((id) => window.setTodoStatus(id, 'done'), soonerTodo.id);
    await page.waitForFunction(async (id) => {
      const todo = await window.getFromDB('todos', id);
      return Boolean(todo?.completed_at);
    }, soonerTodo.id, { timeout: 5000 });
    await page.evaluate((id) => window.setTodoStatus(id, 'pending'), soonerTodo.id);
    await page.waitForFunction(async (id) => {
      const todo = await window.getFromDB('todos', id);
      return todo && todo.completed_at === null;
    }, soonerTodo.id, { timeout: 5000 });

    await openTodoModal();
    await page.fill('#todo-title', 'Recurring quick tomorrow 10:00 repeat:weekly');
    await page.waitForFunction(() => document.querySelector('#quick-add-preview .quick-add-chip.recurring'), null, { timeout: 5000 });
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', { headers: { Authorization: `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      const todo = data.todos.find(item => item.title === 'Recurring quick');
      return todo?.due_date && todo?.recurring_rule?.frequency === 'weekly';
    }, null, { timeout: 10000 });

    await page.evaluate(async () => window.changeLanguagePreference('de'));
    await openTodoModal();
    await page.fill('#todo-title', 'Wiederkehrend morgen 10:00 wiederholung:wöchentlich');
    await page.waitForFunction(() => document.querySelector('#quick-add-preview .quick-add-chip.recurring'), null, { timeout: 5000 });
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', { headers: { Authorization: `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      const todo = data.todos.find(item => item.title === 'Wiederkehrend');
      return todo?.due_date && todo?.recurring_rule?.frequency === 'weekly';
    }, null, { timeout: 10000 });

    assertNoFrontendErrors();
    console.log('✅ Next-release feature regression test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);

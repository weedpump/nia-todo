#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function run() {
  console.log('⚡ Running frontend quick add inline syntax test...');
  const { browser, page, loginApp, openTodoModal, assertNoFrontendErrors } = await launchPage();

  try {
    await loginApp();
    const created = await page.evaluate(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const csrf = localStorage.getItem('csrf_token');
      const headers = { 'Authorization': `Bearer ${jwt}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
      const project = await fetch('/api/projects', {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify({ name: 'Quick Shopping', color: '#22c55e', icon: 'folder', sort_order: 0 })
      }).then(r => r.json());
      const section = await fetch(`/api/sections/by-project/${project.id}`, {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify({ name: 'Cold Goods', sort_order: 0 })
      }).then(r => r.json());
      return { project, section };
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#user-menu-button').waitFor({ state: 'visible', timeout: 10000 });
    await openTodoModal();
    await page.fill('#todo-title', 'Buy milk tomorrow 18:00 remind:17:30 #QuickShopping /ColdGoods !high');

    await page.waitForFunction(() => {
      const text = document.querySelector('#quick-add-preview')?.innerText || '';
      return ['Deadline', 'Erinnerung', 'Projekt', 'Abschnitt', 'Priorität', 'Due', 'Reminder', 'Project', 'Section', 'Priority']
        .filter(label => text.includes(label)).length >= 5;
    }, null, { timeout: 5000 });

    const chips = await page.$$eval('#quick-add-preview .quick-add-chip', els => els.map(el => ({ cls: el.className, text: el.textContent })));
    for (const cls of ['priority', 'due', 'reminder', 'project', 'section']) {
      if (!chips.some(chip => chip.cls.includes(cls))) throw new Error(`Missing quick add preview chip: ${cls}`);
    }

    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });

    await page.waitForFunction(async ({ projectId, sectionId }) => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      const todo = data.todos.find(item => item.title === 'Buy milk');
      if (!todo) return false;
      if (String(todo.project_id) !== String(projectId)) return false;
      if (String(todo.section_id) !== String(sectionId)) return false;
      if (todo.priority !== 2) return false;
      if (!todo.due_date || !todo.remind_at) return false;
      const due = new Date(todo.due_date);
      const remind = new Date(todo.remind_at);
      return Number.isFinite(due.getTime()) && Number.isFinite(remind.getTime())
        && due.getHours() === 18 && due.getMinutes() === 0
        && remind.getHours() === 17 && remind.getMinutes() === 30;
    }, { projectId: created.project.id, sectionId: created.section.id }, { timeout: 10000 });

    assertNoFrontendErrors();
    console.log('✅ Frontend quick add inline syntax test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);

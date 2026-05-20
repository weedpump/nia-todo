#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function run() {
  console.log('🌐 Running Playwright frontend app test...');
  const { browser, page, visible, clickProjectNav, openTodoModal, ensureSectionOptions, createSection, loginApp, assertNoFrontendErrors } = await launchPage();

  try {
    await loginApp();

    await page.click('button[onclick="showProjectModal()"]');
    await page.fill('#project-name', 'Frontend Project A');
    await page.fill('#project-color', '#ff8800');
    await page.click('button[form="project-form"]');
    await page.locator('#project-modal').waitFor({ state: 'hidden', timeout: 5000 });

    await page.click('button[onclick="showProjectModal()"]');
    await page.fill('#project-name', 'Frontend Project B');
    await page.fill('#project-color', '#00aa88');
    await page.click('button[form="project-form"]');
    await page.locator('#project-modal').waitFor({ state: 'hidden', timeout: 5000 });

    await clickProjectNav('Frontend Project A');
    await createSection('Section A');
    await createSection('Section B');

    await page.evaluate(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const csrf = localStorage.getItem('csrf_token');
      const projects = await fetch('/api/projects', {
        headers: { 'Authorization': `Bearer ${jwt}` },
        credentials: 'include'
      }).then(r => r.json());
      const projectB = projects.projects.find(p => p.name === 'Frontend Project B');
      await fetch(`/api/sections/by-project/${projectB.id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
          'X-CSRF-Token': csrf
        },
        body: JSON.stringify({ name: 'Project B Only Section', sort_order: 0 }),
        credentials: 'include'
      });
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 10000 });
    await page.locator('.nav-btn.active').filter({ hasText: 'Frontend Project A' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('Section A', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('Section B', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const foreignSectionVisibleAfterReload = await page.getByText('Project B Only Section', { exact: true }).isVisible().catch(() => false);
    if (foreignSectionVisibleAfterReload) throw new Error('Reloaded project view must not show sections from other projects');

    await openTodoModal();
    await page.fill('#todo-title', 'Section Todo');
    await page.selectOption('#todo-status', 'in_progress');
    await page.selectOption('#todo-project', { label: 'Frontend Project A' });
    await ensureSectionOptions(['Section A', 'Section B']);
    await page.selectOption('#todo-section', { label: 'Section A' });
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      return data.todos.some(todo => todo.title === 'Section Todo' && todo.status === 'in_progress');
    }, null, { timeout: 10000 });

    const sectionHeaderA = page.locator('.section-header').filter({ hasText: 'Section A' }).first();
    await sectionHeaderA.locator('.section-name').click();
    const renameInput = page.locator('input[id^="edit-section-name-"]');
    await renameInput.first().fill('Section A Renamed');
    await renameInput.first().press('Enter');
    await page.getByText('Section A Renamed', { exact: true }).waitFor({ state: 'visible' });

    await openTodoModal();
    await page.fill('#todo-title', 'Project Switch Todo');
    await page.selectOption('#todo-project', { label: 'Frontend Project A' });
    await ensureSectionOptions(['Section A Renamed', 'Section B']);
    await page.selectOption('#todo-project', { label: 'Frontend Project B' });
    await ensureSectionOptions(['Keine Section'], { disabled: false });
    await page.selectOption('#todo-project', { label: 'Frontend Project A' });
    await ensureSectionOptions(['Section A Renamed', 'Section B']);
    await page.selectOption('#todo-section', { label: 'Section B' });
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });

    const deleteSectionButton = page.locator('.section-header').filter({ hasText: 'Section A Renamed' }).first().locator('.section-delete');
    await deleteSectionButton.click();
    await page.waitForFunction(() => {
      const sectionNames = Array.from(document.querySelectorAll('.section-header .section-name')).map(el => el.textContent || '');
      return !sectionNames.some(name => name.includes('Section A Renamed')) && document.body.innerText.includes('Section Todo');
    }, { timeout: 10000 });

    const switchTodoTitle = page.locator('.todo-item .todo-title').filter({ hasText: 'Project Switch Todo' }).first();
    await switchTodoTitle.click();
    await visible('#todo-modal');
    await page.selectOption('#todo-section', { label: 'Keine Section (Unsortiert)' });
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });

    const sectionTodoTitle = page.locator('.todo-item .todo-title').filter({ hasText: 'Section Todo' }).first();
    await sectionTodoTitle.click();
    await visible('#todo-modal');
    await page.fill('#todo-title', 'Section Todo Edited');
    await page.fill('#todo-desc', 'Beschreibung aktualisiert');
    await page.selectOption('#todo-priority', '1');
    await page.selectOption('#todo-status', 'in_progress');
    await page.selectOption('#todo-project', { label: 'Frontend Project B' });
    await ensureSectionOptions(['Keine Section'], { disabled: false });
    await page.fill('#todo-due', '2026-05-21T10:30');
    await page.fill('#todo-remind', '2026-05-21T09:45');
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });

    await page.locator('.nav-btn[data-filter="all"]').click();
    await page.waitForFunction(() => document.body.innerText.includes('Section Todo Edited'), { timeout: 10000 });

    await page.locator('.nav-btn[data-filter="in_progress"]').click();
    await page.waitForFunction(() => document.body.innerText.includes('Section Todo Edited'), { timeout: 10000 });
    await page.locator('.nav-btn[data-filter="all"]').click();

    await page.click('#user-menu-button');
    await page.click('#toggle-done-btn');
    await page.click('#sort-toggle-btn');
    await page.click('#sort-toggle-btn');
    await page.keyboard.press('Escape');

    await page.locator('.todo-item .todo-title').filter({ hasText: 'Section Todo Edited' }).first().click();
    await visible('#todo-modal');
    await page.selectOption('#todo-status', 'done');
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.locator('.nav-btn[data-filter="done"]').click();
    await page.waitForFunction(() => document.body.innerText.includes('Section Todo Edited'), { timeout: 10000 });

    await page.locator('.todo-item .todo-title').filter({ hasText: 'Section Todo Edited' }).first().click();
    await visible('#todo-modal');
    await page.evaluate(() => {
      const remind = document.getElementById('todo-remind');
      remind.setCustomValidity('Ungültige Test-Erinnerung');
    });
    await page.click('button[form="todo-form"]');
    await page.getByText('Erinnerung ist ungültig').waitFor({ state: 'visible', timeout: 5000 });
    await page.evaluate(() => {
      const remind = document.getElementById('todo-remind');
      remind.setCustomValidity('');
    });
    await page.waitForFunction(() => {
      const title = document.getElementById('todo-title')?.value;
      const desc = document.getElementById('todo-desc')?.value;
      const priority = document.getElementById('todo-priority')?.value;
      const status = document.getElementById('todo-status')?.value;
      const project = document.getElementById('todo-project')?.selectedOptions?.[0]?.textContent || '';
      const due = document.getElementById('todo-due')?.value;
      const remind = document.getElementById('todo-remind')?.value;
      return title === 'Section Todo Edited'
        && desc === 'Beschreibung aktualisiert'
        && priority === '1'
        && status === 'done'
        && project.includes('Frontend Project B')
        && due.startsWith('2026-05-21T10:30')
        && remind.startsWith('2026-05-21T09:45');
    }, { timeout: 10000 });
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });

    await page.evaluate(() => {
      const original = window.toggleTodo;
      window.__tempPathPageError = null;
      window.addEventListener('error', event => {
        if (String(event.message || '').includes('temp is not defined')) {
          window.__tempPathPageError = event.message;
        }
      }, { once: true });
      window.toggleTodo = async function patchedToggleTodo(id) {
        const temp = 'regression-guard';
        return original(id);
      };
    });

    await page.locator('.todo-check').first().click();
    await page.waitForTimeout(300);
    await page.waitForFunction(() => !window.__tempPathPageError, { timeout: 1000 });
    await page.getByText('Todo wiedereröffnet').waitFor({ state: 'visible', timeout: 5000 });
    await page.click('#toast-undo');
    await page.waitForFunction(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      return data.todos.some(todo => todo.title === 'Section Todo Edited' && todo.status === 'done');
    }, null, { timeout: 10000 });

    assertNoFrontendErrors();
    console.log('✅ Frontend app test passed');
  } finally {
    await page.screenshot({ path: '/tmp/nia-todo-frontend-app.png', fullPage: true }).catch(() => {});
    await browser.close();
  }
}

await withFreshDb(run);

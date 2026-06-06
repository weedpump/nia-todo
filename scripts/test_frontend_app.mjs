#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function run() {
  console.log('🌐 Running Playwright frontend app test...');
  const { browser, page, visible, clickProjectNav, openTodoModal, ensureSectionOptions, createSection, loginApp, assertNoFrontendErrors } = await launchPage();

  try {
    await loginApp();

    const initialDueTodayCount = await page.evaluate(() => Number(document.querySelector('.overview-focus-item strong')?.textContent || 0));
    await page.evaluate(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const csrf = localStorage.getItem('csrf_token');
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt}`,
        'X-CSRF-Token': csrf,
      };
      const localIsoMinute = (date) => {
        const pad = (value) => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
      };
      const todayPast = new Date();
      todayPast.setHours(0, 5, 0, 0);
      const todayFuture = new Date();
      todayFuture.setHours(23, 55, 0, 0);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      for (const todo of [
        { title: 'Dashboard today overdue regression', due_date: localIsoMinute(todayPast) },
        { title: 'Dashboard today future regression', due_date: localIsoMinute(todayFuture) },
        { title: 'Dashboard tomorrow regression', due_date: localIsoMinute(tomorrow) },
        { title: 'Reminder-only today focus regression', remind_at: localIsoMinute(todayFuture) },
        { title: 'Reminder-only tomorrow focus regression', remind_at: localIsoMinute(tomorrow) },
      ]) {
        const response = await fetch('/api/todos', {
          method: 'POST',
          headers,
          body: JSON.stringify({ description: '', priority: 3, status: 'pending', ...todo }),
          credentials: 'include',
        });
        if (!response.ok) throw new Error(`Create dashboard regression todo failed: ${response.status} ${await response.text()}`);
      }
      await window.refreshFromServer?.();
    });
    await page.waitForFunction((expected) => Number(document.querySelector('.overview-focus-item strong')?.textContent || 0) === expected, initialDueTodayCount + 2, { timeout: 10000 });

    await page.locator('.nav-btn[data-filter="focus"]').click();
    await page.evaluate(() => window.setFocusDueMode?.('today'));
    await page.fill('#search-input', 'Reminder-only today focus regression');
    await page.getByText('Reminder-only today focus regression', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await page.fill('#search-input', 'Reminder-only tomorrow focus regression');
    await page.waitForFunction(() => !document.body.innerText.includes('Reminder-only tomorrow focus regression'), null, { timeout: 5000 });
    await page.fill('#search-input', '');
    await page.evaluate(() => window.resetFocusFilters?.());

    await page.locator('.nav-btn[data-filter="all"]').click();
    await page.locator('#today-focus-btn').click();
    await page.fill('#search-input', 'Reminder-only today focus regression');
    await page.getByText('Reminder-only today focus regression', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await page.fill('#search-input', 'Reminder-only tomorrow focus regression');
    await page.waitForFunction(() => !document.body.innerText.includes('Reminder-only tomorrow focus regression'), null, { timeout: 5000 });
    await page.fill('#search-input', '');
    await page.locator('#today-focus-btn').click();

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
      const authHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt}`,
        'X-CSRF-Token': csrf,
      };
      const projects = await fetch('/api/projects', {
        headers: { 'Authorization': `Bearer ${jwt}` },
        credentials: 'include'
      }).then(r => r.json());
      const projectB = projects.projects.find(p => p.name === 'Frontend Project B');
      const sectionB = await fetch(`/api/sections/by-project/${projectB.id}`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ name: 'Project B Only Section', sort_order: 0 }),
        credentials: 'include'
      }).then(r => r.json());
      const createdTodo = await fetch('/api/todos', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          title: 'Cross Project Section Todo',
          description: '',
          priority: 3,
          status: 'pending',
          project_id: projectB.id,
          section_id: sectionB.id,
        }),
        credentials: 'include'
      }).then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(`Create cross-project todo failed: ${r.status} ${JSON.stringify(data)}`);
        return data;
      });
      window.__crossProjectTodoId = createdTodo.id;
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 10000 });
    await page.locator('.nav-btn.active').filter({ hasText: 'Frontend Project A' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('Section A', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('Section B', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const foreignSectionVisibleAfterReload = await page.getByText('Project B Only Section', { exact: true }).isVisible().catch(() => false);
    if (foreignSectionVisibleAfterReload) throw new Error('Reloaded project view must not show sections from other projects');

    await page.evaluate(async () => {
      await window.refreshFromServer?.();
    });
    await page.locator('.nav-btn[data-filter="all"]').click();
    const crossProjectTodoId = await page.evaluate(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      const todo = data.todos.find(t => t.title === 'Cross Project Section Todo');
      if (!todo) throw new Error('Cross-project section todo was not created');
      return todo.id;
    });
    await page.evaluate(id => window.editTodo(id), crossProjectTodoId);
    await visible('#todo-modal');
    await page.waitForFunction(() => {
      const project = document.getElementById('todo-project')?.selectedOptions?.[0]?.textContent || '';
      const section = document.getElementById('todo-section');
      const sectionText = section?.selectedOptions?.[0]?.textContent || '';
      return project.includes('Frontend Project B')
        && !section?.disabled
        && sectionText.includes('Project B Only Section');
    }, { timeout: 10000 });
    await page.fill('#todo-desc', 'Section bleibt beim Speichern erhalten');
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      const todo = data.todos.find(t => t.title === 'Cross Project Section Todo');
      return todo?.section_name === 'Project B Only Section';
    }, null, { timeout: 10000 });
    await clickProjectNav('Frontend Project A');

    await page.evaluate(() => {
      window.__originalFetchForSectionsFallback = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input?.url || '';
        if (url.includes('/api/sections/by-project/')) return Promise.reject(new Error('simulated sections outage'));
        return window.__originalFetchForSectionsFallback(input, init);
      };
    });
    await openTodoModal();
    await page.fill('#todo-title', 'Offline-ish section cache fallback');
    await page.selectOption('#todo-project', { label: 'Frontend Project A' });
    await ensureSectionOptions(['Section A', 'Section B']);
    await page.evaluate(() => {
      window.closeModal?.('todo-modal');
      if (window.__originalFetchForSectionsFallback) window.fetch = window.__originalFetchForSectionsFallback;
      delete window.__originalFetchForSectionsFallback;
    });

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

    await openTodoModal();
    await page.fill('#todo-title', 'Delete Shortcut Todo');
    await page.selectOption('#todo-project', { label: 'Frontend Project A' });
    await ensureSectionOptions(['Section A Renamed', 'Section B']);
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction(() => document.body.innerText.includes('Delete Shortcut Todo'), { timeout: 10000 });
    await page.evaluate(() => {
      const titleEl = Array.from(document.querySelectorAll('.todo-title')).find(el => (el.textContent || '').includes('Delete Shortcut Todo'));
      const item = titleEl?.closest('.todo-item');
      if (!item) throw new Error('Delete Shortcut Todo item missing');
      item.dispatchEvent(new PointerEvent('pointerover', { pointerId: 91, pointerType: 'mouse', isPrimary: true, bubbles: true }));
    });
    await page.keyboard.press('Delete');
    await visible('#confirm-modal');
    await page.waitForFunction(() => document.activeElement?.id === 'confirm-confirm-btn', { timeout: 5000 });
    await page.keyboard.press('Enter');
    await page.locator('#confirm-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      return !data.todos.some(todo => todo.title === 'Delete Shortcut Todo');
    }, null, { timeout: 10000 });

    const deleteSectionButton = page.locator('.section-header').filter({ hasText: 'Section A Renamed' }).first().locator('.section-delete');
    await deleteSectionButton.click();
    await visible('#confirm-modal');
    await page.click('#confirm-confirm-btn');
    await page.waitForFunction(() => {
      const sectionNames = Array.from(document.querySelectorAll('.section-header .section-name')).map(el => el.textContent || '');
      return !sectionNames.some(name => name.includes('Section A Renamed')) && document.body.innerText.includes('Section Todo');
    }, { timeout: 10000 });

    const switchTodoTitle = page.locator('.todo-item .todo-title').filter({ hasText: 'Project Switch Todo' }).first();
    await switchTodoTitle.click();
    await visible('#todo-modal');
    await page.selectOption('#todo-section', { value: '' });
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

    await page.setViewportSize({ width: 390, height: 844 });
    const swipeTodoByTitle = async (title, dx, startRatio = 0.5) => {
      await page.evaluate(({ title, dx, startRatio }) => {
        const titleEl = Array.from(document.querySelectorAll('.todo-title')).find(el => (el.textContent || '').includes(title));
        const item = titleEl?.closest('.todo-item');
        if (!item) throw new Error(`Todo item not found for swipe test: ${title}`);
        const rect = item.getBoundingClientRect();
        const startX = rect.left + rect.width * startRatio;
        const startY = rect.top + rect.height / 2;
        const pointer = { pointerId: 77, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true };
        item.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, clientX: startX, clientY: startY }));
        document.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: startX + dx, clientY: startY + 2 }));
        document.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientX: startX + dx, clientY: startY + 2 }));
      }, { title, dx, startRatio });
    };
    await swipeTodoByTitle('Project Switch Todo', 140);
    await page.waitForFunction(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      return data.todos.some(todo => todo.title === 'Project Switch Todo' && todo.status === 'in_progress');
    }, null, { timeout: 10000 });
    await page.evaluate(() => window.setFilter?.('in_progress'));
    await page.waitForFunction(() => document.body.innerText.includes('Project Switch Todo'), { timeout: 10000 });
    await swipeTodoByTitle('Project Switch Todo', 140);
    await page.waitForFunction(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      return data.todos.some(todo => todo.title === 'Project Switch Todo' && todo.status === 'pending');
    }, null, { timeout: 10000 });
    await page.evaluate(() => window.setFilter?.('all'));
    await page.waitForFunction(() => document.body.innerText.includes('Project Switch Todo'), { timeout: 10000 });
    await swipeTodoByTitle('Project Switch Todo', 140, 0.04);
    await page.waitForFunction(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      return data.todos.some(todo => todo.title === 'Project Switch Todo' && todo.status === 'pending');
    }, null, { timeout: 10000 });
    await swipeTodoByTitle('Project Switch Todo', -140);
    await page.waitForFunction(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      return data.todos.some(todo => todo.title === 'Project Switch Todo' && todo.status === 'done');
    }, null, { timeout: 10000 });
    await page.evaluate(() => window.setFilter?.('done'));
    await page.waitForFunction(() => document.body.innerText.includes('Project Switch Todo'), { timeout: 10000 });
    await swipeTodoByTitle('Project Switch Todo', -140);
    await page.waitForFunction(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      return data.todos.some(todo => todo.title === 'Project Switch Todo' && todo.status === 'pending');
    }, null, { timeout: 10000 });
    await page.evaluate(() => window.setFilter?.('all'));
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(500);

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
    await page.getByText(/Erinnerung ist ungültig|Reminder is invalid/).waitFor({ state: 'visible', timeout: 5000 });
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
    await page.getByText(/Todo wiedereröffnet|Todo reopened/).waitFor({ state: 'visible', timeout: 5000 });
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

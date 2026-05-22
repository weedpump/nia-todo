#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function run() {
  console.log('🌐 Running Playwright frontend smoke test...');
  const { browser, page, visible, waitForText, clickProjectNav, openTodoModal, ensureSectionOptions, createSection, loginApp, assertNoFrontendErrors, dumpErrors } = await launchPage();

  try {
    await loginApp();

    await visible('#sidebar');
    await waitForText('Inbox');
    await page.waitForFunction(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('nia-todo-db', 4);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        return await new Promise(resolve => {
          const tx = db.transaction('projects', 'readonly');
          const countReq = tx.objectStore('projects').count();
          countReq.onsuccess = () => resolve(countReq.result > 0);
          countReq.onerror = () => resolve(false);
        });
      } finally {
        db.close();
      }
    }, null, { timeout: 10000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 10000 });
    await visible('#sidebar');
    await waitForText('Inbox');

    await page.click('#user-menu-button');
    await page.click('#theme-toggle-btn');
    await page.click('#theme-toggle-btn');
    await page.keyboard.press('Escape');
    await page.locator('#web-update-modal').waitFor({ state: 'attached' });
    await page.locator('#web-update-apply-btn').waitFor({ state: 'attached' });

    await page.click('button[onclick="showProjectModal()"]');
    await page.fill('#project-name', 'Frontend Smoke Project');
    await page.fill('#project-color', '#ff8800');
    await page.click('button[form="project-form"]');
    await page.locator('#project-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await waitForText('Frontend Smoke Project');

    await clickProjectNav('Frontend Smoke Project');
    await createSection('Frontend Section A');
    await createSection('Frontend Section B');

    await openTodoModal();
    await page.fill('#todo-title', 'Frontend Smoke Todo');
    await page.fill('#todo-desc', '**Smoke** test via Playwright');
    await page.selectOption('#todo-project', { label: 'Frontend Smoke Project' });
    await ensureSectionOptions(['Keine Section', 'Frontend Section A', 'Frontend Section B']);
    await page.selectOption('#todo-section', { label: 'Frontend Section A' });
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await waitForText('Frontend Smoke Todo');

    const todoItem = page.locator('.todo-item').filter({ hasText: 'Frontend Smoke Todo' }).first();

    await page.fill('#search-input', 'Smoke Todo');
    await waitForText('Frontend Smoke Todo');
    await page.fill('#search-input', '');

    await todoItem.click();
    await visible('#todo-modal');
    await page.click('button[onclick="deleteTodoFromModal()"]');
    await page.waitForTimeout(800);
    await page.click('#toast-undo');
    await clickProjectNav('Frontend Smoke Project');
    await waitForText('Frontend Smoke Todo');

    assertNoFrontendErrors();
    console.log('✅ Frontend smoke test passed');
  } finally {
    const errs = dumpErrors();
    if (errs.pageErrors.length || errs.consoleErrors.length) {
      console.log('DEBUG frontend errors:', JSON.stringify(errs));
    }
    await page.screenshot({ path: '/tmp/nia-todo-frontend-smoke.png', fullPage: true }).catch(() => {});
    await browser.close();
  }
}

await withFreshDb(run);

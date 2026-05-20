#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function run() {
  console.log('🌐 Running Playwright frontend smoke test...');
  const { browser, page, visible, waitForText, clickProjectNav, openTodoModal, ensureSectionOptions, createSection, loginApp, assertNoFrontendErrors, dumpErrors } = await launchPage();

  try {
    await loginApp();

    await visible('#sidebar');
    await visible('#sidebar');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 10000 });
    await visible('#sidebar');

    await page.click('#theme-toggle-btn');
    await page.click('#theme-toggle-btn');
    await page.locator('#update-btn').waitFor({ state: 'attached' });

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

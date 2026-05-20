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

    await openTodoModal();
    await page.fill('#todo-title', 'Section Todo');
    await page.selectOption('#todo-project', { label: 'Frontend Project A' });
    await ensureSectionOptions(['Section A', 'Section B']);
    await page.selectOption('#todo-section', { label: 'Section A' });
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });

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

    const todoTitle = page.locator('.todo-item .todo-title').filter({ hasText: 'Project Switch Todo' }).first();
    await todoTitle.click();
    await visible('#todo-modal');
    await page.selectOption('#todo-section', { label: 'Keine Section (Unsortiert)' });
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });

    await page.locator('.nav-btn[data-filter="pending"]').click();
    await page.locator('.nav-btn[data-filter="all"]').click();
    await page.click('#toggle-done-btn');
    await page.click('#sort-toggle-btn');
    await page.click('#sort-toggle-btn');

    assertNoFrontendErrors();
    console.log('✅ Frontend app test passed');
  } finally {
    await page.screenshot({ path: '/tmp/nia-todo-frontend-app.png', fullPage: true }).catch(() => {});
    await browser.close();
  }
}

await withFreshDb(run);

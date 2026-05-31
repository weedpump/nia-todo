#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function run() {
  console.log('🔽 Running shared UI dropdown primitive test...');
  const { browser, page, openTodoModal, loginApp, assertNoFrontendErrors } = await launchPage();
  try {
    await loginApp();
    await openTodoModal();

    const hiddenNative = await page.evaluate(() => {
      const ids = ['todo-priority', 'todo-status', 'todo-project', 'todo-section'];
      return ids.every((id) => {
        const select = document.getElementById(id);
        const rect = select?.getBoundingClientRect();
        return select?.classList.contains('visually-hidden-native-select') && rect && rect.width <= 1 && rect.height <= 1;
      });
    });
    if (!hiddenNative) throw new Error('Todo modal native selects are still visible');

    const priority = page.locator('.ui-select[data-select-id="todo-priority"] .ui-select-trigger');
    await priority.scrollIntoViewIfNeeded();
    await priority.click();
    await page.locator('.ui-select-menu').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#todo-title').click();
    await page.locator('.ui-select-menu').waitFor({ state: 'hidden', timeout: 5000 });

    await priority.click();
    await page.locator('.ui-select-menu').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('.ui-select-option').filter({ hasText: /Sehr hoch|Very high/i }).click();
    const priorityValue = await page.locator('#todo-priority').evaluate((el) => el.value);
    if (priorityValue !== '1') throw new Error(`Priority native value did not sync, got ${priorityValue}`);

    const status = page.locator('.ui-select[data-select-id="todo-status"] .ui-select-trigger');
    await status.focus();
    await page.keyboard.press('Enter');
    await page.locator('.ui-select-menu').waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const statusValue = await page.locator('#todo-status').evaluate((el) => el.value);
    if (statusValue !== 'in_progress') throw new Error(`Keyboard status selection did not sync, got ${statusValue}`);

    await status.click();
    await page.locator('.ui-select-menu').waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.locator('.ui-select-menu').waitFor({ state: 'hidden', timeout: 5000 });

    await page.evaluate(() => window.closeModal?.('todo-modal'));
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.setViewportSize({ width: 390, height: 844 });
    await openTodoModal();
    const projectTrigger = page.locator('.ui-select[data-select-id="todo-project"] .ui-select-trigger');
    await page.evaluate(() => document.querySelector('.ui-select[data-select-id="todo-project"] .ui-select-trigger')?.scrollIntoView({ block: 'center' }));
    await projectTrigger.click();
    await page.locator('.ui-select-menu').waitFor({ state: 'visible', timeout: 5000 });
    const overflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth + 1);
    if (overflow) throw new Error('Mobile dropdown caused horizontal overflow');

    assertNoFrontendErrors();
    console.log('✅ Shared UI dropdown primitive test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);

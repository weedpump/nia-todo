#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function waitForTodoStatus(page, title, status) {
  await page.waitForFunction(async ({ title, status }) => {
    const jwt = localStorage.getItem('jwt_token');
    const data = await fetch('/api/todos', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
    return data.todos.some(todo => todo.title === title && todo.status === status);
  }, { title, status }, { timeout: 10000 });
}

async function run() {
  console.log('⌨️ Running frontend todo quick status test...');
  const { browser, page, visible, loginApp, openTodoModal, assertNoFrontendErrors } = await launchPage();
  const title = 'Quick Status Todo';

  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await loginApp();
    await openTodoModal();
    await page.fill('#todo-title', title);
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction((value) => document.body.innerText.includes(value), title, { timeout: 10000 });

    await page.waitForFunction((value) => {
      return Array.from(document.querySelectorAll('.todo-item'))
        .some(el => (el.textContent || '').includes(value) && el.getBoundingClientRect().height > 0);
    }, title, { timeout: 5000 });
    await page.waitForTimeout(250);
    const item = page.locator('.todo-item').filter({ hasText: title }).last();
    await item.waitFor({ state: 'visible', timeout: 5000 });
    const heightBeforeHover = await item.evaluate(el => el.getBoundingClientRect().height);
    await item.hover();
    const heightAfterHover = await item.evaluate(el => el.getBoundingClientRect().height);
    if (Math.abs(heightAfterHover - heightBeforeHover) > 0.5) {
      throw new Error(`Todo hover changed row height from ${heightBeforeHover} to ${heightAfterHover}`);
    }
    const statusMenu = item.locator('.todo-status-menu');
    await statusMenu.waitFor({ state: 'visible', timeout: 5000 });
    await statusMenu.locator('summary').click();
    const menuZIndex = await item.evaluate((el) => Number(getComputedStyle(el).zIndex) || 0);
    const topbarZIndex = await page.locator('.topbar').evaluate((el) => Number(getComputedStyle(el).zIndex) || 0);
    if (menuZIndex <= topbarZIndex) {
      throw new Error(`Open todo status menu z-index ${menuZIndex} must be above topbar ${topbarZIndex}`);
    }
    await statusMenu.locator('.todo-status-options button').filter({ hasText: /In Arbeit|In progress/i }).click();
    await waitForTodoStatus(page, title, 'in_progress');

    await item.hover();
    await page.keyboard.press('Space');
    await waitForTodoStatus(page, title, 'done');

    await page.evaluate(() => {
      document.body.focus();
      window.setFilter?.('done');
    });
    await page.waitForFunction((value) => document.body.innerText.includes(value), title, { timeout: 10000 });
    await item.hover();
    await page.keyboard.press('Space');
    await waitForTodoStatus(page, title, 'pending');

    assertNoFrontendErrors();
    console.log('✅ Frontend todo quick status test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);

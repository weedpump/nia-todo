#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

const NEW_TODO_BADGE_TARGETS = [
  'todo-project',
  'todo-section',
  'todo-priority',
  'todo-status',
  'todo-due',
  'todo-remind',
  'todo-location-place',
  'todo-recurring-frequency',
  'todo-pinned',
];

async function closeMetaDrawer(page) {
  const modal = page.locator('#todo-modal');
  if (await modal.evaluate(element => element.classList.contains('todo-meta-editing'))) {
    await page.locator('#todo-meta-edit-toggle').evaluate(element => element.click());
  }
  await page.waitForFunction(() => !document.getElementById('todo-modal')?.classList.contains('todo-meta-editing'));
}

async function closeTodoModal(page) {
  await page.evaluate(() => window.closeModal?.('todo-modal'));
  await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
}

async function clickBadgeAndExpectSelect(page, targetId) {
  await page.locator(`.todo-meta-summary-chip[data-meta-edit-target="${targetId}"]`).click();
  await page.waitForFunction((id) => {
    const modal = document.getElementById('todo-modal');
    const select = document.getElementById(id);
    const trigger = select?.nextElementSibling?.querySelector('.ui-select-trigger');
    const search = document.querySelector(`#${id}-ui-menu .ui-select-search-input`);
    const hasExpectedFocus = id === 'todo-project'
      ? document.activeElement === trigger || document.activeElement === search
      : document.activeElement === trigger;
    return modal?.classList.contains('todo-meta-editing')
      && trigger?.getAttribute('aria-expanded') === 'true'
      && hasExpectedFocus;
  }, targetId);
}

async function dismissSelectAndDrawer(page) {
  await page.keyboard.press('Escape');
  await page.locator('.todo-meta-drawer-close').evaluate(element => element.click());
  await page.waitForFunction(() => !document.getElementById('todo-modal')?.classList.contains('todo-meta-editing'));
}

async function clickBadgeAndExpectInput(page, targetId) {
  await page.locator(`.todo-meta-summary-chip[data-meta-edit-target="${targetId}"]`).click();
  await page.waitForFunction((id) => {
    const modal = document.getElementById('todo-modal');
    return modal?.classList.contains('todo-meta-editing') && document.activeElement === document.getElementById(id);
  }, targetId);
}

async function run() {
  console.log('🏷️ Running todo metadata badge editing test...');
  const { browser, page, loginApp, openTodoModal, assertNoFrontendErrors } = await launchPage();
  const title = 'Clickable metadata badges';
  const disabledLocationTitle = 'Disabled legacy location reminder';
  const address = 'Musterstraße 12, 12345 Musterstadt';

  try {
    await loginApp();
    await openTodoModal();
    await closeMetaDrawer(page);

    for (const targetId of NEW_TODO_BADGE_TARGETS) {
      const badge = page.locator(`.todo-meta-summary-chip[data-meta-edit-target="${targetId}"]`);
      if (await badge.count() !== 1) throw new Error(`Missing editable metadata badge for ${targetId} while creating a todo`);
    }
    if (await page.locator('#todo-location-enabled').count() !== 0) {
      throw new Error('Legacy location reminder switch is still rendered');
    }

    await page.locator('#todo-project').evaluate((select) => {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.getElementById('todo-section')?.disabled === true);
    await page.locator('.todo-meta-drawer-close').evaluate(element => element.click());
    if (await page.locator('.todo-meta-summary-chip[data-meta-edit-target="todo-section"]').count() !== 0) {
      throw new Error('Section badge must not be interactive while no project makes the section editor unavailable');
    }
    await closeTodoModal(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await openTodoModal();
    await closeMetaDrawer(page);
    await clickBadgeAndExpectSelect(page, 'todo-status');
    await dismissSelectAndDrawer(page);
    await closeTodoModal(page);
    await page.setViewportSize({ width: 1440, height: 1000 });

    await openTodoModal();
    await closeMetaDrawer(page);
    await page.locator('.todo-meta-summary-chip[data-meta-edit-target="todo-pinned"]').click();
    await page.waitForFunction(() => document.getElementById('todo-pinned')?.checked === true);
    await page.locator('.todo-meta-drawer-close').evaluate(element => element.click());
    const pinnedValue = await page.locator('.todo-meta-summary-chip[data-meta-edit-target="todo-pinned"] strong').textContent();
    if (!pinnedValue?.trim()) throw new Error('Pinned badge did not update after direct toggle');
    await closeTodoModal(page);

    await openTodoModal();
    await page.fill('#todo-title', title);
    await page.fill('#todo-due', '2099-01-03T09:00', { force: true });
    await page.fill('#todo-remind', '2099-01-02T03:04', { force: true });
    await page.selectOption('#todo-recurring-frequency', 'weekly');
    await page.check('#todo-pinned', { force: true });
    await closeMetaDrawer(page);
    await clickBadgeAndExpectSelect(page, 'todo-location-place');
    await page.keyboard.press('Escape');
    await page.locator('#todo-location-address').evaluate((input, value) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, address);
    const enteredAddress = await page.inputValue('#todo-location-address');
    if (enteredAddress !== address) throw new Error(`Location address input did not retain its value: ${JSON.stringify(enteredAddress)}`);
    await page.locator('.todo-meta-drawer-close').evaluate(element => element.click());
    const locationBadge = page.locator('.todo-meta-summary-chip[data-meta-edit-target="todo-location-place"]');
    const locationBadgeText = await locationBadge.innerText();
    if (!locationBadgeText.includes(address)) {
      throw new Error(`Location badge did not update from the current form value before saving: ${JSON.stringify(locationBadgeText)}`);
    }
    await page.locator('button[form="todo-form"]').evaluate(element => element.click());
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 10000 });

    const todoItem = page.locator('.todo-item').filter({ hasText: title }).first();
    await todoItem.click();
    await page.locator('#todo-modal').waitFor({ state: 'visible', timeout: 5000 });
    await closeMetaDrawer(page);

    for (const targetId of ['todo-project', 'todo-section', 'todo-priority', 'todo-status', 'todo-due', 'todo-remind', 'todo-location-place', 'todo-recurring-frequency', 'todo-pinned']) {
      if (await page.locator(`.todo-meta-summary-chip[data-meta-edit-target="${targetId}"]`).count() !== 1) {
        throw new Error(`Expected saved metadata badge ${targetId}`);
      }
    }

    await clickBadgeAndExpectSelect(page, 'todo-location-place');
    await page.keyboard.press('Escape');
    if (await page.inputValue('#todo-location-address') !== address) {
      throw new Error('Existing manual location reminder was not restored into the editor');
    }
    await closeTodoModal(page);

    await todoItem.click();
    await page.locator('#todo-modal').waitFor({ state: 'visible', timeout: 5000 });
    await closeMetaDrawer(page);
    await clickBadgeAndExpectSelect(page, 'todo-project');
    await dismissSelectAndDrawer(page);
    await closeTodoModal(page);

    await todoItem.click();
    await page.locator('#todo-modal').waitFor({ state: 'visible', timeout: 5000 });
    await closeMetaDrawer(page);
    await clickBadgeAndExpectInput(page, 'todo-remind');

    await page.fill('#todo-due', '', { force: true });
    await page.fill('#todo-remind', '', { force: true });
    await page.selectOption('#todo-recurring-frequency', 'none');
    await page.uncheck('#todo-pinned', { force: true });
    await page.locator('#todo-meta-edit-toggle').click();
    await page.waitForFunction(() => !document.getElementById('todo-modal')?.classList.contains('todo-meta-editing'));
    for (const targetId of ['todo-due', 'todo-remind', 'todo-recurring-frequency', 'todo-pinned']) {
      if (await page.locator(`.todo-meta-summary-chip[data-meta-edit-target="${targetId}"]`).count() !== 0) {
        throw new Error(`Cleared optional badge ${targetId} remained visible after closing through the summary toggle`);
      }
    }
    await closeTodoModal(page);

    await page.evaluate(async ({ disabledLocationTitle, address }) => {
      const jwt = localStorage.getItem('jwt_token');
      const csrf = localStorage.getItem('csrf_token');
      const response = await fetch('/api/todos', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          'X-CSRF-Token': csrf,
        },
        credentials: 'include',
        body: JSON.stringify({
          title: disabledLocationTitle,
          description: '',
          priority: 3,
          status: 'pending',
          location_reminder: {
            trigger_type: 'arrival',
            address,
            enabled: false,
          },
        }),
      });
      if (!response.ok) throw new Error(`Creating disabled legacy location reminder failed: ${response.status}`);
      await window.refreshFromServer?.();
    }, { disabledLocationTitle, address });
    const disabledLocationItem = page.locator('.todo-item').filter({ hasText: disabledLocationTitle }).first();
    await disabledLocationItem.waitFor({ state: 'visible', timeout: 10000 });
    await disabledLocationItem.click();
    await page.locator('#todo-modal').waitFor({ state: 'visible', timeout: 5000 });
    await closeMetaDrawer(page);
    if (await page.locator('.todo-meta-summary-chip[data-meta-edit-target="todo-location-place"]').count() !== 0) {
      throw new Error('Disabled legacy location reminder was displayed as active');
    }
    await page.fill('#todo-title', `${disabledLocationTitle} updated`);
    await page.locator('button[form="todo-form"]').click({ force: true });
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 10000 });
    const disabledReminderEnabledValue = await page.evaluate(async (expectedTitle) => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', {
        headers: { Authorization: `Bearer ${jwt}` },
        credentials: 'include',
      }).then(response => response.json());
      const todo = data.todos?.find(item => item.title === expectedTitle);
      const reminder = todo?.location_reminder || todo?.location_reminders?.[0];
      return reminder?.enabled;
    }, `${disabledLocationTitle} updated`);
    if (![false, 0, '0', 'false'].includes(disabledReminderEnabledValue)) {
      throw new Error(`Saving another field reactivated a disabled legacy location reminder: ${JSON.stringify(disabledReminderEnabledValue)}`);
    }

    const updatedDisabledLocationItem = page.locator('.todo-item').filter({ hasText: `${disabledLocationTitle} updated` }).first();
    await updatedDisabledLocationItem.click();
    await page.locator('#todo-modal').waitFor({ state: 'visible', timeout: 5000 });
    await closeMetaDrawer(page);
    await page.locator('#todo-meta-edit-toggle').click();
    await page.fill('#todo-location-address', `${address} geändert`, { force: true });
    await page.locator('#todo-meta-edit-toggle').click();
    const reactivatedLocationBadge = page.locator('.todo-meta-summary-chip[data-meta-edit-target="todo-location-place"]');
    if (await reactivatedLocationBadge.count() !== 1 || !(await reactivatedLocationBadge.innerText()).includes('geändert')) {
      throw new Error('Editing a disabled legacy location reminder did not activate its badge');
    }
    await page.locator('button[form="todo-form"]').click({ force: true });
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 10000 });
    const reactivatedReminderEnabledValue = await page.evaluate(async (expectedTitle) => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/todos', {
        headers: { Authorization: `Bearer ${jwt}` },
        credentials: 'include',
      }).then(response => response.json());
      const todo = data.todos?.find(item => item.title === expectedTitle);
      const reminder = todo?.location_reminder || todo?.location_reminders?.[0];
      return reminder?.enabled;
    }, `${disabledLocationTitle} updated`);
    if (![true, 1, '1', 'true'].includes(reactivatedReminderEnabledValue)) {
      throw new Error(`Editing a disabled legacy location reminder did not enable it: ${JSON.stringify(reactivatedReminderEnabledValue)}`);
    }

    assertNoFrontendErrors();
    console.log('✅ Todo metadata badges open and update their matching editors for new and existing todos');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);

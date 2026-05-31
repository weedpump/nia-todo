#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { withFreshDb, launchPage, BASE_URL, USERNAME, USER_PASSWORD } from './frontend_test_lib.mjs';

async function todoMatches(page, title, expected = {}) {
  return page.evaluate(async ({ title, expected }) => {
    const jwt = localStorage.getItem('jwt_token');
    const data = await fetch('/api/todos', { headers: { Authorization: `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
    return data.todos.some((todo) => {
      if (todo.title !== title) return false;
      if (expected.status && todo.status !== expected.status) return false;
      if (expected.pinned === true && !todo.is_pinned) return false;
      if (expected.pinned === false && todo.is_pinned) return false;
      if (expected.due === true && !todo.due_date) return false;
      return true;
    });
  }, { title, expected });
}

async function waitForTodo(page, title, expected = {}) {
  const deadline = Date.now() + 10000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await todoMatches(page, title, expected)) return;
    } catch (error) {
      lastError = error;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`Todo did not match ${JSON.stringify({ title, expected })}${lastError ? `: ${lastError.message}` : ''}`);
}

async function run() {
  console.log('🤖 Running Android todo gestures test...');
  const androidCapability = JSON.parse(await readFile(new URL('../src-tauri/capabilities/android.json', import.meta.url), 'utf8'));
  if (!androidCapability.permissions.includes('allow-desktop-set-setting')) {
    throw new Error('Android capability must allow desktop_set_setting for native notification toggles');
  }
  const { browser, page, openTodoModal, assertNoFrontendErrors } = await launchPage();
  const title = 'Android Gesture Todo';
  const quickActionTitle = 'Android Quick Action Pin Todo';
  const todoItem = () => page.locator('.todo-item').filter({ hasText: title }).last();

  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgent', {
        get: () => 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
      });
      window.__androidHapticCalls = [];
      window.NiaAndroidNative = {
        hapticFeedback: (pattern) => {
          window.__androidHapticCalls.push(Number(pattern));
          return true;
        },
      };
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE_URL}?nativeApp=tauri`, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10000 });
    await page.fill('#login-username', USERNAME);
    await page.fill('#login-password', USER_PASSWORD);
    await page.click('button.login-btn');
    await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 15000 });

    await openTodoModal();
    await page.fill('#todo-title', title);
    await page.locator('.pin-checkbox-label').click();
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction((value) => document.body.innerText.includes(value), title, { timeout: 10000 });
    await waitForTodo(page, title, { pinned: true });

    await openTodoModal();
    await page.fill('#todo-title', quickActionTitle);
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction((value) => document.body.innerText.includes(value), quickActionTitle, { timeout: 10000 });
    await page.locator('.todo-item').filter({ hasText: quickActionTitle }).last().locator('.todo-pin-btn').click();
    await waitForTodo(page, quickActionTitle, { pinned: true });

    const midSwipe = await page.evaluate((value) => {
      const titleEl = Array.from(document.querySelectorAll('.todo-title')).find(el => (el.textContent || '').includes(value));
      const item = titleEl?.closest('.todo-item');
      if (!item) throw new Error('Todo item missing for Android swipe test');
      const rect = item.getBoundingClientRect();
      const startX = rect.left + rect.width * 0.5;
      const startY = rect.top + rect.height / 2;
      const pointer = { pointerId: 88, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true };
      item.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, clientX: startX, clientY: startY }));
      document.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: startX + 70, clientY: startY + 2 }));
      const transform = getComputedStyle(item).transform;
      const swipeX = item.style.getPropertyValue('--swipe-x');
      const hasTouchFeedback = item.classList.contains('touch-feedback');
      document.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: startX + 220, clientY: startY + 2 }));
      document.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientX: startX + 220, clientY: startY + 2 }));
      return { transform, swipeX, hasTouchFeedback };
    }, title);
    if (!midSwipe.swipeX || midSwipe.transform === 'none' || !midSwipe.transform.includes('70')) {
      throw new Error(`Android swipe did not translate todo item: ${JSON.stringify(midSwipe)}`);
    }
    if (midSwipe.hasTouchFeedback) throw new Error('Android swipe kept touch feedback on todo item');
    await waitForTodo(page, title, { status: 'in_progress' });
    await page.waitForFunction(() => window.__androidHapticCalls?.includes(10), null, { timeout: 5000 });
    await page.waitForTimeout(500);

    await page.setViewportSize({ width: 834, height: 1112 });
    const wideSwipe = await page.evaluate((value) => {
      const titleEl = Array.from(document.querySelectorAll('.todo-title')).find(el => (el.textContent || '').includes(value));
      const item = titleEl?.closest('.todo-item');
      if (!item) throw new Error('Todo item missing for wide swipe test');
      const rect = item.getBoundingClientRect();
      const startX = rect.left + rect.width * 0.5;
      const startY = rect.top + rect.height / 2;
      const pointer = { pointerId: 91, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true };
      item.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, clientX: startX, clientY: startY }));
      document.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: startX + 520, clientY: startY + 2 }));
      const transform = getComputedStyle(item).transform;
      const swipeX = item.style.getPropertyValue('--swipe-x');
      document.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: startX + 4, clientY: startY + 1 }));
      document.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientX: startX + 4, clientY: startY + 1 }));
      return { transform, swipeX, width: rect.width };
    }, title);
    const wideSwipeX = Number.parseFloat(wideSwipe.swipeX);
    if (!wideSwipe.swipeX || wideSwipeX < wideSwipe.width - 4 || !wideSwipe.transform.includes(String(Math.round(wideSwipeX)))) {
      throw new Error(`Wide/iPad-style swipe was still visually clamped: ${JSON.stringify(wideSwipe)}`);
    }
    await todoItem().hover();
    const swipingBeatsHover = await page.evaluate((value) => {
      const titleEl = Array.from(document.querySelectorAll('.todo-title')).find(el => (el.textContent || '').includes(value));
      const item = titleEl?.closest('.todo-item');
      if (!item) throw new Error('Todo item missing for hover cascade test');
      item.classList.add('swiping', 'swipe-right');
      item.style.setProperty('--swipe-x', '240px');
      const transform = getComputedStyle(item).transform;
      item.classList.remove('swiping', 'swipe-right');
      item.style.removeProperty('--swipe-x');
      return transform;
    }, title);
    if (!swipingBeatsHover.includes('240')) throw new Error(`Swipe transform was overridden by hover/focus styling: ${swipingBeatsHover}`);
    await page.setViewportSize({ width: 390, height: 844 });

    const driftResult = await page.evaluate((value) => {
      const titleEl = Array.from(document.querySelectorAll('.todo-title')).find(el => (el.textContent || '').includes(value));
      const item = titleEl?.closest('.todo-item');
      const pin = item?.querySelector('.todo-pin-btn');
      if (!item || !pin) throw new Error('Pin quick-action missing for drift test');
      const rect = pin.getBoundingClientRect();
      const startX = rect.left + rect.width / 2;
      const startY = rect.top + rect.height / 2;
      const pointer = { pointerId: 89, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true };
      pin.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, clientX: startX, clientY: startY }));
      document.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: startX + 28, clientY: startY + 1 }));
      const swiping = item.classList.contains('swiping');
      const swipeX = item.style.getPropertyValue('--swipe-x');
      document.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientX: startX + 28, clientY: startY + 1 }));
      return { swiping, swipeX };
    }, quickActionTitle);
    if (driftResult.swiping || driftResult.swipeX) throw new Error(`Interactive quick-action drift started swipe: ${JSON.stringify(driftResult)}`);

    const actionZoneSwipe = await page.evaluate((value) => {
      const titleEl = Array.from(document.querySelectorAll('.todo-title')).find(el => (el.textContent || '').includes(value));
      const item = titleEl?.closest('.todo-item');
      const deleteButton = item?.querySelector('.todo-actions button:last-child');
      if (!item || !deleteButton) throw new Error('Delete quick-action missing for action-zone swipe test');
      const rect = deleteButton.getBoundingClientRect();
      const startX = rect.right - 2;
      const startY = rect.top + rect.height / 2;
      const pointer = { pointerId: 90, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true };
      deleteButton.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, clientX: startX, clientY: startY }));
      document.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: startX - 70, clientY: startY + 1 }));
      const transform = getComputedStyle(item).transform;
      const swipeX = item.style.getPropertyValue('--swipe-x');
      document.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: startX - 220, clientY: startY + 1 }));
      document.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientX: startX - 220, clientY: startY + 1 }));
      return { transform, swipeX, confirmOpen: Boolean(document.querySelector('#confirm-modal.active')) };
    }, quickActionTitle);
    if (!actionZoneSwipe.swipeX || actionZoneSwipe.transform === 'none' || actionZoneSwipe.confirmOpen) {
      throw new Error(`Action-zone swipe did not translate todo without tapping delete: ${JSON.stringify(actionZoneSwipe)}`);
    }
    await waitForTodo(page, quickActionTitle, { status: 'done' });
    await page.waitForFunction(() => window.__androidHapticCalls?.includes(18), null, { timeout: 5000 });
    await page.waitForTimeout(500);

    const item = todoItem();
    await item.locator('.todo-snooze-menu summary').click();
    await item.locator('.todo-snooze-menu[open]').waitFor({ state: 'visible', timeout: 5000 });
    await item.locator('.todo-snooze-menu .todo-status-options button').filter({ hasText: /Morgen|Tomorrow/i }).click();
    await waitForTodo(page, title, { due: true });

    assertNoFrontendErrors();
    console.log('✅ Android todo gestures test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);

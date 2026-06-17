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
  const dragDropSource = await readFile(new URL('../web/static/js/features/drag-drop.js', import.meta.url), 'utf8');
  if (!dragDropSource.includes('NATIVE_AUTO_SCROLL_EDGE_PX') || !dragDropSource.includes('NATIVE_AUTO_SCROLL_VIEWPORT_GAP_PX') || !dragDropSource.includes('NATIVE_AUTO_SCROLL_TOP_EDGE_PX') || !dragDropSource.includes('NATIVE_AUTO_SCROLL_TOPBAR_GAP_PX') || !dragDropSource.includes('nativeAutoScrollTopBoundary') || !dragDropSource.includes("document.querySelector('.topbar')") || !dragDropSource.includes('nativeScrollContainer()') || !dragDropSource.includes('applyScrollDelta') || !dragDropSource.includes('scheduleNativeAutoScroll()') || !dragDropSource.includes('ghost?.getBoundingClientRect') || !dragDropSource.includes('ghostRect?.bottom')) {
    throw new Error('Native pointer drag must auto-scroll the app scroll container near viewport edges on Android, with topbar-aware top and viewport-aware bottom ghost-position triggers');
  }
  if (!dragDropSource.includes('pointerDrag && pointerDrag.pointerId !== event.pointerId') || !dragDropSource.includes("document.addEventListener('touchstart'") || !dragDropSource.includes('event.touches.length < 2') || !dragDropSource.includes('event.stopImmediatePropagation()')) {
    throw new Error('Native pointer drag must block secondary touch/pointer input so multi-touch cannot replace or strand the active drag state');
  }
  if (!dragDropSource.includes('scheduleStandardDragAutoScroll(e)') || !dragDropSource.includes('scrollContainerFromElement(event.target)')) {
    throw new Error('Standard HTML5 dragover must share topbar-aware auto-scroll for desktop/iPad browsers');
  }
  if (dragDropSource.includes('if (pointerDrag.active && pointerDrag.isTouch) return;')) {
    throw new Error('Native pointer drag must not ignore active Android pointercancel events and leave ghost UI stuck');
  }
  if (!dragDropSource.includes('touchIdentifier') || !dragDropSource.includes('changedTouchForDrag(event)') || !dragDropSource.includes('activeTouchForDrag(event)') || !dragDropSource.includes('nativeDragEventFromLastPosition()')) {
    throw new Error('Native touch drag cleanup must track the drag touch explicitly and fall back to last coordinates for multi-touch cleanup');
  }
  const handleTodoDragOverSource = dragDropSource.slice(dragDropSource.indexOf('function handleTodoDragOver'), dragDropSource.indexOf('async function moveTodoToSection'));
  if (!handleTodoDragOverSource.includes('clearTodoDropIndicators()') || handleTodoDragOverSource.indexOf('clearTodoDropIndicators()') > handleTodoDragOverSource.indexOf("classList.add('drag-over')")) {
    throw new Error('Todo dragover must clear stale section drop indicators before highlighting the current target');
  }
  if (dragDropSource.includes('touch.identifier === pointerDrag.pointerId')) {
    throw new Error('Native touch drag must not assume PointerEvent.pointerId equals Touch.identifier');
  }
  const { browser, page, assertNoFrontendErrors } = await launchPage();
  const openTodoModal = async () => {
    await page.evaluate(() => window.showTodoModal?.());
    await page.locator('#todo-modal.active').waitFor({ state: 'visible', timeout: 5000 });
  };
  const title = 'Android Gesture Todo';
  const quickActionTitle = 'Android Quick Action Pin Todo';
  const todoItem = () => page.locator('.todo-item').filter({ hasText: title }).last();
  const revealQuickActions = async (todoTitle) => {
    const item = page.locator('.todo-item').filter({ hasText: todoTitle }).last();
    await item.evaluate((el) => {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.classList.add('actions-expanded');
      el.querySelector('.todo-actions-reveal-btn')?.setAttribute('aria-expanded', 'true');
    });
    return item;
  };
  const clickQuickAction = async (todoTitle, selector) => {
    const item = await revealQuickActions(todoTitle);
    await item.locator(selector).evaluate((button) => button.click());
    return item;
  };
  const openOrganizePanel = async () => {
    await page.evaluate(() => {
      const panel = document.getElementById('todo-organize-panel');
      if (panel) panel.open = true;
    });
  };

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
    await openOrganizePanel();
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
    await clickQuickAction(quickActionTitle, '.todo-pin-btn');
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
      const swipeProgress = Number.parseFloat(item.style.getPropertyValue('--swipe-progress'));
      const hasTouchFeedback = item.classList.contains('touch-feedback');
      const readyBeforeThreshold = item.classList.contains('swipe-ready');
      document.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: startX + 220, clientY: startY + 2 }));
      const readyAfterThreshold = item.classList.contains('swipe-ready');
      document.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientX: startX + 220, clientY: startY + 2 }));
      return { transform, swipeX, swipeProgress, hasTouchFeedback, readyBeforeThreshold, readyAfterThreshold };
    }, title);
    if (!midSwipe.swipeX || midSwipe.transform === 'none' || !midSwipe.transform.includes('70')) {
      throw new Error(`Android swipe did not translate todo item: ${JSON.stringify(midSwipe)}`);
    }
    if (!(midSwipe.swipeProgress > 0 && midSwipe.swipeProgress < 1) || midSwipe.readyBeforeThreshold || !midSwipe.readyAfterThreshold) {
      throw new Error(`Android swipe did not expose smooth progress/ready state: ${JSON.stringify(midSwipe)}`);
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
      const ready = item.classList.contains('swipe-ready');
      document.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: startX + 4, clientY: startY + 1 }));
      document.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientX: startX + 4, clientY: startY + 1 }));
      return { transform, swipeX, ready, width: rect.width };
    }, title);
    const wideSwipeX = Number.parseFloat(wideSwipe.swipeX);
    if (!wideSwipe.swipeX || wideSwipeX < wideSwipe.width - 4 || !wideSwipe.transform.includes(String(Math.round(wideSwipeX))) || !wideSwipe.ready) {
      throw new Error(`Wide/iPad-style swipe was still visually clamped or missed ready state: ${JSON.stringify(wideSwipe)}`);
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

    const autoScrollResult = await page.evaluate(async (value) => {
      const titleEl = Array.from(document.querySelectorAll('.todo-title')).find(el => (el.textContent || '').includes(value));
      const item = titleEl?.closest('.todo-item');
      const main = document.querySelector('.main');
      if (!item || !main) throw new Error('Todo item or main scroll container missing for native auto-scroll test');
      const spacer = document.createElement('div');
      spacer.style.height = '1800px';
      spacer.dataset.testNativeDragSpacer = 'true';
      main.appendChild(spacer);
      main.scrollTop = 0;
      item.scrollIntoView({ block: 'center' });
      await new Promise(resolve => requestAnimationFrame(resolve));
      const rect = item.getBoundingClientRect();
      const startX = rect.left + rect.width * 0.5;
      const startY = rect.top + rect.height / 2;
      const pointer = { pointerId: 177, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true };
      item.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, clientX: startX, clientY: startY }));
      document.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: startX, clientY: startY + 40 }));
      document.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: startX, clientY: window.innerHeight - 3 }));
      await new Promise(resolve => setTimeout(resolve, 180));
      const scrollDownTop = main.scrollTop;
      document.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: startX, clientY: main.getBoundingClientRect().top + 3 }));
      await new Promise(resolve => setTimeout(resolve, 180));
      const scrollUpTop = main.scrollTop;
      const ghostVisible = Boolean(document.querySelector('.native-drag-ghost'));
      document.dispatchEvent(new PointerEvent('pointercancel', { ...pointer, clientX: startX, clientY: main.getBoundingClientRect().top + 3 }));
      await new Promise(resolve => requestAnimationFrame(resolve));
      const cleaned = !document.querySelector('.native-drag-ghost') && !document.body.classList.contains('native-pointer-dragging');
      spacer.remove();
      return { scrollDownTop, scrollUpTop, ghostVisible, cleaned };
    }, title);
    if (autoScrollResult.scrollDownTop <= 0 || autoScrollResult.scrollUpTop >= autoScrollResult.scrollDownTop || !autoScrollResult.ghostVisible || !autoScrollResult.cleaned) {
      throw new Error(`Native drag auto-scroll/cleanup failed: ${JSON.stringify(autoScrollResult)}`);
    }

    const standardAutoScrollResult = await page.evaluate(async (value) => {
      const titleEl = Array.from(document.querySelectorAll('.todo-title')).find(el => (el.textContent || '').includes(value));
      const item = titleEl?.closest('.todo-item');
      const main = document.querySelector('.main');
      const topbar = document.querySelector('.topbar');
      if (!item || !main || !topbar || !window.handleTodoDragStart || !window.handleTodoDragOver || !window.handleTodoDragEnd) {
        throw new Error('Standard drag auto-scroll prerequisites missing');
      }
      const spacer = document.createElement('div');
      spacer.style.height = '1800px';
      spacer.dataset.testStandardDragSpacer = 'true';
      main.appendChild(spacer);
      item.scrollIntoView({ block: 'center' });
      await new Promise(resolve => requestAnimationFrame(resolve));
      main.scrollTop += 360;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const before = main.scrollTop;
      const topbarBottom = topbar.getBoundingClientRect().bottom;
      const targetY = topbarBottom + 48;
      window.handleTodoDragStart({ target: item, dataTransfer: { effectAllowed: '', setData() {}, dropEffect: '' } });
      window.handleTodoDragOver({
        preventDefault() {},
        target: item,
        clientY: targetY,
        dataTransfer: { dropEffect: '' },
      });
      await new Promise(resolve => setTimeout(resolve, 180));
      const after = main.scrollTop;
      window.handleTodoDragEnd({ target: item });
      spacer.remove();
      return { before, after, targetY, topbarBottom };
    }, title);
    if (standardAutoScrollResult.before <= 0 || standardAutoScrollResult.after >= standardAutoScrollResult.before) {
      throw new Error(`Standard drag topbar-aware auto-scroll up failed: ${JSON.stringify(standardAutoScrollResult)}`);
    }

    await revealQuickActions(quickActionTitle);
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

    await revealQuickActions(quickActionTitle);
    const actionZoneSwipe = await page.evaluate((value) => {
      const titleEl = Array.from(document.querySelectorAll('.todo-title')).find(el => (el.textContent || '').includes(value));
      const item = titleEl?.closest('.todo-item');
      const deleteButton = Array.from(item?.querySelectorAll('.todo-actions > button:not(.todo-actions-reveal-btn)') || []).at(-1);
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

    const item = await revealQuickActions(title);
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

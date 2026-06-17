#!/usr/bin/env node
import { withFreshDb, launchPage, BASE_URL, USERNAME, USER_PASSWORD } from './frontend_test_lib.mjs';

async function readTodoActionState(page, title) {
  return page.evaluate((value) => {
    const titleEl = Array.from(document.querySelectorAll('.todo-title')).find((el) => (el.textContent || '').includes(value));
    const item = titleEl?.closest('.todo-item');
    const sidebar = document.querySelector('#sidebar');
    const reveal = item?.querySelector('.todo-actions-reveal-btn');
    const pin = item?.querySelector('.todo-pin-btn');
    const snooze = item?.querySelector('.todo-snooze-menu');
    if (!item || !reveal || !pin || !snooze) return { found: false };
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return {
      found: true,
      width: window.innerWidth,
      sidebarPosition: sidebar ? getComputedStyle(sidebar).position : null,
      revealVisible: visible(reveal),
      revealExpanded: reveal.getAttribute('aria-expanded'),
      pinVisible: visible(pin),
      snoozeVisible: visible(snooze),
      itemExpanded: item.classList.contains('actions-expanded'),
    };
  }, title);
}

async function login(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-overlay').waitFor({ state: 'visible', timeout: 10000 });
  await page.fill('#login-username', USERNAME);
  await page.fill('#login-password', USER_PASSWORD);
  await page.click('button.login-btn');
  await page.locator('#login-overlay').waitFor({ state: 'hidden', timeout: 15000 });
  await page.locator('#user-menu-button').waitFor({ state: 'visible', timeout: 10000 });
}

async function main() {
  console.log('📱 Running todo action breakpoint test...');
  await withFreshDb(async () => {
    const { browser, page, loginApp, assertNoFrontendErrors } = await launchPage();
    try {
      await loginApp();
      const title = 'Tablet quick actions breakpoint';
      await page.getByRole('button', { name: /Neues Todo|New todo/i }).click();
      await page.locator('#todo-modal').waitFor({ state: 'visible', timeout: 5000 });
      await page.fill('#todo-title', title);
      await page.click('button[form="todo-form"]');
      await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
      await page.waitForFunction((value) => document.body.innerText.includes(value), title, { timeout: 10000 });

      await page.setViewportSize({ width: 834, height: 1112 });
      let tablet = await readTodoActionState(page, title);
      if (!tablet.found || tablet.sidebarPosition === 'fixed' || !tablet.revealVisible || tablet.pinVisible || tablet.snoozeVisible) {
        throw new Error(`iPad-sized desktop-shell layout should keep todo quick actions collapsed: ${JSON.stringify(tablet)}`);
      }

      await page.locator('.todo-item').filter({ hasText: title }).locator('.todo-actions-reveal-btn').click();
      tablet = await readTodoActionState(page, title);
      if (!tablet.itemExpanded || tablet.revealExpanded !== 'true' || !tablet.pinVisible || !tablet.snoozeVisible) {
        throw new Error(`iPad-sized quick actions should reveal after tapping arrow: ${JSON.stringify(tablet)}`);
      }

      await page.evaluate((value) => {
        const titleEl = Array.from(document.querySelectorAll('.todo-title')).find((el) => (el.textContent || '').includes(value));
        const item = titleEl?.closest('.todo-item');
        item?.classList.remove('actions-expanded');
        item?.querySelector('.todo-actions-reveal-btn')?.setAttribute('aria-expanded', 'false');
      }, title);

      await page.setViewportSize({ width: 1194, height: 834 });
      const wideTablet = await readTodoActionState(page, title);
      if (!wideTablet.found || wideTablet.sidebarPosition === 'fixed' || !wideTablet.revealVisible || wideTablet.pinVisible || wideTablet.snoozeVisible) {
        throw new Error(`Wide iPad landscape layout should keep todo quick actions collapsed: ${JSON.stringify(wideTablet)}`);
      }

      await page.setViewportSize({ width: 1280, height: 900 });
      const desktop = await readTodoActionState(page, title);
      if (!desktop.found || desktop.revealVisible || !desktop.pinVisible || !desktop.snoozeVisible) {
        throw new Error(`Wide desktop layout should show todo quick actions directly: ${JSON.stringify(desktop)}`);
      }

      const touchContext = await browser.newContext({ viewport: { width: 1366, height: 1024 }, hasTouch: true, isMobile: false });
      const touchPage = await touchContext.newPage();
      try {
        await login(touchPage);
        await touchPage.waitForFunction((value) => document.body.innerText.includes(value), title, { timeout: 10000 });
        const touchTablet = await readTodoActionState(touchPage, title);
        if (!touchTablet.found || !touchTablet.revealVisible || touchTablet.pinVisible || touchTablet.snoozeVisible) {
          throw new Error(`Desktop-width touch tablet should keep todo quick actions collapsed: ${JSON.stringify(touchTablet)}`);
        }
        const touchDragState = await touchPage.evaluate((value) => {
          const titleEl = Array.from(document.querySelectorAll('.todo-title')).find((el) => (el.textContent || '').includes(value));
          const item = titleEl?.closest('.todo-item');
          const style = item ? getComputedStyle(item) : null;
          return {
            found: Boolean(item),
            draggableAttr: item?.getAttribute('draggable'),
            draggableProp: item?.draggable,
            pointerDnd: item?.getAttribute('data-native-pointer-dnd'),
            touchDnd: item?.getAttribute('data-touch-dnd'),
            userSelect: style?.userSelect,
            webkitUserSelect: style?.webkitUserSelect,
            webkitTouchCallout: style?.webkitTouchCallout,
          };
        }, title);
        if (!touchDragState.found || touchDragState.draggableAttr !== null || touchDragState.draggableProp || touchDragState.pointerDnd !== 'true' || touchDragState.touchDnd !== 'true') {
          throw new Error(`Touch tablet should disable native HTML5 drag previews for pointer drag-drop: ${JSON.stringify(touchDragState)}`);
        }
        if (touchDragState.userSelect !== 'none' || touchDragState.webkitUserSelect !== 'none') {
          throw new Error(`Touch tablet drag surfaces should prevent iPad text selection handles: ${JSON.stringify(touchDragState)}`);
        }
      } finally {
        await touchContext.close();
      }

      assertNoFrontendErrors();
      console.log('✅ Todo action breakpoint test passed');
    } finally {
      await browser.close();
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

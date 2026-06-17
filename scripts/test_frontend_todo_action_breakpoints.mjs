#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

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

      await page.setViewportSize({ width: 1280, height: 900 });
      const desktop = await readTodoActionState(page, title);
      if (!desktop.found || desktop.revealVisible || !desktop.pinVisible || !desktop.snoozeVisible) {
        throw new Error(`Wide desktop layout should show todo quick actions directly: ${JSON.stringify(desktop)}`);
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

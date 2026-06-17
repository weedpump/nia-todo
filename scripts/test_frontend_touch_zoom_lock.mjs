#!/usr/bin/env node
import { BASE_URL, launchPage } from './frontend_test_lib.mjs';

async function main() {
  console.log('🔍 Running touch zoom lock test...');
  const { browser, page, assertNoFrontendErrors } = await launchPage();
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    const state = await page.evaluate(() => {
      const viewport = document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '';
      const htmlTouchAction = getComputedStyle(document.documentElement).touchAction;
      const bodyTouchAction = getComputedStyle(document.body).touchAction;
      const appTouchAction = getComputedStyle(document.getElementById('app')).touchAction;

      const gesture = new Event('gesturestart', { bubbles: true, cancelable: true });
      const gestureDispatchResult = document.dispatchEvent(gesture);
      const touchMove = new Event('touchmove', { bubbles: true, cancelable: true });
      Object.defineProperty(touchMove, 'touches', { value: [{}, {}] });
      const touchDispatchResult = document.dispatchEvent(touchMove);

      return {
        viewport,
        htmlTouchAction,
        bodyTouchAction,
        appTouchAction,
        gesturePrevented: gesture.defaultPrevented || gestureDispatchResult === false,
        touchMovePrevented: touchMove.defaultPrevented || touchDispatchResult === false,
      };
    });

    const requiredViewportParts = ['maximum-scale=1.0', 'user-scalable=no', 'viewport-fit=cover'];
    for (const part of requiredViewportParts) {
      if (!state.viewport.includes(part)) {
        throw new Error(`Viewport is missing ${part}: ${JSON.stringify(state)}`);
      }
    }
    for (const [key, value] of Object.entries({ htmlTouchAction: state.htmlTouchAction, bodyTouchAction: state.bodyTouchAction, appTouchAction: state.appTouchAction })) {
      if (!String(value).includes('pan-x') || !String(value).includes('pan-y')) {
        throw new Error(`${key} should allow panning without pinch zoom: ${JSON.stringify(state)}`);
      }
    }
    if (!state.gesturePrevented || !state.touchMovePrevented) {
      throw new Error(`Touch zoom events should be prevented: ${JSON.stringify(state)}`);
    }

    assertNoFrontendErrors();
    console.log('✅ Touch zoom lock test passed');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

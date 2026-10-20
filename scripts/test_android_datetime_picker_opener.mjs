import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const uiShellSource = readFileSync(new URL('../web/static/js/features/ui-shell.js', import.meta.url), 'utf8');
const uiHistorySource = readFileSync(new URL('../web/static/js/features/ui-history.js', import.meta.url), 'utf8');

const browser = await chromium.launch({ headless: true });

async function pickerCallsFor({ userAgent, pointerType, target = 'wrap' }) {
  const hasTouch = pointerType === 'touch';
  const context = await browser.newContext({
    userAgent,
    hasTouch,
    isMobile: hasTouch,
    viewport: hasTouch ? { width: 390, height: 844 } : { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.route('http://datetime-picker.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/static/js/features/ui-shell.js') {
      await route.fulfill({ contentType: 'text/javascript', body: uiShellSource });
      return;
    }
    if (path === '/static/js/features/ui-history.js') {
      await route.fulfill({ contentType: 'text/javascript', body: uiHistorySource });
      return;
    }
    if (path === '/static/js/features/auto-scrollbars.js') {
      await route.fulfill({ contentType: 'text/javascript', body: 'export function hideAutoScrollbars() {}' });
      return;
    }
    if (path === '/static/js/i18n/index.js') {
      await route.fulfill({ contentType: 'text/javascript', body: 'export function t(key) { return key; }' });
      return;
    }
    if (path !== '/picker-test') {
      await route.fulfill({ status: 404, body: 'Not found' });
      return;
    }
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html>
        <html>
          <body>
            <div class="datetime-input-wrap" id="picker-wrap">
              <input type="datetime-local" id="picker-input">
              <span class="datetime-input-icon" id="picker-icon">calendar</span>
            </div>
            <script type="module">
              import { createUiShell } from '/static/js/features/ui-shell.js';
              const shell = createUiShell({ renderMarkdown: value => value, showTodoModal: async () => {} });
              shell.bindDateTimePickerOpeners();
              const input = document.getElementById('picker-input');
              const nativeShowPicker = input.showPicker.bind(input);
              window.pickerCalls = 0;
              window.pickerSuccesses = 0;
              window.pickerErrors = [];
              input.showPicker = () => {
                window.pickerCalls += 1;
                try {
                  nativeShowPicker();
                  window.pickerSuccesses += 1;
                } catch (error) {
                  window.pickerErrors.push(error.name);
                }
              };
              window.pickerReady = true;
            </script>
          </body>
        </html>`,
    });
  });

  try {
    await page.goto('http://datetime-picker.test/picker-test');
    await page.waitForFunction(() => window.pickerReady === true);
    const locator = page.locator(`#picker-${target}`);
    const box = await locator.boundingBox();
    assert(box, `picker ${target} must be visible`);
    if (hasTouch) {
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    } else {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    return await page.evaluate(() => ({
      calls: window.pickerCalls,
      successes: window.pickerSuccesses,
      errors: window.pickerErrors,
    }));
  } finally {
    await context.close();
  }
}

try {
  const android = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36';
  const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1';
  const desktop = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36';

  assert.deepEqual(
    await pickerCallsFor({ userAgent: android, pointerType: 'touch', target: 'wrap' }),
    { calls: 1, successes: 1, errors: [] },
    'Android touch on the datetime field must explicitly open the picker',
  );
  assert.deepEqual(
    await pickerCallsFor({ userAgent: android, pointerType: 'touch', target: 'icon' }),
    { calls: 1, successes: 1, errors: [] },
    'Android touch on the custom calendar icon must explicitly open the picker',
  );
  assert.deepEqual(
    await pickerCallsFor({ userAgent: ios, pointerType: 'touch', target: 'wrap' }),
    { calls: 0, successes: 0, errors: [] },
    'iOS touch must keep using its native picker path',
  );
  assert.deepEqual(
    await pickerCallsFor({ userAgent: desktop, pointerType: 'mouse', target: 'wrap' }),
    { calls: 1, successes: 1, errors: [] },
    'desktop mouse clicks must keep using the explicit picker opener',
  );
} finally {
  await browser.close();
}

console.log('Android datetime picker opener tests passed');

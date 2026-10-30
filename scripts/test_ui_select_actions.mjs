#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const dropdownSource = readFileSync(new URL('../web/static/js/ui/dropdowns.js', import.meta.url), 'utf8');
const dropdownCss = readFileSync(new URL('../web/static/css/32-dropdowns-selects.css', import.meta.url), 'utf8');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error?.stack || error)));
  await page.route('http://ui-select.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/static/js/ui/dropdowns.js') {
      return route.fulfill({ contentType: 'text/javascript', body: dropdownSource });
    }
    if (pathname === '/static/js/icons/lucide-icons.js') {
      return route.fulfill({ contentType: 'text/javascript', body: "export const iconSvg = name => `<svg data-icon=\"${name}\" aria-hidden=\"true\"></svg>`;" });
    }
    if (pathname === '/static/css/dropdowns.css') {
      return route.fulfill({ contentType: 'text/css', body: dropdownCss });
    }
    if (pathname === '/') {
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html>
          <html><head><style>:root { --border: #334155; }</style><link rel="stylesheet" href="/static/css/dropdowns.css"></head><body>
            <label for="entity-select">Entity</label>
            <select id="entity-select">
              <option value="one">One</option>
              <option value="two">Two</option>
            </select>
            <label for="disabled-select">Disabled entity</label>
            <select id="disabled-select" disabled><option value="locked">Locked</option></select>
            <label for="plain-select">Plain entity</label>
            <select id="plain-select"><option value="plain">Plain</option></select>
            <button id="caller-focus-target" type="button">New entity name</button>
            <script type="module">
              import { hydrateSelect } from '/static/js/ui/dropdowns.js';
              window.actionCalls = 0;
              window.disabledActionCalls = 0;
              window.focusFromAction = false;
              window.instance = hydrateSelect(document.querySelector('#entity-select'), {
                searchable: true,
                searchPlaceholder: 'Find entity',
                action: {
                  label: 'Add entity',
                  icon: 'plus',
                  onActivate() {
                    window.actionCalls += 1;
                    if (window.focusFromAction) document.querySelector('#caller-focus-target').focus();
                  },
                },
              });
              window.disabledInstance = hydrateSelect(document.querySelector('#disabled-select'), {
                action: {
                  label: 'Unavailable action',
                  onActivate() { window.disabledActionCalls += 1; },
                },
              });
              window.plainInstance = hydrateSelect(document.querySelector('#plain-select'));
              window.escapeBubbledWithoutDefault = false;
              document.addEventListener('keydown', event => {
                if (event.key === 'Escape' && !event.defaultPrevented) window.escapeBubbledWithoutDefault = true;
              });
              document.documentElement.dataset.ready = 'true';
            </script>
          </body></html>`,
      });
    }
    return route.fulfill({ status: 404, body: 'not found' });
  });

  await page.goto('http://ui-select.test/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');

  const trigger = page.locator('[data-select-id="entity-select"] .ui-select-trigger');
  await trigger.click();
  const action = page.locator('.ui-select-action');
  await action.waitFor({ state: 'visible' });
  assert.equal(await action.textContent(), 'Add entity', 'the caller supplies the action label');
  assert.equal(await action.getAttribute('role'), null, 'the generic action is a native button, not a listbox option');
  assert.equal(await action.evaluate(element => getComputedStyle(element).borderTopWidth), '0px', 'the action row must not introduce a separator line');
  await page.setViewportSize({ width: 1280, height: 800 });
  assert.equal(await action.evaluate(element => getComputedStyle(element).borderTopWidth), '0px', 'the desktop action row must not introduce a separator line');
  await page.setViewportSize({ width: 390, height: 800 });
  assert.equal(await action.evaluate(element => element.closest('[role="listbox"]')), null, 'the action must not be nested inside the listbox');
  assert.equal(await page.locator('[role="listbox"] .ui-select-option').count(), 2, 'native options remain inside the listbox');
  assert.deepEqual(
    await page.locator('.ui-select-menu').evaluate(menu => Array.from(menu.children).map(child => child.className)),
    ['ui-select-search', 'ui-select-options', 'ui-select-empty', 'ui-select-action'],
    'the action follows search and listbox content',
  );
  assert.ok(await action.evaluate(element => element.getBoundingClientRect().height >= 44), 'the action keeps a 44px mobile pointer target');
  await page.locator('.ui-select-search-input').fill('no matching option');
  assert.equal(await action.isVisible(), true, 'filtering options keeps the generic action available');

  await action.click();
  assert.equal(await page.evaluate(() => window.actionCalls), 1, 'pointer activation invokes the callback once');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'pointer activation closes the dropdown');
  assert.equal(await trigger.evaluate(element => element === document.activeElement), true, 'pointer activation restores focus to the trigger by default');

  await page.evaluate(() => {
    window.focusFromAction = true;
    const select = document.querySelector('#entity-select');
    select.value = 'two';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await trigger.press('Enter');
  const search = page.locator('.ui-select-search-input');
  await search.press('ArrowDown');
  assert.equal(await action.evaluate(element => element === document.activeElement), true, 'ArrowDown after the final option reaches the action row');
  await action.press('Enter');
  assert.equal(await page.evaluate(() => window.actionCalls), 2, 'keyboard activation invokes the callback once');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'keyboard activation closes the dropdown');
  assert.equal(await page.locator('#caller-focus-target').evaluate(element => element === document.activeElement), true, 'the callback can move focus after the trigger is restored');

  await trigger.focus();
  await trigger.press('Enter');
  await search.press('ArrowDown');
  await action.press('Escape');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'Escape from the action closes the dropdown');
  assert.equal(await trigger.evaluate(element => element === document.activeElement), true, 'Escape from the action restores focus to the trigger');
  assert.equal(await page.evaluate(() => window.actionCalls), 2, 'Escape does not activate the action');

  await page.evaluate(() => { window.escapeBubbledWithoutDefault = false; });
  await trigger.press('Enter');
  await trigger.press('Escape');
  assert.equal(await page.evaluate(() => window.escapeBubbledWithoutDefault), false, 'Escape consumed by an open dropdown must not fall through to a parent modal');

  const disabledTrigger = page.locator('[data-select-id="disabled-select"] .ui-select-trigger');
  assert.equal(await disabledTrigger.isDisabled(), true, 'a disabled native select keeps its custom trigger disabled');
  await disabledTrigger.evaluate(element => element.click());
  assert.equal(await disabledTrigger.getAttribute('aria-expanded'), 'false', 'a disabled select cannot open its action menu');
  assert.equal(await page.evaluate(() => window.disabledActionCalls), 0, 'a disabled select cannot invoke its action callback');

  const plainTrigger = page.locator('[data-select-id="plain-select"] .ui-select-trigger');
  await plainTrigger.click();
  assert.equal(await page.locator('.ui-select-action').count(), 0, 'no action row is rendered when action metadata is absent');
  await plainTrigger.press('Escape');
  assert.deepEqual(errors, [], 'the action flow must not raise browser errors');
} finally {
  await browser.close();
}

console.log('✓ shared select action pointer and keyboard regression passed');

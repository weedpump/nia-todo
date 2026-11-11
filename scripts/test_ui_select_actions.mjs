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
              window.optionActionCalls = 0;
              window.disabledActionCalls = 0;
              window.focusFromAction = false;
              window.heldDropdownFocus = [];
              const nativeSetTimeout = window.setTimeout.bind(window);
              window.setTimeout = (callback, delay, ...args) => {
                if (window.holdDropdownFocus && delay === 0) {
                  window.heldDropdownFocus.push(() => callback(...args));
                  return -window.heldDropdownFocus.length;
                }
                return nativeSetTimeout(callback, delay, ...args);
              };
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
                optionAction(option) {
                  if (option.value !== 'two') return null;
                  return {
                    icon: 'pencil',
                    ariaLabel: 'Edit Two',
                    onActivate() { window.optionActionCalls += 1; },
                  };
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
  const optionAction = page.locator('.ui-select-option-action');
  assert.equal(await optionAction.evaluate(element => element.closest('[role="listbox"]')), null, 'per-option actions must remain outside the listbox semantics');
  assert.equal(await page.locator('[role="listbox"] .ui-select-option').count(), 2, 'native options remain inside the listbox');
  assert.deepEqual(
    await page.locator('.ui-select-menu').evaluate(menu => Array.from(menu.children).map(child => child.className)),
    ['ui-select-search', 'ui-select-options', 'ui-select-option-actions', 'ui-select-empty', 'ui-select-action'],
    'the action follows search and listbox content',
  );
  assert.ok(await action.evaluate(element => element.getBoundingClientRect().height >= 44), 'the action keeps a 44px mobile pointer target');
  const firstOptionRect = await page.locator('.ui-select-option').first().boundingBox();
  await page.locator('.ui-select-search-input').fill('no matching option');
  assert.equal(await action.isVisible(), true, 'filtering options keeps the generic action available');
  assert.equal(await optionAction.isVisible(), false, 'filtering an option also hides its detached action');

  await action.click();
  assert.equal(await page.evaluate(() => window.actionCalls), 1, 'pointer activation invokes the callback once');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'pointer activation closes the dropdown');
  assert.equal(await trigger.evaluate(element => element === document.activeElement), true, 'pointer activation restores focus to the trigger by default');

  await page.evaluate(() => {
    window.focusFromAction = true;
    window.holdDropdownFocus = true;
    const select = document.querySelector('#entity-select');
    select.value = 'two';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.mouse.move(firstOptionRect.x + firstOptionRect.width / 2, firstOptionRect.y + firstOptionRect.height / 2);
  await trigger.press('Enter');
  const search = page.locator('.ui-select-search-input');
  assert.equal(await page.locator('.ui-select-option.is-highlighted').getAttribute('data-index'), '1', 'keyboard opening highlights the selected final option');
  await page.locator('.ui-select-option').first().evaluate((row, point) => {
    // Layout-driven entry after the portal appears must not count as movement.
    row.dispatchEvent(new MouseEvent('mouseenter', { clientX: point.x, clientY: point.y }));
    row.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: point.x, clientY: point.y }));
  }, { x: firstOptionRect.x + firstOptionRect.width / 2, y: firstOptionRect.y + firstOptionRect.height / 2 });
  assert.equal(await page.locator('.ui-select-option.is-highlighted').getAttribute('data-index'), '1', 'stationary pointer events must preserve keyboard selection');
  await search.press('ArrowDown');
  assert.equal(await action.evaluate(element => element === document.activeElement), true, 'ArrowDown after the final option reaches the action row');
  const heldFocusCount = await page.evaluate(() => {
    window.holdDropdownFocus = false;
    const callbacks = window.heldDropdownFocus.splice(0);
    callbacks.forEach(callback => callback());
    return callbacks.length;
  });
  assert.equal(heldFocusCount, 1, 'the delayed opening-focus callback must be exercised');
  assert.equal(await action.evaluate(element => element === document.activeElement), true, 'delayed opening focus must not steal focus back from the action');
  await action.press('Enter');
  assert.equal(await page.evaluate(() => window.actionCalls), 2, 'keyboard activation invokes the callback once');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'keyboard activation closes the dropdown');
  assert.equal(await page.locator('#caller-focus-target').evaluate(element => element === document.activeElement), true, 'the callback can move focus after the trigger is restored');

  await trigger.focus();
  await trigger.press('Enter');
  await search.focus();
  const hoverRect = await page.locator('.ui-select-option').first().boundingBox();
  await page.mouse.move(0, 0);
  await page.mouse.move(hoverRect.x + hoverRect.width / 2, hoverRect.y + hoverRect.height / 2);
  assert.equal(await page.locator('.ui-select-option.is-highlighted').getAttribute('data-index'), '0', 'actual pointer movement still highlights its option');
  await search.press('ArrowDown');
  await search.press('ArrowDown');
  await action.press('Escape');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'Escape from the action closes the dropdown');
  assert.equal(await trigger.evaluate(element => element === document.activeElement), true, 'Escape from the action restores focus to the trigger');
  assert.equal(await page.evaluate(() => window.actionCalls), 2, 'Escape does not activate the action');

  await page.evaluate(() => {
    window.focusFromAction = false;
    const select = document.querySelector('#entity-select');
    select.value = 'one';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await trigger.press('Enter');
  await search.fill('Two');
  assert.equal(await page.locator('.ui-select-option.is-highlighted').textContent(), 'Two', 'search must highlight the first matching visible option');
  await search.press('ArrowRight');
  assert.equal(await optionAction.evaluate(element => element === document.activeElement), true, 'ArrowRight from a searchable select reaches the highlighted option action');
  await optionAction.press('ArrowLeft');
  assert.equal(await trigger.evaluate(element => element === document.activeElement), true, `ArrowLeft from an option action returns to the trigger (active=${await page.evaluate(() => document.activeElement?.className || document.activeElement?.id || document.activeElement?.tagName)})`);
  await trigger.press('ArrowRight');
  await optionAction.press('Enter');
  assert.equal(await page.evaluate(() => window.optionActionCalls), 1, 'keyboard activation invokes a per-option action once');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'per-option action activation closes the dropdown');

  await trigger.press('Enter');
  await search.fill('Two');
  await search.press('Enter');
  assert.equal(await page.locator('#entity-select').inputValue(), 'two', 'Enter selects the highlighted search result');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'selecting a search result closes the dropdown');

  await page.evaluate(() => { window.escapeBubbledWithoutDefault = false; });
  await trigger.press('Enter');
  await trigger.press('Escape');
  assert.equal(await page.evaluate(() => window.escapeBubbledWithoutDefault), false, 'Escape consumed by an open dropdown must not fall through to a parent modal');

  const blockedKeys = [{ isComposing: true }, { keyCode: 229 }, { handled: true }];
  for (const blocked of blockedKeys) {
    await trigger.evaluate((element, blocked) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...blocked });
      if (blocked.handled) event.preventDefault();
      element.dispatchEvent(event);
    }, blocked);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'handled/composing Enter must not open a closed dropdown');
  }
  for (const origin of ['search', 'option', 'trigger', 'action', 'option-action']) {
    await page.evaluate(() => {
      const select = document.querySelector('#entity-select');
      select.value = 'one';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await trigger.click();
    await search.fill('Two');
    const target = origin === 'search' ? search
      : origin === 'trigger' ? trigger
      : origin === 'action' ? action
      : origin === 'option-action' ? optionAction
      : page.locator('.ui-select-option[data-index="1"]');
    await target.focus();
    const countsBefore = await page.evaluate(() => [window.actionCalls, window.optionActionCalls]);
    for (const key of ['Enter', 'Escape']) {
      for (const blocked of blockedKeys) {
        await target.evaluate((element, { key, blocked }) => {
          const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...blocked });
          if (blocked.handled) event.preventDefault();
          element.dispatchEvent(event);
        }, { key, blocked });
        assert.equal(await trigger.getAttribute('aria-expanded'), 'true', `${origin}: handled/composing ${key} must preserve the open dropdown`);
        assert.equal(await page.locator('#entity-select').inputValue(), 'one', `${origin}: IME confirmation must not select the highlighted option`);
        assert.deepEqual(await page.evaluate(() => [window.actionCalls, window.optionActionCalls]), countsBefore, `${origin}: handled/composing keys must not activate actions`);
      }
    }
    await target.press('Enter');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false', `${origin}: ordinary Enter retains its activation path`);
    if (origin === 'action' || origin === 'option-action') {
      assert.deepEqual(await page.evaluate(() => [window.actionCalls, window.optionActionCalls]), [
        countsBefore[0] + Number(origin === 'action'),
        countsBefore[1] + Number(origin === 'option-action'),
      ], `${origin}: ordinary Enter activates its callback once`);
    } else {
      assert.equal(await page.locator('#entity-select').inputValue(), 'two', `${origin}: ordinary Enter selects the highlighted result`);
    }
  }
  await trigger.click();
  await search.press('Escape');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'Escape from the search input closes the dropdown');
  assert.equal(await trigger.evaluate(element => element === document.activeElement), true, 'Escape from search restores trigger focus');

  await trigger.click();
  await search.fill('Two');
  await search.evaluate(input => { input.setSelectionRange(1, 2); window.searchBeforeRefresh = input; });
  const optionActionsBeforeRefresh = await page.evaluate(() => window.optionActionCalls);
  await page.evaluate(async () => {
    const { hydrateSelect, refreshSelect } = await import('/static/js/ui/dropdowns.js');
    const select = document.getElementById('entity-select');
    const value = select.value;
    select.innerHTML = '<option value="one">One</option><option value="two">Two</option>';
    select.value = value;
    window.freshOptionActionCalls = 0;
    hydrateSelect(select, { optionAction: option => option.value === 'two' ? {
      icon: 'pencil', ariaLabel: 'Edit Two', onActivate() { window.freshOptionActionCalls++; },
    } : null });
    refreshSelect(select);
  });
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true', 'equivalent native-option replacement must preserve the open dropdown');
  assert.equal(await search.evaluate(input => input === window.searchBeforeRefresh && document.activeElement === input && input.selectionStart === 1 && input.selectionEnd === 2), true,
    'equivalent editor refresh must preserve search node, focus, query and selection');
  assert.equal(await search.inputValue(), 'Two');
  await optionAction.focus();
  await page.evaluate(async () => {
    window.actionBeforeRefresh = document.activeElement;
    const { refreshSelect } = await import('/static/js/ui/dropdowns.js');
    refreshSelect(document.getElementById('entity-select'));
  });
  assert.equal(await optionAction.evaluate(element => element === window.actionBeforeRefresh && document.activeElement === element), true,
    'same-input refresh must retain the exact focused option-action node');
  await optionAction.click();
  assert.equal(await page.evaluate(() => window.freshOptionActionCalls), 1, 'preserved action nodes must use the current controller callback');
  assert.equal(await page.evaluate(() => window.optionActionCalls), optionActionsBeforeRefresh, 'preservation must not retain a stale action callback');
  await trigger.click();
  assert.equal(await search.inputValue(), '', 'a deliberate new opening resets the old search query');
  await page.evaluate(async () => {
    const { refreshSelect } = await import('/static/js/ui/dropdowns.js');
    const select = document.getElementById('entity-select');
    select.appendChild(new Option('Three', 'three'));
    refreshSelect(select);
  });
  assert.equal(await page.locator('.ui-select-option').count(), 3, 'real option changes must update an open dropdown');
  await page.evaluate(async () => {
    const { refreshSelect } = await import('/static/js/ui/dropdowns.js');
    const select = document.getElementById('entity-select');
    select.disabled = true;
    refreshSelect(select);
  });
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'a disabled select must close its old dropdown');
  assert.equal(await trigger.isDisabled(), true);

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

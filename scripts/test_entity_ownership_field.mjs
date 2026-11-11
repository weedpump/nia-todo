#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const fixtureSource = `
  import { createEntityOwnershipField, renderEntityOwnershipField } from '/static/js/features/entity-ownership-field.js';
  import { initI18n } from '/static/js/i18n/index.js';

  localStorage.setItem('nia-todo-language', 'de');
  await initI18n();
  document.body.innerHTML = renderEntityOwnershipField({ prefix: 'subject', labelKey: 'entity.ownership.for' });
  let household = { id: 7, name: 'Zuhause' };
  const changes = [];
  const field = createEntityOwnershipField({
    document,
    prefix: 'subject',
    getHousehold: () => household,
    onChange: value => changes.push(value),
  });
  window.test = {
    render: (entity, canManage = true) => field.render(entity, { canManage }),
    value: () => field.value(),
    changes: () => structuredClone(changes),
    setHousehold: value => { household = value; },
  };
`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error?.stack || error)));

try {
  await page.route('http://nia.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/static/style.css"></head><body><script type="module" src="/fixture.js"></script></body></html>' });
      return;
    }
    if (url.pathname === '/fixture.js') {
      await route.fulfill({ contentType: 'text/javascript', body: fixtureSource });
      return;
    }
    if (url.pathname.startsWith('/static/')) {
      try {
        const body = readFileSync(new URL(`../web${url.pathname}`, import.meta.url), 'utf8');
        const contentType = url.pathname.endsWith('.json') ? 'application/json' : (url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
        await route.fulfill({ contentType, body });
      } catch {
        await route.fulfill({ status: 404, contentType: 'text/plain', body: `Missing fixture asset: ${url.pathname}` });
      }
      return;
    }
    await route.fulfill({ status: 404 });
  });

  await page.goto('http://nia.test/');
  await page.waitForFunction(() => Boolean(window.test));
  const group = page.locator('#subject-household-group');
  const select = page.locator('#subject-household-id');
  const selectControl = page.locator('[data-select-id="subject-household-id"]');
  const readonly = page.locator('#subject-household-readonly');

  await page.evaluate(() => window.test.render(null));
  assert.equal(await group.isVisible(), true, 'create mode must expose ownership when the user belongs to a household');
  assert.deepEqual(await select.locator('option').allTextContents(), ['Nur für mich', 'Haushalt „Zuhause“']);
  assert.equal(await select.inputValue(), '', 'new entities must default to personal ownership');
  assert.equal(await select.isDisabled(), false);
  assert.equal(await readonly.isHidden(), true);

  await select.selectOption('7');
  assert.equal(await page.evaluate(() => window.test.value()), '7');
  assert.deepEqual(await page.evaluate(() => window.test.changes()), ['7']);

  await page.evaluate(() => window.test.render({ id: 11, ownership_type: 'user', owner_household_id: null }, true));
  assert.equal(await select.inputValue(), '');
  assert.equal(await select.isDisabled(), false, 'a personal manager may choose household ownership');

  await page.evaluate(() => window.test.render({ id: 12, ownership_type: 'household', owner_household_id: 7, household_name: 'Zuhause' }, true));
  assert.equal(await select.inputValue(), '7');
  assert.equal(await select.isDisabled(), true, 'household ownership is irreversible in the entity editor');
  assert.equal(await selectControl.isVisible(), true, 'the household manager uses exactly one disabled ownership control');
  assert.equal(await readonly.isHidden(), true, 'the household manager uses the disabled shared select');

  await page.evaluate(() => window.test.render({ id: 12, ownership_type: 'household', owner_household_id: 7, household_name: 'Zuhause' }, false));
  assert.equal(await select.isHidden(), true, 'ordinary household members must not receive an ownership control');
  assert.equal(await selectControl.isHidden(), true, 'ordinary household members must not receive the custom ownership control');
  assert.equal(await readonly.isVisible(), true);
  assert.equal((await readonly.textContent()).trim(), 'Haushalt „Zuhause“');

  await page.evaluate(() => { window.test.setHousehold(null); window.test.render(null); });
  assert.equal(await group.isHidden(), true, 'users without a household must not receive an empty ownership field');

  assert.deepEqual(pageErrors, []);
  console.log('✅ Shared entity ownership field passed');
} finally {
  await browser.close();
}

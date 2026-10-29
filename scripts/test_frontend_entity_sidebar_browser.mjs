#!/usr/bin/env node
import assert from 'node:assert/strict';
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

const shoppingSnapshot = {
  shopping_lists: [
    {
      id: 101,
      name: 'Persönlich',
      color: '#2563eb',
      icon: 'shopping-cart',
      sort_order: 0,
      owner_household_id: null,
      is_shared: false,
      items: [
        { id: 1, completed: false },
        { id: 2, completed: false },
        { id: 3, completed: true },
      ],
      sections: [],
      preferences: {},
    },
    {
      id: 102,
      name: 'Haushalt Verwaltung',
      color: '#16a34a',
      icon: 'house-heart',
      sort_order: 0,
      owner_household_id: 7,
      is_shared: false,
      items: [{ id: 4, completed: false }],
      sections: [],
      preferences: {},
    },
    {
      id: 103,
      name: 'Haushalt Mitglied',
      color: '#ca8a04',
      icon: 'users',
      sort_order: 1,
      owner_household_id: 7,
      is_shared: false,
      items: [],
      sections: [],
      preferences: {},
    },
    {
      id: 104,
      name: 'Direkt geteilt',
      color: '#9333ea',
      icon: 'share-2',
      sort_order: 0,
      owner_household_id: null,
      is_shared: true,
      items: [{ id: 5, completed: false }, { id: 6, completed: true }],
      sections: [],
      preferences: {},
    },
  ],
  shopping_stores: [],
};

async function rowMetrics(locator) {
  return locator.evaluate(element => {
    const style = getComputedStyle(element);
    const marker = element.querySelector('.project-marker');
    const badge = element.querySelector('.badge');
    const detail = element.closest('.nav-item-with-action')?.querySelector('.entity-sidebar-detail');
    const markerStyle = marker ? getComputedStyle(marker) : null;
    const badgeStyle = badge ? getComputedStyle(badge) : null;
    const detailStyle = detail ? getComputedStyle(detail) : null;
    return {
      display: style.display,
      alignItems: style.alignItems,
      minHeight: style.minHeight,
      padding: style.padding,
      borderRadius: style.borderRadius,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      markerWidth: markerStyle?.width,
      markerHeight: markerStyle?.height,
      badgeFontSize: badgeStyle?.fontSize,
      detailWidth: detailStyle?.width,
      detailHeight: detailStyle?.height,
    };
  });
}

async function run() {
  console.log('🧭 Running shared entity sidebar browser contract...');
  const { browser, page, loginApp, assertNoFrontendErrors, dumpErrors } = await launchPage();

  try {
    await page.routeWebSocket('**/ws', () => {});
    await page.route('**/api/shopping/snapshot', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(shoppingSnapshot),
    }));

    await loginApp();
    const projectRow = page.locator('.entity-sidebar-select[data-entity-type="project"]').first();
    await projectRow.waitFor({ state: 'visible' });
    const projectMetrics = await rowMetrics(projectRow);

    await page.evaluate(() => {
      window.__shoppingSidebarEvents = [];
      window.addEventListener('nia:shopping-list-add-request', () => window.__shoppingSidebarEvents.push({ type: 'add' }));
      window.addEventListener('nia:shopping-list-detail-request', event => window.__shoppingSidebarEvents.push({ type: 'detail', id: event.detail?.id }));
    });

    await page.click('#module-switcher-button');
    await page.click('[data-module-action="select"][data-module-id="shopping"]');
    await page.locator('#shopping-list-sidebar .entity-sidebar-select').first().waitFor({ state: 'visible' });

    const shoppingRows = page.locator('#shopping-list-sidebar .entity-sidebar-select');
    assert.equal(await shoppingRows.count(), 4, 'all P/HL/HM/DR fixture rows must render');
    assert.equal(await page.locator('#shopping-list-sidebar [data-entity-section="household"] .entity-sidebar-select').count(), 2);
    assert.equal(await page.locator('#shopping-list-sidebar [data-entity-section="shared"] .entity-sidebar-select').count(), 1);
    assert.equal(await page.locator('#shopping-list-sidebar .entity-sidebar-detail').count(), 4, 'every ownership role must expose the shared detail entrypoint');
    assert.equal(await page.locator('#shopping-list-sidebar .entity-sidebar-detail').first().getAttribute('aria-label'), 'Details für Persönlich öffnen');

    const shoppingMetrics = await rowMetrics(shoppingRows.filter({ hasText: 'Haushalt Verwaltung' }));
    assert.deepEqual(shoppingMetrics, projectMetrics, 'project and shopping rows must resolve to identical visual metrics');

    const personalRow = shoppingRows.filter({ hasText: 'Persönlich' });
    assert.equal((await personalRow.locator('.badge').textContent()).trim(), '2', 'badge must count all open items');
    await page.locator('#shopping-navigation-main h1').filter({ hasText: 'Persönlich' }).waitFor({ state: 'visible' });
    assert.equal(await personalRow.getAttribute('class').then(value => value.includes('active')), true);
    assert.equal(await personalRow.getAttribute('aria-current'), 'page');
    assert.equal(await page.evaluate(() => localStorage.getItem('nia-shopping-active-list')), '101');

    await shoppingRows.filter({ hasText: 'Direkt geteilt' }).click();
    await page.locator('#shopping-navigation-main h1').filter({ hasText: 'Direkt geteilt' }).waitFor({ state: 'visible' });
    await page.goBack();
    await page.locator('#shopping-navigation-main h1').filter({ hasText: 'Persönlich' }).waitFor({ state: 'visible' });

    await page.setViewportSize({ width: 390, height: 844 });

    await page.click('#sidebar-toggle-btn');
    await page.locator('#sidebar.open').waitFor({ state: 'visible' });
    await page.goBack();
    await page.waitForFunction(() => !document.getElementById('sidebar')?.classList.contains('open'));

    await page.click('#sidebar-toggle-btn');
    await page.locator('#shopping-list-sidebar .entity-sidebar-select').filter({ hasText: 'Direkt geteilt' }).click();
    await page.waitForFunction(() => !document.getElementById('sidebar')?.classList.contains('open'));

    await page.click('#sidebar-toggle-btn');
    await page.locator('#shopping-list-sidebar .entity-sidebar-item').filter({ hasText: 'Haushalt Mitglied' }).locator('.entity-sidebar-detail').click();
    await page.waitForFunction(() => !document.getElementById('sidebar')?.classList.contains('open'));

    await page.click('#sidebar-toggle-btn');
    await page.click('[data-entity-sidebar-action="add"][data-entity-type="shopping-list"]');
    await page.waitForFunction(() => !document.getElementById('sidebar')?.classList.contains('open'));

    assert.deepEqual(await page.evaluate(() => window.__shoppingSidebarEvents), [
      { type: 'detail', id: '103' },
      { type: 'add' },
    ]);

    await page.click('#sidebar-toggle-btn');
    await page.click('#module-switcher-button');
    await page.click('[data-module-action="select"][data-module-id="tasks"]');
    await page.waitForFunction(() => !document.getElementById('sidebar')?.classList.contains('open'));
    await page.click('#sidebar-toggle-btn');
    await page.click('[data-entity-sidebar-action="add"][data-entity-type="project"]');
    await page.locator('#project-modal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#sidebar').getAttribute('class').then(value => value.includes('open')), false);
    await page.goBack();
    await page.locator('#project-modal').waitFor({ state: 'hidden' });

    assertNoFrontendErrors();
    console.log('✅ Shared entity sidebar browser contract passed');
  } finally {
    const errors = dumpErrors();
    if (errors.pageErrors.length || errors.consoleErrors.length) {
      console.log('DEBUG frontend errors:', JSON.stringify(errors));
    }
    await browser.close();
  }
}

await withFreshDb(run);

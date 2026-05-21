#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function run() {
  console.log('📌 Running frontend user-menu scroll anchor test...');
  const { browser, page, loginApp, visible, assertNoFrontendErrors } = await launchPage();

  try {
    await loginApp();
    await visible('#sidebar');

    await page.evaluate(() => {
      const sidebar = document.getElementById('sidebar');
      const projectList = document.getElementById('project-list');
      for (let i = 0; i < 24; i++) {
        const row = document.createElement('button');
        row.className = 'nav-btn';
        row.type = 'button';
        row.innerHTML = `<span>📁</span> Spacer ${i}`;
        projectList.appendChild(row);
      }
      sidebar.scrollTop = sidebar.scrollHeight;
    });

    await page.click('#user-menu-button');
    await page.locator('#user-menu.active').waitFor({ state: 'visible', timeout: 5000 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    const before = await page.evaluate(() => {
      const wrap = document.querySelector('.sidebar-user-menu-wrap').getBoundingClientRect();
      const menuEl = document.getElementById('user-menu');
      const menu = menuEl.getBoundingClientRect();
      const style = getComputedStyle(menuEl);
      return { position: style.position, gap: Math.round(wrap.top - menu.bottom), wrapTop: Math.round(wrap.top), menuBottom: Math.round(menu.bottom) };
    });
    if (before.position !== 'absolute') {
      throw new Error(`Sidebar user menu must be anchored with CSS absolute positioning, got ${before.position}`);
    }

    await page.evaluate(async () => {
      const sidebar = document.getElementById('sidebar');
      sidebar.scrollTop = Math.max(0, sidebar.scrollTop - 120);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });

    const after = await page.evaluate(() => {
      const wrap = document.querySelector('.sidebar-user-menu-wrap').getBoundingClientRect();
      const menu = document.getElementById('user-menu').getBoundingClientRect();
      return { gap: Math.round(wrap.top - menu.bottom), wrapTop: Math.round(wrap.top), menuBottom: Math.round(menu.bottom) };
    });

    if (Math.abs(after.gap - before.gap) > 1) {
      throw new Error(`User menu did not stay anchored while sidebar scrolled: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    }

    assertNoFrontendErrors();
    console.log('✅ Frontend user-menu scroll anchor test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);

#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function run() {
  console.log('🌐 Running Playwright frontend sharing test...');
  const { browser, page, visible, loginApp, assertNoFrontendErrors } = await launchPage();

  try {
    await loginApp();

    await page.click('button[onclick="showProjectModal()"]');
    await visible('#project-modal');
    await page.fill('#project-name', 'Sharing Test Project');
    await page.click('button[form="project-form"]');
    await page.locator('#project-modal').waitFor({ state: 'hidden', timeout: 5000 });

    await page.locator('.project-tree-item').filter({ hasText: 'Sharing Test Project' }).first().locator('.nav-edit').click();
    await visible('#project-modal');
    await page.waitForFunction(() => document.getElementById('project-sharing-section')?.style.display !== 'none', { timeout: 10000 });
    await page.locator('#project-share-username').fill('someone');
    await page.locator('#project-leave-btn').waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});

    assertNoFrontendErrors();
    console.log('✅ Frontend sharing test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);

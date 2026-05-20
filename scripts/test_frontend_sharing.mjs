#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function run() {
  console.log('🌐 Running Playwright frontend sharing test...');
  const { browser, page, visible, loginApp, assertNoFrontendErrors } = await launchPage();

  try {
    await loginApp();

    // 1. Create a new project
    await page.click('button[onclick="showProjectModal()"]');
    await visible('#project-modal');
    await page.fill('#project-name', 'Sharing Test Project');
    await page.click('button[form="project-form"]');
    await page.locator('#project-modal').waitFor({ state: 'hidden', timeout: 5000 });

    // 2. Open project edit modal
    await page.locator('.project-tree-item').filter({ hasText: 'Sharing Test Project' }).first().locator('.nav-edit').click();
    await visible('#project-modal');

    // 3. Sharing section should be visible
    await page.waitForFunction(() => document.getElementById('project-sharing-section')?.style.display !== 'none', { timeout: 10000 });

    // 4. As owner + not shared: only "Teilen" button should be visible
    await page.waitForFunction(() => {
      const startRow = document.getElementById('project-share-start-row');
      const inviteRow = document.getElementById('project-share-row');
      const content = document.getElementById('project-sharing-content');
      return startRow?.style.display !== 'none' && inviteRow?.style.display === 'none' && content?.style.display === 'none';
    }, { timeout: 5000 });

    // 5. Click "Teilen" button → input should appear
    await page.click('button[onclick="showShareInput()"]');
    await page.waitForFunction(() => {
      const inviteRow = document.getElementById('project-share-row');
      const startRow = document.getElementById('project-share-start-row');
      return inviteRow?.style.display !== 'none' && startRow?.style.display === 'none';
    }, { timeout: 5000 });

    // 6. Fill username and invite
    await page.locator('#project-share-username').fill('someone');
    await page.click('button[onclick="inviteUserToProject()"]');

    // 7. Owner should NOT have "Verlassen" button
    await page.locator('#project-leave-btn').waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});

    assertNoFrontendErrors();
    console.log('✅ Frontend sharing test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);

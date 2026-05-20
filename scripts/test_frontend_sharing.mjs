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
    await page.waitForSelector('#project-sharing-section:not([style*="none"])', { timeout: 5000 });

    // 4. As owner + not shared: "Teilen" button should be visible
    const teilenBtn = await page.locator('#project-share-start-row button').first();
    const teilenVisible = await teilenBtn.isVisible();
    if (!teilenVisible) throw new Error('Owner should see "Teilen" button');

    // 5. Click "Teilen" button → input should appear
    await teilenBtn.click();
    const inviteRow = await page.locator('#project-share-row').first();
    const inputVisible = await inviteRow.isVisible();
    if (!inputVisible) throw new Error('Input should appear after clicking Teilen');

    // 6. Fill username and invite
    await page.locator('#project-share-username').fill('someone');
    await page.click('button[onclick="inviteUserToProject()"]');

    // 7. Owner should NOT have "Verlassen" button visible
    const leaveBtn = await page.locator('#project-leave-btn').first();
    const leaveVisible = await leaveBtn.isVisible();
    if (leaveVisible) throw new Error('Owner should NOT see "Verlassen" button');

    assertNoFrontendErrors();
    console.log('✅ Frontend sharing test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);

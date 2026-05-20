#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function run() {
  console.log('🌐 Running Playwright frontend sharing test...');
  const { browser, page, visible, loginApp, assertNoFrontendErrors } = await launchPage();

  try {
    await loginApp();

    // 1. Create a project via API
    const tokenResult = await page.evaluate(async () => {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'frontenduser', password: 'FrontendPass123!' }),
        credentials: 'include'
      });
      return await r.json();
    });

    const createResult = await page.evaluate(async ({ jwt, csrf }) => {
      const r = await fetch('/api/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
          'X-CSRF-Token': csrf
        },
        body: JSON.stringify({ name: 'Sharing Test Project', color: '#6366f1' }),
        credentials: 'include'
      });
      return await r.json();
    }, { jwt: tokenResult.access_token, csrf: tokenResult.csrf_token });

    if (!createResult.id) throw new Error('Failed to create project: ' + JSON.stringify(createResult));

    // Reload page so project appears
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#user-name').waitFor({ state: 'visible', timeout: 10000 });

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

    // 6. Owner should NOT have "Verlassen" button visible
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

#!/usr/bin/env node
import { withFreshDb, launchPage, ADMIN_PASSWORD } from './frontend_test_lib.mjs';

async function run() {
  console.log('🌐 Running Playwright frontend sharing test...');
  const { browser, page, visible, loginApp, assertNoFrontendErrors } = await launchPage();

  try {
    await loginApp();

    // ─── Setup: Create project via API ───
    const tokenResult = await page.evaluate(() => ({
      access_token: localStorage.getItem('jwt_token'),
      csrf_token: localStorage.getItem('csrf_token'),
    }));

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
    await page.locator('#user-menu-button').waitFor({ state: 'visible', timeout: 10000 });

    // ─── Test UI Flow ───

    // 1. Open project edit modal
    await page.locator('.project-tree-item').filter({ hasText: 'Sharing Test Project' }).first().locator('.nav-edit').click();
    await visible('#project-modal');

    // 2. Sharing section should be visible
    await page.waitForSelector('#project-sharing-section:not([style*="none"])', { timeout: 5000 });

    // 3. As owner + not shared: "Teilen" button should be visible
    const teilenBtn = await page.locator('#project-share-start-row button').first();
    const teilenVisible = await teilenBtn.isVisible();
    if (!teilenVisible) throw new Error('Owner should see "Teilen" button');

    // 4. Click "Teilen" button → input should appear
    await teilenBtn.click();
    const inviteRow = await page.locator('#project-share-row').first();
    const inputVisible = await inviteRow.isVisible();
    if (!inputVisible) throw new Error('Input should appear after clicking Teilen');

    // 5. Invite errors should be inline, not undo-toasts
    await page.fill('#project-share-username', 'missinguser');
    await page.locator('#project-share-row button').click();
    await page.getByText('Benutzer oder E-Mail "missinguser" nicht gefunden').waitFor({ state: 'visible', timeout: 10000 });
    const undoVisibleAfterError = await page.locator('#toast-undo').isVisible().catch(() => false);
    if (undoVisibleAfterError) throw new Error('Invite validation errors must not show undo button');

    // 6. Create a target user, invite them, close/reopen modal: sharing section should be expanded automatically
    const adminLogin = await page.evaluate(async (password) => {
      const r = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        credentials: 'include'
      });
      return await r.json();
    }, ADMIN_PASSWORD);
    if (!adminLogin.access_token) throw new Error('Admin login failed for sharing test');

    const createdUser = await page.evaluate(async ({ jwt, csrf }) => {
      const r = await fetch('/api/admin/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
          'X-CSRF-Token': csrf
        },
        body: JSON.stringify({ username: 'moni', display_name: 'Moni', email: 'moni@example.invalid' }),
        credentials: 'include'
      });
      return await r.json();
    }, { jwt: adminLogin.access_token, csrf: adminLogin.csrf_token });
    if (!createdUser.id) throw new Error('Failed to create invite target user: ' + JSON.stringify(createdUser));
    await page.evaluate(async ({ setupUrl }) => {
      const token = new URL(setupUrl).searchParams.get('token');
      const r = await fetch('/api/password-setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: 'MoniPass123!' }),
        credentials: 'include'
      });
      if (!r.ok) throw new Error('Failed to set invite target password: ' + JSON.stringify(await r.json().catch(() => ({}))));
    }, { setupUrl: createdUser.password_setup_url });
    await page.evaluate(async () => {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'frontenduser', password: 'FrontendPass123!' }),
        credentials: 'include'
      });
      const data = await r.json();
      localStorage.setItem('jwt_token', data.access_token);
      localStorage.setItem('csrf_token', data.csrf_token);
    });

    await page.fill('#project-share-username', 'moni');
    await page.locator('#project-share-row button').click();
    await page.getByText('Einladung gesendet').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('ausstehend').waitFor({ state: 'visible', timeout: 10000 });
    await page.evaluate(() => window.closeModal('project-modal'));
    await page.locator('.project-tree-item').filter({ hasText: 'Sharing Test Project' }).first().locator('.nav-edit').click();
    await page.locator('#project-sharing-content').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#project-share-row').waitFor({ state: 'visible', timeout: 10000 });
    const teilenVisibleAfterInvite = await page.locator('#project-share-start-row button').isVisible().catch(() => false);
    if (teilenVisibleAfterInvite) throw new Error('Already shared projects should show sharing content without clicking Teilen');

    // 7. Member row should be compact and not use the old large Entfernen button
    await page.locator('.sharing-member-row').filter({ hasText: 'Moni' }).waitFor({ state: 'visible', timeout: 10000 });
    const oldRemoveVisible = await page.getByText('Entfernen').isVisible().catch(() => false);
    if (oldRemoveVisible) throw new Error('Member removal should be a compact x button, not a large Entfernen button');

    // 8. Owner should NOT have "Verlassen" button visible
    const leaveBtn = await page.locator('#project-leave-btn').first();
    const leaveVisible = await leaveBtn.isVisible();
    if (leaveVisible) throw new Error('Owner should NOT see "Verlassen" button');

    // 9. Accepted shared project should show owner info and muted readonly fields for the member
    await page.evaluate(async () => {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'moni', password: 'MoniPass123!' }),
        credentials: 'include'
      });
      const data = await r.json();
      localStorage.setItem('jwt_token', data.access_token);
      localStorage.setItem('csrf_token', data.csrf_token);
    });
    await page.evaluate(async ({ projectId, jwt, csrf }) => {
      const invites = await fetch('/api/projects/invites', {
        headers: { 'Authorization': `Bearer ${jwt}` },
        credentials: 'include'
      }).then(r => r.json());
      const invite = invites.invites.find(i => i.project_id === projectId);
      await fetch(`/api/projects/${projectId}/invites/${invite.id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
          'X-CSRF-Token': csrf
        },
        body: JSON.stringify({ accept: true }),
        credentials: 'include'
      });
    }, {
      projectId: createResult.id,
      jwt: await page.evaluate(() => localStorage.getItem('jwt_token')),
      csrf: await page.evaluate(() => localStorage.getItem('csrf_token')),
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#user-menu-button').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('.shared-title').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('.project-tree-item').filter({ hasText: 'Sharing Test Project' }).first().locator('.nav-edit').click();
    await page.locator('#project-owner-info').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('Geteilt von').waitFor({ state: 'visible', timeout: 10000 });
    const readonlyClass = await page.locator('#project-form').evaluate(el => el.classList.contains('readonly-project'));
    if (!readonlyClass) throw new Error('Shared project form should have readonly-project styling');
    const nameDisabled = await page.locator('#project-name').isDisabled();
    if (!nameDisabled) throw new Error('Shared project name field should be disabled for non-owner');
    await page.evaluate(() => window.closeModal('project-modal'));

    // 10. Shared projects must be selectable in the Todo modal even when they are outside the member's workspace.
    await page.getByRole('button', { name: /Neues Todo/ }).click();
    await visible('#todo-modal');
    const sharedOptionCount = await page.locator('#todo-project option').filter({ hasText: 'Sharing Test Project' }).count();
    if (sharedOptionCount !== 1) throw new Error('Shared project missing from Todo project select');
    await page.selectOption('#todo-project', String(createResult.id));
    await page.fill('#todo-title', 'Todo in Shared Project');
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.locator('.todo-item').filter({ hasText: 'Todo in Shared Project' }).waitFor({ state: 'visible', timeout: 10000 });

    assertNoFrontendErrors();
    console.log('✅ Frontend sharing test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);

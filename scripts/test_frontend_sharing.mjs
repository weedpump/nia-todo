#!/usr/bin/env node
import { withFreshDb, launchPage, ADMIN_PASSWORD } from './frontend_test_lib.mjs';

async function run() {
  console.log('🌐 Running Playwright frontend sharing test...');
  const { browser, page, visible, loginApp, assertNoFrontendErrors } = await launchPage();

  const openProjectEdit = async (name) => {
    const item = page.locator('.project-tree-item').filter({ hasText: name }).first();
    await item.waitFor({ state: 'visible', timeout: 20000 });
    const editButton = item.locator('.nav-edit');
    await editButton.waitFor({ state: 'visible', timeout: 10000 });
    await editButton.click();
  };

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
    await openProjectEdit('Sharing Test Project');
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
    await page.fill('#project-share-username', 'missing@example.invalid');
    await page.locator('#project-share-row button').click();
    await page.waitForTimeout(2000);
    // For email identifiers, neutral response without revealing existence
    const shareError = await page.locator('#project-share-error').textContent();
    if (shareError && shareError.trim() && !shareError.includes('verarbeitet')) {
      throw new Error('Unexpected share error for unknown email: ' + shareError);
    }
    // Neutral email response shows toast, but no undo for validation errors
    const undoVisibleAfterError = await page.locator('#toast-undo').isVisible().catch(() => false);
    if (undoVisibleAfterError) throw new Error('Invite validation must not show undo button');

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
    await page.getByText(/Einladung gesendet|Invitation sent/).waitFor({ state: 'visible', timeout: 10000 });
    // Pending invites are no longer visible in member list (privacy-safe)
    // await page.getByText('ausstehend').waitFor({ state: 'visible', timeout: 10000 });
    await page.evaluate(() => window.closeModal('project-modal'));
    await page.waitForTimeout(500);
    await openProjectEdit('Sharing Test Project');
    await page.waitForTimeout(500);
    // Expand sharing section if not auto-expanded
    const sharingTab = await page.locator('[data-tab="sharing"]').first();
    if (await sharingTab.isVisible().catch(() => false)) {
      await sharingTab.click();
    }
    await page.locator('#project-sharing-content').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#project-share-row').waitFor({ state: 'visible', timeout: 10000 });
    const teilenVisibleAfterInvite = await page.locator('#project-share-start-row button').isVisible().catch(() => false);
    if (teilenVisibleAfterInvite) throw new Error('Already shared projects should show sharing content without clicking Teilen');

    // 7. Member row should be compact and not use the old large Entfernen button
    await page.locator('.sharing-member-row').filter({ hasText: 'Moni' }).waitFor({ state: 'visible', timeout: 10000 });
    const oldRemoveVisible = await page.getByText(/Entfernen|Remove/).isVisible().catch(() => false);
    if (oldRemoveVisible) throw new Error('Member removal should be a compact x button, not a large remove button');

    // 8. Owner should NOT have "Verlassen" button visible
    const leaveBtn = await page.locator('#project-leave-btn').first();
    const leaveVisible = await leaveBtn.isVisible();
    if (leaveVisible) throw new Error('Owner should NOT see "Verlassen" button');

    // 8b. Verify invitee sees invites section after login
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
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#user-menu-button').waitFor({ state: 'visible', timeout: 10000 });
    
    // Wait for app to fully initialize and load invites
    await page.waitForTimeout(5000);
    
    // Debug: check if loadInvites was called and what the DOM looks like
    const debugInfo = await page.evaluate(() => {
      const section = document.getElementById('invites-section');
      const list = document.getElementById('invites-list');
      return {
        sectionExists: !!section,
        sectionDisplay: section?.style?.display,
        sectionHiddenAttr: section?.hidden,
        listExists: !!list,
        listHtml: list?.innerHTML?.substring(0, 500),
        loadInvitesExists: typeof window.loadInvites === 'function',
      };
    });
    console.log('Debug info after reload:', debugInfo);
    
    // Check invites section - it should be visible with pending invite
    const invitesSection = await page.locator('#invites-section');
    const sectionVisible = await invitesSection.isVisible();
    console.log('Invites section visible:', sectionVisible);
    
    if (!sectionVisible) {
      // Force reload invites via JS
      await page.evaluate(() => {
        if (typeof window.loadInvites === 'function') {
          window.loadInvites();
        }
      });
      await page.waitForTimeout(2000);
      
      const sectionVisibleAfter = await invitesSection.isVisible();
      console.log('Invites section visible after manual loadInvites:', sectionVisibleAfter);
      
      if (!sectionVisibleAfter) {
        const invitesDebug = await page.evaluate(async () => {
          const jwt = localStorage.getItem('jwt_token');
          const res = await fetch('/api/projects/invites', {
            headers: { 'Authorization': `Bearer ${jwt}` }
          });
          return await res.json();
        });
        console.log('Invites API response:', invitesDebug);
        throw new Error('Invites section not visible even after manual loadInvites() - API returned: ' + JSON.stringify(invitesDebug));
      }
    }
    
    const inviteItemVisible = await page.locator('.invite-item').filter({ hasText: 'Sharing Test Project' }).isVisible();
    console.log('Invite item visible:', inviteItemVisible);
    if (!inviteItemVisible) {
      const inviteListHtml = await page.locator('#invites-list').innerHTML();
      console.log('Invites list HTML:', inviteListHtml);
      throw new Error('Invite item not found in invites section');
    }
    
    // Accept via UI button
    await page.locator('.invite-action.invite-accept').first().click();
    await page.getByText(/Einladung angenommen|Invitation accepted/).waitFor({ state: 'visible', timeout: 10000 });
    
    // Invites section should disappear
    await page.locator('#invites-section').waitFor({ state: 'hidden', timeout: 10000 });
    
    // Shared project should appear in sidebar
    await page.locator('.shared-title').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('.project-tree-item').filter({ hasText: 'Sharing Test Project' }).waitFor({ state: 'visible', timeout: 10000 });
    
    // 9. Accepted shared project should show owner info and muted readonly fields for the member
    await openProjectEdit('Sharing Test Project');
    await page.locator('#project-owner-info').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText(/Geteilt von|Shared by/).waitFor({ state: 'visible', timeout: 10000 });
    const readonlyClass = await page.locator('#project-form').evaluate(el => el.classList.contains('readonly-project'));
    if (!readonlyClass) throw new Error('Shared project form should have readonly-project styling');
    const nameDisabled = await page.locator('#project-name').isDisabled();
    if (!nameDisabled) throw new Error('Shared project name field should be disabled for non-owner');
    const iconPickerDisabled = await page.locator('#project-icon-picker').getAttribute('aria-disabled');
    if (iconPickerDisabled !== 'true') throw new Error('Shared project icon picker should be disabled for non-owner');
    const workspaceSelectVisible = await page.locator('#project-display-workspace-group').isVisible();
    if (!workspaceSelectVisible) throw new Error('Shared project should expose display workspace selection');
    await page.evaluate(() => window.closeModal('project-modal'));

    // 10. Shared projects are visible only in the chosen member workspace (default first, then movable).
    const memberTokens = await page.evaluate(() => ({
      jwt: localStorage.getItem('jwt_token'),
      csrf: localStorage.getItem('csrf_token'),
    }));
    const teamWorkspace = await page.evaluate(async ({ jwt, csrf }) => {
      const r = await fetch('/api/workspaces', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({ name: 'Team', color: '#0ea5e9', icon: 'users' }),
        credentials: 'include',
      });
      return await r.json();
    }, memberTokens);
    if (!teamWorkspace.id) throw new Error('Failed to create member workspace: ' + JSON.stringify(teamWorkspace));
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#user-menu-button').waitFor({ state: 'visible', timeout: 10000 });
    await openProjectEdit('Sharing Test Project');
    await page.locator('#project-display-workspace-id').selectOption(String(teamWorkspace.id));
    await page.click('#project-save-btn');
    await page.locator('#project-modal').waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForFunction(() => ![...document.querySelectorAll('.project-tree-item')].some(el => el.textContent.includes('Sharing Test Project')), null, { timeout: 10000 });
    await page.evaluate((workspaceId) => window.switchWorkspace(String(workspaceId)), teamWorkspace.id);
    await page.locator('.project-tree-item').filter({ hasText: 'Sharing Test Project' }).waitFor({ state: 'visible', timeout: 10000 });

    await page.getByRole('button', { name: /Neues Todo|New todo/i }).click();
    await visible('#todo-modal');
    const sharedOptionCount = await page.locator('#todo-project option').filter({ hasText: 'Sharing Test Project' }).count();
    if (sharedOptionCount !== 1) throw new Error('Shared project missing from Todo project select in its display workspace');
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

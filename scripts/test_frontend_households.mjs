#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

console.log('🏠 Running household frontend tests...');

const indexSource = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const dialogsSource = readFileSync(new URL('../web/static/js/modules/tasks-dialogs.js', import.meta.url), 'utf8');
const apiIndexSource = readFileSync(new URL('../web/static/js/api/index.js', import.meta.url), 'utf8');
const projectsApiSource = readFileSync(new URL('../web/static/js/api/projects.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../web/static/js/app.js', import.meta.url), 'utf8');
const renderingSource = readFileSync(new URL('../web/static/js/features/app-rendering.js', import.meta.url), 'utf8');
const syncSource = readFileSync(new URL('../web/static/js/features/sync.js', import.meta.url), 'utf8');
const sharingSource = readFileSync(new URL('../web/static/js/features/project-sharing.js', import.meta.url), 'utf8');
const iconsSource = readFileSync(new URL('../web/static/js/icons/lucide-generated.js', import.meta.url), 'utf8');
const lucideIconsSource = readFileSync(new URL('../web/static/js/icons/lucide-icons.js', import.meta.url), 'utf8');
const colorPickerSource = readFileSync(new URL('../web/static/js/ui/color-picker.js', import.meta.url), 'utf8');

assert.match(indexSource, /data-settings-page-target="household"/, 'household must be a separate settings page');
assert.match(indexSource, /data-settings-page="household"/, 'household settings page markup must exist');
assert.match(indexSource, /data-user-menu-action="household"/, 'user menu must link directly to household settings');
assert.match(indexSource, /id="user-menu-household-badge"/, 'user menu must expose a pending household invite badge');
assert.match(dialogsSource, /id="project-household-id"/, 'project modal must contain the project ownership field');
assert.match(dialogsSource, /data-i18n-key="project.for"/, 'project ownership field must use the Project for label');
assert.match(apiIndexSource, /householdsApi/, 'household API must be exported');
assert.match(projectsApiSource, /transferToHousehold/, 'projects API must expose household transfer');
assert.match(appSource, /householdsApi/, 'household API must be wired into the app');
assert.match(renderingSource, /house-heart/, 'household project section must render the bundled house-heart icon');
assert.match(syncSource, /const projectFields = \[[^\]]*'household_id'/, 'offline CREATE_PROJECT sanitization must retain household_id');
assert.match(sharingSource, /function isHouseholdProject\(project\)[\s\S]*owner_household_id[\s\S]*ownership_type === 'household'/, 'sharing modal state must identify household projects');
assert.match(sharingSource, /canMoveSharedDisplay = [^;]*!householdProject/, 'household projects must not regain workspace movement through sharing state');
assert.match(iconsSource, /"house-heart"/, 'house-heart must be bundled');

for (const locale of ['de', 'en', 'cs', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'es', 'zh-CN']) {
  const messages = JSON.parse(readFileSync(new URL(`../web/static/i18n/${locale}.json`, import.meta.url), 'utf8'));
  for (const key of [
    'menu.household',
    'settings.household.title', 'settings.household.hint', 'settings.household.pendingInviteCount',
    'settings.household.unknownMember', 'settings.household.invitedBy', 'settings.household.accept',
    'settings.household.decline', 'settings.household.noIncomingInvites', 'settings.household.owner',
    'settings.household.pending', 'settings.household.noOutgoingInvites', 'settings.household.loadFailed',
    'settings.household.create', 'settings.household.createHint', 'settings.household.namePlaceholder',
    'settings.household.name', 'settings.household.inviteLabel', 'settings.household.invitePlaceholder',
    'settings.household.invite', 'settings.household.members', 'settings.household.outgoingInvites',
    'settings.household.incomingInvites', 'settings.household.leave', 'settings.household.dissolve',
    'settings.household.dissolveProjectsTransfer', 'settings.household.leaveTitle',
    'settings.household.leaveMessage', 'settings.household.removeTitle', 'settings.household.removeMessage',
    'settings.household.removeMember', 'settings.household.transferTitle', 'settings.household.transferMessage',
    'settings.household.transferOwner', 'settings.household.dissolveTitle', 'settings.household.dissolveMessage',
    'settings.household.dissolveNameLabel', 'settings.household.dissolveNameMismatch',
    'project.for', 'project.forPersonal', 'project.forHousehold', 'project.householdBadge',
    'project.transferHousehold.title', 'project.transferHousehold.message',
    'project.transferHousehold.confirm', 'project.transferHousehold.cancel',
  ]) assert.equal(typeof messages[key], 'string', `${locale} must define ${key}`);
  assert.match(
    messages['project.transferHousehold.message'],
    locale === 'de' ? /direkte Freigaben.*Einladungen/ : /direct shares.*invitations/,
    `${locale} transfer warning must explain that direct sharing is removed`,
  );
}

const householdsSourceUrl = new URL('../web/static/js/features/households.js', import.meta.url);
const projectsSourceUrl = new URL('../web/static/js/features/projects.js', import.meta.url);
const renderingSourceUrl = new URL('../web/static/js/features/app-rendering.js', import.meta.url);
const householdsSource = readFileSync(householdsSourceUrl, 'utf8');
const projectsSource = readFileSync(projectsSourceUrl, 'utf8');
const settingsCss = readFileSync(new URL('../web/static/css/71-settings.css', import.meta.url), 'utf8');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const testHtml = `<!doctype html><html><head><link rel="stylesheet" href="/static/css/71-settings.css"></head><body>
    <button id="household-nav" data-settings-page-target="household"><span id="settings-household-nav-badge" class="settings-nav-notification-dot" hidden></span></button>
    <button id="user-menu-household" data-user-menu-action="household"><span id="user-menu-household-badge" class="user-menu-notification-badge" hidden></span></button>
    <div data-settings-page="general"></div>
    <div data-settings-page="household" hidden>
      <div id="settings-household-loading"></div>
      <div id="settings-household-error"></div>
      <div id="settings-household-create"></div>
      <input id="settings-household-create-name"><button data-household-action="create">create</button>
      <div id="settings-household-current" hidden>
        <input id="settings-household-name"><button data-household-action="rename">rename</button>
        <div id="settings-household-owner"></div>
        <input id="settings-household-invite-identifier"><button data-household-action="invite">invite</button>
        <div id="settings-household-members"></div>
        <div id="settings-household-outgoing"></div>
        <button id="settings-household-leave" data-household-action="leave">leave</button>
        <div id="settings-household-dissolve-wrap"><button id="settings-household-dissolve" data-household-action="dissolve">dissolve</button></div>
      </div>
      <div id="settings-household-incoming"></div>
    </div>
    <div id="project-modal"><form id="project-form">
      <input id="project-id"><input id="project-name"><input id="project-color" value="#6366f1"><input id="project-icon">
      <div id="project-icon-picker"></div><div id="project-color-picker"></div>
      <select id="project-parent-id"><option value=""></option></select>
      <div id="project-display-workspace-group"><select id="project-display-workspace-id"><option value="10">Personal</option></select></div>
      <div id="project-household-group"><select id="project-household-id"></select><div id="project-household-readonly"></div></div>
      <button id="project-save-btn" type="submit">save</button>
    </form><div id="project-sharing-section"><div id="project-sharing-content"><div id="project-members-list"></div></div><div id="project-share-start-row"><button type="button">share</button></div><div id="project-share-row"><input id="project-share-username"><button type="button">invite</button></div><div id="project-share-error"></div><div id="project-leave-row"><button id="project-leave-btn"></button></div><div id="project-owner-info"><span class="project-owner-name"></span></div></div><button id="project-delete-btn"></button><details id="project-detail-header-menu"></details><h3 id="project-modal-title"></h3></div>
    <div id="project-list"></div>
    <script type="module">
      import { createHouseholdsFeature } from '/static/js/features/households.js';
      import { createProjectsFeature } from '/static/js/features/projects.js';
      import { createProjectSharingFeature } from '/static/js/features/project-sharing.js';
      import { createAppRenderingFeature } from '/static/js/features/app-rendering.js';
      let snapshot = { household: null, householdInvites: [{ id: 31, household_id: 7, household_name: 'Invite Home', invited_by_username: 'owner' }] };
      let projects = [];
      let authoritativeProjects = [];
      let currentWorkspaceId = 10;
      const calls = [];
      const confirmQueue = [];
      const householdsApi = {
        current: async () => ({ household: snapshot.household }),
        listInvites: async () => ({ invites: snapshot.householdInvites }),
        create: async ({ name }) => ({ household: { id: 7, name, owner_user_id: 1, owner_username: 'me', role: 'owner', members: [] } }),
        update: async (id, { name }) => ({ household: { ...snapshot.household, name } }),
        invite: async (id, username) => { calls.push(['invite', id, username]); return {}; },
        respondInvite: async (householdId, inviteId, accept) => { calls.push(['respond', householdId, inviteId, accept]); return {}; },
        leave: async id => { calls.push(['leave', id]); return {}; },
        removeMember: async (id, userId) => { calls.push(['remove', id, userId]); return {}; },
        transferOwner: async (id, userId) => { calls.push(['transfer-owner', id, userId]); return {}; },
        dissolve: async id => { calls.push(['dissolve', id]); return {}; },
      };
      const households = createHouseholdsFeature({
        householdsApi,
        getCurrentUser: () => ({ id: 1, username: 'me' }),
        getAccessSnapshot: () => snapshot,
        setAccessSnapshot: next => { snapshot = next; },
        showSettingsPage: id => document.querySelectorAll('[data-settings-page]').forEach(el => { el.hidden = el.dataset.settingsPage !== id; }),
        confirmDanger: async opts => { calls.push(['confirm', opts]); return confirmQueue.shift() ?? true; },
        promptText: async opts => { calls.push(['prompt', opts]); return opts.testValue ?? snapshot.household?.name ?? ''; },
        onChanged: () => calls.push(['changed']),
      });
      households.bind();
      households.applyAccessSnapshot(snapshot);

      const projectsApi = {
        listMembers: async id => { calls.push(['project-list-members', id]); return { members: [] }; },
        transferToHousehold: async (id, householdId, parentId) => {
          calls.push(['project-transfer', id, householdId, parentId]);
          const transferredIds = new Set([id]);
          let changed = true;
          while (changed) {
            changed = false;
            projects.forEach(project => {
              if (project.parent_id != null && transferredIds.has(project.parent_id) && !transferredIds.has(project.id)) {
                transferredIds.add(project.id);
                changed = true;
              }
            });
          }
          authoritativeProjects = projects
            .filter(project => transferredIds.has(project.id))
            .map(project => ({ ...project, parent_id: project.id === id ? parentId : project.parent_id, owner_household_id: householdId, ownership_type: 'household', household_name: snapshot.household.name, workspace_id: 10, is_shared: 0, is_owner: 1 }));
          return { ...authoritativeProjects.find(project => project.id === id), transferred_projects: authoritativeProjects };
        },
      };
      const projectSharingFeature = createProjectSharingFeature({
        getProjects: () => projects,
        setProjects: next => { projects = next; },
        renderProjects: () => {}, renderStats: () => {}, renderTodos: () => {}, showToast: () => {},
        confirmDanger: async () => true,
        projectsApi,
      });

      const projectFeature = createProjectsFeature({
        getProjects: () => projects,
        getTodos: () => [], setTodos: () => {}, getCurrentProjectId: () => null,
        getCurrentWorkspaceId: () => currentWorkspaceId, getWorkspaces: () => [{ id: 10, name: 'Personal', is_default: true }, { id: 20, name: 'Work', is_default: false }],
        setProjects: next => { projects = next; }, dbPut: async (_store, project) => { if (project?.id === 46) throw new Error('simulated IndexedDB write failure'); }, deleteFromDB: async () => {},
        addToSyncQueue: async (action, data) => calls.push(['queue', action, data]), isOnlineForSync: () => false,
        syncWithServer: async () => {},
        refreshFromServer: async () => { calls.push(['refresh-projects']); throw new Error('simulated blocked authoritative refresh'); },
        renderProjects: () => {}, renderStats: () => {}, renderTodos: () => {}, closeModal: () => {},
        confirmDanger: async opts => { calls.push(['project-confirm', opts]); return confirmQueue.shift() ?? true; },
        showToast: () => {}, showBatchToast: () => {},
        projectsApi,
        sharingFeature: projectSharingFeature, getCurrentUser: () => ({ id: 1 }), getAccessSnapshot: () => snapshot,
      });

      window.test = {
        households, projectFeature, calls, confirmQueue,
        getSnapshot: () => snapshot,
        setSnapshot: next => { snapshot = next; households.applyAccessSnapshot(next); },
        setCurrentWorkspaceId: next => { currentWorkspaceId = next; },
        setProjects: next => { projects = next; authoritativeProjects = next.map(project => ({ ...project })); },
        getProjects: () => projects,
        clearCalls: () => { calls.length = 0; },
        renderProjectList: items => {
          projects = items;
          const feature = createAppRenderingFeature({
            appVersion: 'test', escapeHtml: value => String(value), escapeHtmlAttr: value => String(value),
            getTodos: () => [], getProjects: () => projects, getSections: () => [], getCurrentFilter: () => 'all',
            getCurrentProjectId: () => null, getCurrentWorkspaceId: () => 10, getHideDone: () => false, getTodayFocus: () => false,
            getShowProjectWidget: () => false, getDashboardPreferences: () => ({}), getMinimalTodos: () => false,
            getCurrentUser: () => ({ id: 1 }), getFocusFilters: () => ({}), getFocusFiltersExpanded: () => false,
            getFocusProjectMenuOpen: () => false, getFocusProjectSearch: () => '', sortTodoList: items => items,
            renderTodoItem: () => '', renderSectionHeader: () => '', getInvites: () => [],
          });
          feature.renderProjects();
        },
      };
    </script>
  </body></html>`;

  await page.route('http://nia.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/static/js/features/households.js') return route.fulfill({ contentType: 'text/javascript', body: householdsSource });
    if (pathname === '/static/js/features/projects.js') return route.fulfill({ contentType: 'text/javascript', body: projectsSource });
    if (pathname === '/static/js/features/project-sharing.js') return route.fulfill({ contentType: 'text/javascript', body: sharingSource });
    if (pathname === '/static/js/features/app-rendering.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync(renderingSourceUrl, 'utf8') });
    if (pathname === '/static/css/71-settings.css') return route.fulfill({ contentType: 'text/css', body: settingsCss });
    if (pathname === '/static/js/i18n/index.js') return route.fulfill({ contentType: 'text/javascript', body: "export const t=(key,args={})=>key==='project.forHousehold'?`Household “${args.name}”`:key==='project.householdBadge'?`Household: ${args.name}`:key; export const getActiveLocale=()=> 'en-US';" });
    if (pathname === '/static/js/icons/lucide-icons.js') return route.fulfill({ contentType: 'text/javascript', body: lucideIconsSource });
    if (pathname === '/static/js/icons/lucide-generated.js') return route.fulfill({ contentType: 'text/javascript', body: iconsSource });
    if (pathname === '/static/js/ui/color-picker.js') return route.fulfill({ contentType: 'text/javascript', body: colorPickerSource });
    if (pathname === '/static/js/ui/dropdowns.js') return route.fulfill({ contentType: 'text/javascript', body: 'export const hydrateSelect=()=>{}; export const refreshSelect=()=>{};' });
    if (pathname === '/static/js/features/ui-history.js') return route.fulfill({ contentType: 'text/javascript', body: 'export const openUiLayer=()=>{};' });
    if (pathname === '/static/js/core/config.js') return route.fulfill({ contentType: 'text/javascript', body: "export const apiResourceUrl=value=>value;" });
    if (pathname === '/static/js/core/authenticated-image.js') return route.fulfill({ contentType: 'text/javascript', body: 'export const loadAuthenticatedImage=async()=>false; export const releaseAuthenticatedImage=()=>{};' });
    if (pathname === '/static/js/features/dashboard-preferences.js') return route.fulfill({ contentType: 'text/javascript', body: 'export const calculateDashboardMetrics=()=>({}); export const filterTodosForDashboard=items=>items; export const filterTodosForDashboardDrilldown=items=>items; export const filterTodosForTodayFocus=items=>items; export const getEffectiveDashboardPreferences=()=>({stats:[],focusItems:[],activeProjects:{sort:"recent",limit:5},showFocus:false,showActiveProjects:false,groupByStatus:true}); export const selectDashboardWorkspaceTodos=items=>items;' });
    return route.fulfill({ contentType: 'text/html', body: testHtml });
  });
  await page.goto('http://nia.test/');
  await page.waitForFunction(() => Boolean(window.test));

  assert.equal(await page.locator('#user-menu-household-badge').textContent(), '1', 'pending invite count must be rendered');
  assert.equal(await page.locator('#user-menu-household-badge').isHidden(), false, 'pending invite badge must be visible');
  assert.equal(await page.locator('#settings-household-loading').evaluate(element => getComputedStyle(element).display), 'none', 'inactive loading state must not remain visually rendered');

  await page.evaluate(() => window.test.households.openSettings());
  await page.waitForFunction(() => !document.querySelector('[data-settings-page="household"]').hidden);
  assert.equal(await page.locator('[data-household-action="respond-invite"][data-accept="true"]').count(), 1, 'incoming invitation must render accept action');
  await page.click('[data-household-action="respond-invite"][data-accept="true"]');
  assert.deepEqual((await page.evaluate(() => window.test.calls)).find(call => call[0] === 'respond'), ['respond', 7, 31, true]);

  await page.fill('#settings-household-create-name', 'Family Home');
  await page.click('[data-household-action="create"]');
  await page.waitForFunction(() => window.test.getSnapshot().household?.name === 'Family Home');
  assert.equal(await page.locator('#settings-household-name').inputValue(), 'Family Home');
  assert.equal(await page.locator('#settings-household-create').isHidden(), true, 'household creation controls must be semantically hidden after a household exists');
  assert.equal(await page.locator('#settings-household-create').evaluate(element => getComputedStyle(element).display), 'none', 'household creation controls must not remain visually rendered');

  await page.evaluate(() => window.test.setSnapshot({ household: {
    id: 7, name: 'Family Home', owner_user_id: 1, owner_username: 'me', role: 'owner',
    members: [
      { id: 10, user_id: 2, username: 'alex', display_name: 'Alex', status: 'accepted' },
      { id: 11, user_id: 3, username: 'pending', display_name: 'Pat', status: 'pending' },
    ],
  }, householdInvites: [] }));
  assert.equal(await page.locator('#user-menu-household-badge').evaluate(element => getComputedStyle(element).display), 'none', 'user menu must not show a permanent household dot without invitations');
  assert.equal(await page.locator('#settings-household-nav-badge').evaluate(element => getComputedStyle(element).display), 'none', 'settings navigation must not show a permanent household dot without invitations');
  assert.equal(await page.locator('[data-household-action="remove-member"]').count(), 1, 'owner must be able to remove accepted members');
  assert.equal(await page.locator('[data-household-action="transfer-owner"]').count(), 1, 'owner must be able to transfer leadership');
  assert.equal(await page.locator('#settings-household-outgoing [data-household-status="pending"]').count(), 1, 'pending outgoing invites must be listed');
  assert.equal(await page.locator('#settings-household-leave').isHidden(), true, 'owner cannot leave before transferring leadership');
  assert.equal(await page.locator('#settings-household-leave').evaluate(element => getComputedStyle(element).display), 'none', 'owner leave action must not remain visually rendered');

  await page.evaluate(() => window.test.setSnapshot({ household: {
    id: 7, name: 'Family Home', owner_user_id: 9, owner_username: 'owner', role: 'member',
    members: [{ id: 10, user_id: 1, username: 'me', display_name: 'Me', status: 'accepted' }],
  }, householdInvites: [] }));
  assert.equal(await page.locator('#settings-household-name').isDisabled(), true, 'normal members must see the household name read-only');
  assert.equal(await page.locator('[data-household-action="invite"]').isHidden(), true, 'normal members cannot invite');
  assert.equal(await page.locator('#settings-household-leave').isHidden(), false, 'normal members may leave');
  assert.equal(await page.locator('#settings-household-dissolve-wrap').evaluate(element => element.hidden), true, 'normal members must not see owner-only dissolution controls');
  assert.equal(await page.locator('#settings-household-dissolve-wrap').evaluate(element => getComputedStyle(element).display), 'none', 'owner-only dissolution controls must not remain visually rendered for members');

  await page.evaluate(() => {
    window.test.setProjects([
      { id: 41, name: 'Existing household parent', color: '#123456', icon: null, parent_id: null, workspace_id: 10, user_id: 2, is_owner: 0, is_shared: 1, is_inbox: 0, ownership_type: 'household', owner_household_id: 7, household_name: 'Family Home' },
    ]);
    window.test.projectFeature.showProjectModal();
  });
  await page.selectOption('#project-household-id', '7');
  assert.equal(await page.locator('#project-parent-id option', { hasText: 'Existing household parent' }).count(), 1, 'ordinary members creating household projects must be able to choose existing household projects as parents');

  await page.evaluate(() => {
    window.test.setSnapshot({ household: { id: 7, name: 'Family Home', owner_user_id: 1, owner_username: 'me', role: 'owner', members: [] }, householdInvites: [] });
    window.test.setCurrentWorkspaceId(20);
    window.test.clearCalls();
    window.test.projectFeature.showProjectModal();
  });
  assert.equal(await page.locator('#project-household-group').isHidden(), false, 'project ownership field must be visible with a household');
  assert.equal(await page.locator('#project-household-id').inputValue(), '', 'new project must default to personal');
  await page.selectOption('#project-household-id', '7');
  await page.fill('#project-name', 'Family chores');
  await page.dispatchEvent('#project-name', 'input');
  await page.click('#project-save-btn');
  const createCall = (await page.evaluate(() => window.test.calls)).find(call => call[0] === 'queue' && call[1] === 'CREATE_PROJECT');
  assert.equal(createCall[2].household_id, 7, 'CREATE_PROJECT sync payload must include household_id');
  assert.equal(createCall[2].workspace_id, 10, 'household projects must be created in the personal default workspace');
  assert.equal((await page.evaluate(() => window.test.getProjects().at(-1).ownership_type)), 'household', 'new household projects must be marked locally before sync');
  assert.equal((await page.evaluate(() => window.test.getProjects().at(-1).workspace_id)), 10, 'local household projects must immediately use the personal default workspace');

  await page.evaluate(() => { window.test.projectFeature.showProjectModal(); });
  assert.equal(await page.locator('#project-household-id').inputValue(), '', 'every new project opening must reset to personal');
  await page.selectOption('#project-household-id', '7');
  assert.equal(await page.locator('#project-parent-id option', { hasText: 'Family chores' }).count(), 1, 'new household projects must offer existing household projects as parents even when another workspace is active');

  await page.evaluate(() => {
    window.test.clearCalls();
    window.test.setProjects([
      { id: 44, name: 'Personal plan', color: '#123456', icon: null, parent_id: null, workspace_id: 20, user_id: 1, is_owner: 1, is_shared: 0, is_inbox: 0, ownership_type: 'user', owner_household_id: null },
      { id: 46, name: 'Personal child', color: '#654321', icon: null, parent_id: 44, workspace_id: 20, user_id: 1, is_owner: 1, is_shared: 0, is_inbox: 0, ownership_type: 'user', owner_household_id: null },
      { id: 49, name: 'Household parent', color: '#abcdef', icon: null, parent_id: null, workspace_id: 10, user_id: 1, is_owner: 1, is_shared: 0, is_inbox: 0, ownership_type: 'household', owner_household_id: 7, household_name: 'Family Home' },
    ]);
    window.test.projectFeature.showProjectModal(window.test.getProjects()[0]);
  });
  await page.fill('#project-name', 'Unsaved rename');
  await page.click('#project-color-picker .color-picker-current');
  await page.click('#project-color-picker [data-color="#f43f5e"]');
  await page.click('#project-icon-picker .icon-picker-current');
  await page.click('#project-icon-picker [data-value="star"]');
  assert.equal(await page.locator('#project-color').inputValue(), '#f43f5e');
  assert.equal(await page.locator('#project-icon').inputValue(), 'star');
  await page.selectOption('#project-household-id', '7');
  assert.equal(await page.locator('#project-name').inputValue(), 'Personal plan', 'selecting household transfer must visibly discard unrelated pending edits before submission');
  assert.equal(await page.locator('#project-name').isDisabled(), true, 'household transfer mode must prevent concurrent metadata edits');
  assert.equal(await page.locator('#project-parent-id').isDisabled(), false, 'household transfer mode must allow placement inside the target household');
  assert.equal(await page.locator('#project-parent-id option', { hasText: 'Household parent' }).count(), 1, 'household transfer mode must offer parents from the target household');
  assert.equal(await page.locator('#project-display-workspace-id').isDisabled(), true, 'household transfer mode must prevent concurrent workspace edits');
  assert.equal(await page.locator('#project-display-workspace-id').inputValue(), '10', 'household transfer mode must visibly show the personal default workspace destination');
  assert.equal(await page.locator('#project-color-picker').evaluate(element => getComputedStyle(element).pointerEvents), 'none', 'household transfer mode must disable the custom color picker');
  assert.equal(await page.locator('#project-color-picker .color-picker-current-name').textContent(), '#123456', 'household transfer mode must visibly revert the custom color picker');
  assert.equal(await page.locator('#project-icon-picker [data-value=""]').getAttribute('aria-selected'), 'true', 'household transfer mode must visibly revert the custom icon picker');
  assert.equal(await page.locator('#project-icon-picker [data-value="star"]').getAttribute('aria-selected'), 'false', 'stale custom icon selection must be cleared');
  await page.evaluate(() => window.test.confirmQueue.push(false));
  await page.selectOption('#project-parent-id', '49');
  await page.click('#project-save-btn');
  assert.equal(await page.locator('#project-household-id').inputValue(), '', 'canceling household transfer confirmation must restore personal ownership');
  assert.equal(await page.locator('#project-display-workspace-id').inputValue(), '20', 'canceling household transfer confirmation must restore the persisted workspace');
  assert.equal(await page.locator('#project-parent-id').inputValue(), '', 'canceling household transfer confirmation must restore the persisted parent');
  assert.equal(await page.locator('#project-name').isDisabled(), false, 'canceling household transfer confirmation must restore editable metadata');
  assert.equal(await page.locator('#project-save-btn').evaluate(element => element.hidden), true, 'canceling transfer without edits must clear the dirty save action');
  assert.equal((await page.evaluate(() => window.test.calls)).some(call => call[0] === 'project-transfer'), false, 'canceling transfer must not call the transfer endpoint');
  await page.selectOption('#project-household-id', '7');
  await page.selectOption('#project-parent-id', '49');
  await page.click('#project-save-btn');
  await page.waitForFunction(() => window.test.calls.some(call => call[0] === 'project-transfer'));
  const projectCalls = await page.evaluate(() => window.test.calls);
  const confirmation = projectCalls.find(call => call[0] === 'project-confirm')[1];
  assert.equal(confirmation.title, 'project.transferHousehold.title');
  assert.match(confirmation.message, /project\.transferHousehold\.message/);
  assert.equal(confirmation.confirmText, 'project.transferHousehold.confirm');
  assert.deepEqual(projectCalls.find(call => call[0] === 'project-transfer'), ['project-transfer', 44, 7, 49]);
  assert.ok(!projectCalls.some(call => call[0] === 'refresh-projects'), 'complete transfer response must not depend on a queue-blockable full refresh');
  assert.equal((await page.evaluate(() => window.test.getProjects().find(project => project.id === 46)?.ownership_type)), 'household', 'complete transfer response must reconcile transferred descendants despite a local persistence failure');

  await page.evaluate(() => {
    window.test.clearCalls();
    window.test.setProjects([
      { id: 45, name: 'Household board', color: '#123456', icon: null, parent_id: null, workspace_id: 10, user_id: 2, is_owner: 1, is_shared: 0, is_inbox: 0, ownership_type: 'household', owner_household_id: 7, household_name: 'Family Home' },
      { id: 47, name: 'Household notes', color: '#654321', icon: null, parent_id: null, workspace_id: 10, user_id: 1, is_owner: 1, is_shared: 0, is_inbox: 0, ownership_type: 'household', owner_household_id: 7, household_name: 'Family Home' },
    ]);
    window.test.projectFeature.showProjectModal(window.test.getProjects()[1]);
  });
  assert.equal(await page.locator('#project-parent-id option', { hasText: 'Household board' }).count(), 1, 'editing a household project must offer other household projects as parents to the household owner');
  assert.equal(await page.locator('#project-sharing-section').isHidden(), true, 'household projects must not expose direct sharing controls to the household owner');
  assert.equal((await page.evaluate(() => window.test.calls)).some(call => call[0] === 'project-list-members'), false, 'household project dialogs must not call the direct-members endpoint');
  await page.evaluate(() => {
    window.test.setProjects([{ id: 48, name: 'Member-created household project', color: '#abcdef', icon: null, parent_id: null, workspace_id: 10, user_id: 1, is_owner: 0, is_shared: 1, is_inbox: 0, ownership_type: 'household', owner_household_id: 7, household_name: 'Family Home' }]);
    window.test.projectFeature.showProjectModal(window.test.getProjects()[0]);
  });
  assert.equal(await page.locator('#project-household-id').isDisabled(), true, 'normal members must not change household project ownership');
  assert.equal(await page.locator('#project-display-workspace-group').isHidden(), true, 'household projects cannot move workspace');
  assert.equal(await page.locator('#project-name').isDisabled(), true, 'normal members cannot edit household project fields');
  assert.equal(await page.locator('#project-save-btn').evaluate(element => element.hidden), true, 'normal members do not get a project save action');
  assert.equal(await page.locator('#project-sharing-section').isHidden(), true, 'household projects must not expose direct sharing controls to normal members');
  assert.equal(await page.locator('#project-share-start-row').isHidden(), true, 'explicit non-owner household creators must not receive sharing controls');

  await page.evaluate(() => window.test.renderProjectList([
    { id: 1, name: 'Personal', color: '#111111', parent_id: null, workspace_id: 10, ownership_type: 'user' },
    { id: 2, name: 'Family owner view', color: '#222222', parent_id: null, workspace_id: 10, is_shared: 0, ownership_type: 'household', owner_household_id: 7, household_name: 'Family Home' },
    { id: 3, name: 'Family member view', color: '#333333', parent_id: 2, workspace_id: 10, is_shared: 1, ownership_type: 'household', owner_household_id: 7, household_name: 'Family Home' },
    { id: 4, name: 'Direct share', color: '#444444', parent_id: null, workspace_id: 10, is_shared: 1, ownership_type: 'user' },
  ]));
  assert.equal(await page.locator('[data-project-section="personal"] .nav-btn[data-project-id="1"]').count(), 1, 'personal projects must remain in the personal section');
  assert.equal(await page.locator('[data-project-section="household"] .household-title .ui-icon').count(), 1, 'household section must have a house icon');
  assert.equal(await page.locator('[data-project-section="household"] .nav-btn[data-project-id="2"]').count(), 1, 'household projects must use the household section for the household owner');
  assert.equal(await page.locator('[data-project-section="household"] .nav-btn[data-project-id="3"]').count(), 1, 'household projects must use the household section for ordinary members');
  assert.equal(await page.locator('[data-project-section="shared"] .nav-btn[data-project-id="4"]').count(), 1, 'direct project shares must remain in the shared-project section');
  assert.equal(await page.locator('[data-project-section="shared"] .nav-btn[data-project-id="3"]').count(), 0, 'household projects must not also appear as direct shares');
  assert.equal(await page.locator('.project-household-badge').count(), 0, 'household projects must not repeat a household badge on every row');
} finally {
  await browser.close();
}

console.log('✅ Household frontend tests passed');

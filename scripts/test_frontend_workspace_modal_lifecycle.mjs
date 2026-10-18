#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

console.log('🧭 Running workspace modal lifecycle test...');

const workspacesSource = readFileSync(new URL('../web/static/js/features/workspaces.js', import.meta.url), 'utf8');
const uiHistorySource = readFileSync(new URL('../web/static/js/features/ui-history.js', import.meta.url), 'utf8');

const testHtml = `<!doctype html>
<html>
  <body>
    <div id="workspace-switcher">
      <button id="workspace-current-btn" aria-expanded="false"></button>
      <span id="workspace-current-name"></span>
      <span id="workspace-current-dot"></span>
      <div id="workspace-menu"></div>
    </div>
    <div class="modal" id="workspace-modal">
      <button type="button" data-workspace-action="close-modal" id="workspace-close-btn">Close</button>
      <h3 id="workspace-modal-title"></h3>
      <form id="workspace-form">
        <input id="workspace-id">
        <input id="workspace-name">
        <input id="workspace-color" value="#6366f1">
        <input id="workspace-icon">
        <div id="workspace-icon-picker"></div>
        <div id="workspace-color-picker"></div>
        <div id="workspace-error"></div>
        <button type="submit" id="workspace-save-btn">Save</button>
        <button type="button" id="workspace-delete-btn">Delete</button>
        <details id="workspace-detail-header-menu"></details>
      </form>
    </div>
    <script type="module">
      import { createWorkspacesFeature } from '/static/js/features/workspaces.js';

      const initialWorkspace = {
        id: 1,
        name: 'Existing workspace',
        color: '#6366f1',
        icon: null,
        is_default: true,
      };
      let workspaces = [initialWorkspace];
      let currentWorkspaceId = 1;
      let nextWorkspaceId = 2;
      const records = new Map();

      window.setFilter = filter => {
        history.pushState({ ...(history.state || {}), niaTodoView: true, filter }, '', location.pathname);
      };

      const feature = createWorkspacesFeature({
        workspacesApi: {
          create: async data => ({ id: nextWorkspaceId++, ...data, is_default: false }),
          update: async (id, data) => ({ ...workspaces.find(item => String(item.id) === String(id)), ...data }),
          delete: async () => ({}),
          list: async () => ({ workspaces }),
        },
        getWorkspaces: () => workspaces,
        setWorkspaces: value => { workspaces = value; },
        getCurrentWorkspaceId: () => currentWorkspaceId,
        setCurrentWorkspaceId: value => { currentWorkspaceId = value; },
        dbPut: async (store, value) => { records.set(\`${'${store}'}:${'${value.id}'}\`, value); },
        dbClear: async () => {},
        isOnlineForSync: () => true,
        refreshFromServer: async () => {},
        renderProjects: () => {},
        renderStats: () => {},
        renderTodos: () => {},
        closeSidebar: () => {},
        confirmDanger: async () => true,
        showToast: () => {},
      });
      feature.bindWorkspaceControls();
      window.workspaceTest = {
        feature,
        getWorkspaces: () => workspaces,
      };
    </script>
  </body>
</html>`;

const browser = await chromium.launch({ headless: true });
try {
  async function openHarness() {
    const page = await browser.newPage();
    await page.route('http://nia.test/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/static/js/features/workspaces.js') {
        await route.fulfill({ contentType: 'text/javascript', body: workspacesSource });
        return;
      }
      if (pathname === '/static/js/features/ui-history.js') {
        await route.fulfill({ contentType: 'text/javascript', body: uiHistorySource });
        return;
      }
      if (pathname === '/static/js/i18n/index.js') {
        await route.fulfill({ contentType: 'text/javascript', body: "export const t = key => key;" });
        return;
      }
      if (pathname === '/static/js/icons/lucide-icons.js') {
        await route.fulfill({
          contentType: 'text/javascript',
          body: "export const hydrateIcons = () => {}; export const iconSvg = () => ''; export const markerHtml = () => ''; export const renderIconPicker = () => {};",
        });
        return;
      }
      if (pathname === '/static/js/ui/color-picker.js') {
        await route.fulfill({ contentType: 'text/javascript', body: 'export const renderColorPicker = () => {};' });
        return;
      }
      await route.fulfill({ contentType: 'text/html', body: testHtml });
    });
    await page.goto('http://nia.test/');
    await page.waitForFunction(() => Boolean(window.workspaceTest));
    return page;
  }

  {
    const page = await openHarness();
    await page.evaluate(() => window.workspaceTest.feature.showWorkspaceModal());
    await page.fill('#workspace-name', 'Created workspace');
    await page.dispatchEvent('#workspace-name', 'input');
    await page.click('#workspace-save-btn');
    await page.waitForFunction(() => window.workspaceTest.getWorkspaces().length === 2);

    const activeAfterCreate = await page.locator('#workspace-modal').evaluate(element => element.classList.contains('active'));
    await page.click('#workspace-close-btn');
    const activeAfterClose = await page.locator('#workspace-modal').evaluate(element => element.classList.contains('active'));
    assert.deepEqual(
      { activeAfterCreate, activeAfterClose },
      { activeAfterCreate: false, activeAfterClose: false },
      'creating a workspace must close its modal without leaving the close action blocked',
    );
    await page.close();
  }

  {
    const page = await openHarness();
    await page.evaluate(() => window.workspaceTest.feature.showWorkspaceModal(1));
    await page.fill('#workspace-name', 'Renamed workspace');
    await page.dispatchEvent('#workspace-name', 'input');
    await page.click('#workspace-save-btn');
    await page.waitForFunction(() => window.workspaceTest.getWorkspaces()[0].name === 'Renamed workspace');
    await page.waitForFunction(() => !document.getElementById('workspace-modal').classList.contains('active'));

    assert.equal(
      await page.locator('#workspace-modal').evaluate(element => element.classList.contains('active')),
      false,
      'editing a workspace must continue to close its modal',
    );
    await page.close();
  }
} finally {
  await browser.close();
}

console.log('✅ Workspace modal lifecycle test passed');

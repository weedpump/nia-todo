#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

console.log('🧭 Running workspace modal lifecycle test...');

const workspacesSource = readFileSync(new URL('../web/static/js/features/workspaces.js', import.meta.url), 'utf8');
const uiHistorySource = readFileSync(new URL('../web/static/js/features/ui-history.js', import.meta.url), 'utf8');
const visibilitySource = readFileSync(new URL('../web/static/js/modules/visibility.js', import.meta.url), 'utf8');

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
        <div id="workspace-module-list"></div>
        <div id="workspace-error"></div>
        <button type="submit" id="workspace-save-btn">Save</button>
        <button type="button" id="workspace-delete-btn">Delete</button>
        <details id="workspace-detail-header-menu"></details>
      </form>
    </div>
    <script type="module">
      import { createWorkspacesFeature } from '/static/js/features/workspaces.js';
      import { bindUiHistory } from '/static/js/features/ui-history.js';

      const initialWorkspace = {
        id: 1,
        name: 'Existing workspace',
        color: '#6366f1',
        icon: null,
        is_default: true,
        hidden_modules: Array.from({ length: 128 }, (_, index) => 'future-' + index),
      };
      let workspaces = [initialWorkspace];
      let currentWorkspaceId = 1;
      let currentFilter = 'all';
      let nextWorkspaceId = 2;
      let delayCreate = false;
      let pendingCreateResolve = null;
      let deferHistoryBack = false;
      let deferredHistoryBack = null;
      const records = new Map();

      const nativeHistoryBack = history.back.bind(history);
      history.back = () => {
        if (deferHistoryBack) {
          deferredHistoryBack = nativeHistoryBack;
          return;
        }
        nativeHistoryBack();
      };

      window.setFilter = (filter, { replaceHistory = false } = {}) => {
        currentFilter = String(filter);
        localStorage.setItem('nia-last-filter', currentFilter);
        const state = { ...(history.state || {}), niaTodoView: true, filter };
        if (replaceHistory) history.replaceState(state, '', location.pathname);
        else history.pushState(state, '', location.pathname);
      };
      bindUiHistory();
      window.addEventListener('popstate', event => {
        if (!event.state?.niaTodoView) return;
        currentFilter = String(event.state.filter || 'all');
        localStorage.setItem('nia-last-filter', currentFilter);
      });

      const feature = createWorkspacesFeature({
        workspacesApi: {
          create: async data => {
            if (delayCreate) await new Promise(resolve => { pendingCreateResolve = resolve; });
            return { id: nextWorkspaceId++, ...data, is_default: false };
          },
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
        getState: () => ({ currentWorkspaceId, currentFilter, lastFilter: localStorage.getItem('nia-last-filter') }),
        delayNextCreate: () => { delayCreate = true; },
        isCreatePending: () => Boolean(pendingCreateResolve),
        releaseCreate: () => {
          delayCreate = false;
          const resolve = pendingCreateResolve;
          pendingCreateResolve = null;
          resolve?.();
        },
        deferNextHistoryBack: () => { deferHistoryBack = true; },
        flushHistoryBack: () => {
          deferHistoryBack = false;
          const run = deferredHistoryBack;
          deferredHistoryBack = null;
          run?.();
        },
        setInitialFilter: filter => {
          currentFilter = String(filter);
          localStorage.setItem('nia-last-filter', currentFilter);
          history.replaceState({ ...(history.state || {}), niaTodoView: true, filter: currentFilter }, '', location.pathname);
        },
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
      if (pathname === '/static/js/icons/nia-product-icons.js') {
        await route.fulfill({ contentType: 'text/javascript', body: "export const niaIconSvg = () => '';" });
        return;
      }
      if (pathname === '/static/js/modules/registry.js') {
        await route.fulfill({
          contentType: 'text/javascript',
          body: `export const MODULES = [
            { id: 'tasks', icon: 'check-circle', labelKey: 'module.tasks.label' },
            { id: 'shopping', icon: 'shopping-bag', labelKey: 'module.shopping.label' },
            { id: 'recipes', icon: 'utensils', labelKey: 'module.recipes.label' },
          ];`,
        });
        return;
      }
      if (pathname === '/static/js/modules/visibility.js') {
        await route.fulfill({ contentType: 'text/javascript', body: visibilitySource });
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
    await page.evaluate(() => {
      window.workspaceTest.setInitialFilter('42');
      window.workspaceTest.feature.showWorkspaceModal();
    });
    await page.fill('#workspace-name', 'Created workspace');
    await page.dispatchEvent('#workspace-name', 'input');
    await page.click('#workspace-save-btn');
    await page.waitForFunction(() => window.workspaceTest.getWorkspaces().length === 2);
    await page.waitForFunction(() => !document.getElementById('workspace-modal').classList.contains('active'));
    assert.deepEqual(
      await page.evaluate(() => window.workspaceTest.getState()),
      { currentWorkspaceId: 2, currentFilter: 'all', lastFilter: 'all' },
      'creating a workspace must close its modal and reset the previous workspace filter',
    );
    await page.evaluate(() => history.forward());
    await page.waitForTimeout(50);
    assert.deepEqual(
      await page.evaluate(() => window.workspaceTest.getState()),
      { currentWorkspaceId: 2, currentFilter: 'all', lastFilter: 'all' },
      'creating a workspace must discard the stale modal entry from forward history',
    );

    await page.evaluate(() => window.workspaceTest.feature.showWorkspaceModal(1));
    await page.click('#workspace-close-btn');
    await page.waitForTimeout(50);
    assert.equal(
      await page.locator('#workspace-modal').evaluate(element => element.classList.contains('active')),
      false,
      'closing during workspace creation must not block the close action after reopening',
    );
    await page.close();
  }

  {
    const page = await openHarness();
    await page.evaluate(() => {
      window.workspaceTest.setInitialFilter('42');
      window.workspaceTest.delayNextCreate();
      window.workspaceTest.deferNextHistoryBack();
      window.workspaceTest.feature.showWorkspaceModal();
    });
    await page.fill('#workspace-name', 'Created while closing');
    await page.dispatchEvent('#workspace-name', 'input');
    await page.click('#workspace-save-btn');
    await page.waitForFunction(() => window.workspaceTest.isCreatePending());
    await page.click('#workspace-close-btn');
    await page.evaluate(() => window.workspaceTest.releaseCreate());
    await page.waitForFunction(() => window.workspaceTest.getWorkspaces().length === 2);
    await page.evaluate(() => window.workspaceTest.flushHistoryBack());
    await page.waitForFunction(() => !document.getElementById('workspace-modal').classList.contains('active'));
    await page.waitForTimeout(50);
    assert.deepEqual(
      await page.evaluate(() => window.workspaceTest.getState()),
      { currentWorkspaceId: 2, currentFilter: 'all', lastFilter: 'all' },
      'a pending modal close must still activate the newly created workspace',
    );
    await page.close();
  }

  {
    const page = await openHarness();
    await page.evaluate(() => window.workspaceTest.feature.showWorkspaceModal(1));
    await page.click('[data-workspace-module-id="tasks"]');
    await page.click('[data-workspace-module-id="shopping"]');
    await page.click('[data-workspace-module-id="recipes"]');
    assert.equal(await page.locator('[data-workspace-module-id="recipes"]').isChecked(), true, 'the last visible module must remain enabled');
    assert.equal(await page.locator('#workspace-error').textContent(), 'workspace.modulesRequired');
    await page.click('[data-workspace-module-id="shopping"]');
    assert.equal(await page.locator('#workspace-error').textContent(), '', 'the last-module validation error must clear after another module is enabled');
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
    const hiddenModules = await page.evaluate(() => window.workspaceTest.getWorkspaces()[0].hidden_modules);
    assert.equal(hiddenModules.length, 128, 'workspace visibility payloads must respect the API module-id limit');
    assert.equal(hiddenModules.at(-1), 'tasks', 'the current hidden-module selection must take priority at the payload limit');
    assert(hiddenModules.includes('future-0'), 'unknown future module ids must be preserved when capacity remains');
    assert(!hiddenModules.includes('future-127'), 'the oldest preserved overflow must yield to the current selection');
    await page.close();
  }
} finally {
  await browser.close();
}

console.log('✅ Workspace modal lifecycle test passed');

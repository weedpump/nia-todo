#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const fixtureSource = `
  import { initI18n } from '/static/js/i18n/index.js';
  import { renderEntityEditorModal, createEntityEditorModalController } from '/static/js/features/entity-editor-modal.js';
  import { hydrateSelect } from '/static/js/ui/dropdowns.js';

  localStorage.setItem('nia-todo-language', 'de');
  await initI18n();

  document.body.innerHTML = '<button id="add-trigger">Add</button><button id="edit-trigger">Edit</button>' + renderEntityEditorModal({
    prefix: 'subject',
    icon: 'folder',
    createTitleKey: 'project.new',
    editTitleKey: 'project.edit',
    subtitleKey: 'project.modalHint',
    deleteKey: 'project.delete',
    formContentHtml: '<section class="ui-section-card ui-detail-section ui-section-divider" id="subject-domain"><select id="subject-target"><option>First</option><option>Second</option></select><input id="subject-extra"></section>',
    sharingHtml: '<section id="subject-sharing-section"></section>',
  });

  let state = { name: '', extra: '' };
  const calls = [];
  const appearance = {
    readState: () => ({ name: state.name, color: '#6366f1', icon: '' }),
    setValues(value, options) {
      state.name = value.name || '';
      document.getElementById('subject-name').value = state.name;
      calls.push(['appearance', structuredClone(value), structuredClone(options)]);
    },
    focusName() {
      document.getElementById('subject-name').focus();
      calls.push(['focus-name']);
    },
  };
  const ownership = {
    value: () => '',
    render(entity, options) { calls.push(['ownership', entity?.id ?? null, structuredClone(options)]); },
  };
  const sharing = {
    async setEntity(entity) { calls.push(['sharing', entity?.id ?? null]); },
  };
  let editable = true;
  let deletable = false;
  let restoreId = 'add-trigger';
  const controller = createEntityEditorModalController({
    prefix: 'subject',
    appearanceController: appearance,
    ownershipController: ownership,
    sharingController: sharing,
    readState: () => ({ ...appearance.readState(), extra: state.extra }),
    isValid: value => Boolean(value.name),
    canSubmit: () => editable,
    resolveView({ entity, context }) {
      return {
        mode: entity ? 'edit' : (context?.parentId ? 'create-child' : 'create'),
        titleKey: entity ? 'project.edit' : (context?.parentId ? 'project.newSubproject' : 'project.new'),
        appearance: entity || { name: '', color: '#6366f1', icon: '' },
        appearanceEditable: editable,
        ownershipCanManage: editable,
        canDelete: deletable,
        readOnly: !editable,
        restoreFocus: () => document.getElementById(restoreId),
      };
    },
    renderDomain({ entity, context }) {
      state.extra = context?.extra || entity?.extra || '';
      document.getElementById('subject-extra').value = state.extra;
      calls.push(['domain', entity?.id ?? null, state.extra]);
    },
    applyDomainPermissions({ entity, view }) {
      calls.push(['permissions', entity?.id ?? null, view.readOnly]);
    },
    clearError: () => calls.push(['clear-error']),
    onSubmit: event => { event.preventDefault(); calls.push(['submit']); },
    onDelete: () => calls.push(['delete']),
  });
  controller.bind();
  hydrateSelect(document.getElementById('subject-target'));

  window.test = {
    controller,
    calls,
    setEditable(value) { editable = value; },
    setDeletable(value) { deletable = value; },
    setName(value) {
      state.name = value;
      const input = document.getElementById('subject-name');
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    setRestoreId(value) { restoreId = value; },
  };
`;

const projectsSource = readFileSync(new URL('../web/static/js/features/projects.js', import.meta.url), 'utf8');
const shoppingListsSource = readFileSync(new URL('../web/static/js/features/shopping-list-details.js', import.meta.url), 'utf8');
const projectSharingSource = readFileSync(new URL('../web/static/js/features/project-sharing.js', import.meta.url), 'utf8');
const taskDialogsSource = readFileSync(new URL('../web/static/js/modules/tasks-dialogs.js', import.meta.url), 'utf8');
const shoppingDialogsSource = readFileSync(new URL('../web/static/js/modules/shopping-dialogs.js', import.meta.url), 'utf8');
for (const [label, source] of [['Project', projectsSource], ['Shopping list', shoppingListsSource]]) {
  assert.match(source, /createEntityEditorModalController\(/, `${label} must delegate modal lifecycle to the shared controller`);
  assert.match(source, /onDelete:\s*[a-zA-Z]/, `${label} must delegate deletion to the shared modal controller`);
  assert.doesNotMatch(source, /classList\.add\(['"]active['"]\)[\s\S]{0,160}openUiLayer\(/, `${label} must not retain a second manual modal-open lifecycle`);
  assert.doesNotMatch(source, /delete-from-modal/, `${label} must not retain a document-level modal delete action`);
}
assert.doesNotMatch(taskDialogsSource, /data-project-action="delete-from-modal"/, 'project markup must not route deletion around the shared controller');
assert.doesNotMatch(shoppingDialogsSource, /data-shopping-list-action="delete-from-modal"/, 'shopping markup must not route deletion around the shared controller');
assert.match(projectSharingSource, /function setEntity\(project\) \{\s*if \(accessPrivacySuspended\) return;\s*currentProject = project;\s*return directSharing\.setEntity\(project\);\s*\}/, 'active project sharing must return its async entity load and suspended sharing must not start one');
assert.match(projectsSource, /setEntity\(project\) \{\s*return sharingFeature\?\.setEntity\?\.\(project\);\s*\}/, 'the project modal adapter must return the sharing Promise to the shared lifecycle');
assert.doesNotMatch(projectSharingSource, /function isOwner\(/, 'project sharing must not retain a second permission authority');
assert.doesNotMatch(projectSharingSource, /isHouseholdOwnedEntity/, 'project sharing must not retain unused household permission logic');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('pageerror', error => console.error(`fixture page error: ${error.message}`));
try {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<script type="module">${fixtureSource}</script>` });
    }
    if (url.pathname.startsWith('/static/')) {
      try {
        const body = readFileSync(new URL(`../web${url.pathname}`, import.meta.url), 'utf8');
        const contentType = url.pathname.endsWith('.json') ? 'application/json' : 'text/javascript';
        return route.fulfill({ contentType, body });
      } catch {
        return route.fulfill({ status: 404, contentType: 'text/plain', body: `Missing fixture asset: ${url.pathname}` });
      }
    }
    return route.fulfill({ status: 404, body: `Unexpected request: ${url.pathname}` });
  });

  await page.goto('http://entity-editor.test/');
  await page.waitForFunction(() => Boolean(window.test));

  assert.equal(await page.locator('#subject-modal').count(), 1);
  assert.equal(await page.locator('#subject-form > .ui-detail-title-section').count(), 1);
  assert.equal(await page.locator('#subject-form .ui-detail-section.ui-detail-shell').count(), 0, 'sections must not create nested modal shells');

  await page.evaluate(() => {
    document.getElementById('edit-trigger').focus();
    window.test.controller.open(null);
    window.test.controller.open({ id: 6, name: 'Immediate edit', color: '#123456', icon: 'folder' });
  });
  await page.waitForTimeout(20);
  assert.equal(await page.locator('#subject-name').evaluate(element => document.activeElement === element), false, 'a stale create focus request must not focus the title after an immediate edit transition');
  await page.evaluate(() => {
    window.test.controller.close({ fromHistory: true });
    window.test.calls.length = 0;
  });

  await page.evaluate(() => window.test.controller.open(null, { extra: 'create-extra' }));
  await page.waitForTimeout(20);
  assert.equal(await page.locator('#subject-modal').getAttribute('aria-hidden'), 'false');
  assert.equal(await page.locator('#subject-modal').evaluate(element => element.classList.contains('active')), true);
  assert.equal(await page.locator('#subject-modal-title').getAttribute('data-i18n-key'), 'project.new');
  assert.equal(await page.locator('#subject-name').evaluate(element => document.activeElement === element), true, 'create focuses the shared title field');
  assert.equal(await page.locator('#subject-save-btn').isHidden(), true, 'unchanged create baseline hides Save');
  assert.equal(await page.locator('#subject-detail-header-menu').isHidden(), true, 'create hides Delete menu');
  assert.deepEqual(await page.evaluate(() => window.test.calls.filter(call => ['appearance', 'ownership', 'sharing', 'domain', 'permissions'].includes(call[0]))), [
    ['domain', null, 'create-extra'],
    ['appearance', { name: '', color: '#6366f1', icon: '' }, { editable: true }],
    ['ownership', null, { canManage: true }],
    ['sharing', null],
    ['permissions', null, false],
  ]);

  await page.evaluate(() => window.test.setName('Created'));
  assert.equal(await page.locator('#subject-save-btn').isVisible(), true, 'dirty valid state shows Save');
  await page.locator('#subject-save-btn').click();
  assert.equal(await page.evaluate(() => window.test.calls.filter(call => call[0] === 'submit').length), 1);

  await page.evaluate(() => {
    window.test.controller.close({ fromHistory: true });
    window.test.setDeletable(true);
    window.test.setEditable(true);
    window.test.setRestoreId('edit-trigger');
    window.test.controller.open({ id: 7, name: 'Existing', color: '#123456', icon: 'folder', extra: 'edit-extra' });
  });
  await page.waitForTimeout(20);
  assert.equal(await page.locator('#subject-modal-title').getAttribute('data-i18n-key'), 'project.edit');
  assert.equal(await page.locator('#subject-name').evaluate(element => document.activeElement === element), false, 'edit never focuses the title automatically');
  assert.equal(await page.locator('#subject-detail-header-menu').isVisible(), true, 'editable deletable entity shows the menu');
  await page.locator('#subject-detail-header-menu summary').click();
  await page.locator('#subject-delete-btn').click();
  assert.equal(await page.evaluate(() => window.test.calls.filter(call => call[0] === 'delete').length), 1);
  await page.locator('#subject-detail-header-menu summary').click();
  assert.equal(await page.locator('#subject-detail-header-menu').getAttribute('open'), '');
  await page.evaluate(() => {
    window.test.controller.close({ fromHistory: true });
    window.test.controller.open({ id: 7, name: 'Existing', color: '#123456', icon: 'folder', extra: 'edit-extra' });
  });
  assert.equal(await page.locator('#subject-detail-header-menu').getAttribute('open'), null, 'reopening an editable entity must start with its overflow menu closed');

  await page.evaluate(() => {
    window.test.controller.close({ fromHistory: true });
    window.test.setEditable(false);
    window.test.setDeletable(false);
    window.test.controller.open({ id: 8, name: 'Readonly', color: '#654321', icon: '' });
  });
  await page.waitForTimeout(20);
  assert.equal(await page.locator('#subject-modal .modal-close-x').evaluate(element => document.activeElement === element), true, 'read-only edit focuses Close instead of a field');
  assert.equal(await page.locator('#subject-name').isDisabled(), true);
  assert.equal(await page.locator('#subject-save-btn').isHidden(), true);
  assert.equal(await page.locator('#subject-detail-header-menu').isHidden(), true);

  await page.evaluate(() => window.test.controller.close({ fromHistory: true }));
  assert.equal(await page.locator('#subject-modal').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('#edit-trigger').evaluate(element => document.activeElement === element), true, 'close resolves the current return-focus target');

  await page.evaluate(() => {
    window.test.setEditable(true); window.test.setDeletable(true);
    window.test.controller.open({ id: 9, name: 'Keyboard', color: '#123456', icon: '' });
  });
  const menuTrigger = page.locator('#subject-detail-header-menu summary');
  await page.locator('#subject-extra').focus();
  await page.keyboard.press('Tab');
  assert.equal(await menuTrigger.evaluate(element => element === document.activeElement), true, 'Tab wraps from the final domain field to the first editor action');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator('#subject-extra').evaluate(element => element === document.activeElement), true, 'Shift+Tab wraps to the final domain field');
  for (const blocked of [{ isComposing: true }, { keyCode: 229 }, { handled: true }]) {
    await page.locator('#subject-extra').evaluate((element, blocked) => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...blocked });
      if (blocked.handled) event.preventDefault();
      element.dispatchEvent(event);
    }, blocked);
    assert.equal(await page.locator('#subject-modal').getAttribute('aria-hidden'), 'false', 'handled/composing Escape must preserve the editor');
  }
  const selectTrigger = page.locator('[data-select-id="subject-target"] .ui-select-trigger');
  await selectTrigger.press('Enter');
  await selectTrigger.press('Escape');
  assert.equal(await selectTrigger.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#subject-modal').getAttribute('aria-hidden'), 'false', 'the first Escape only closes the dropdown');
  await menuTrigger.click();
  await menuTrigger.press('Escape');
  assert.equal(await page.locator('#subject-detail-header-menu').getAttribute('open'), null, 'Escape closes the overflow menu first');
  assert.equal(await page.locator('#subject-modal').getAttribute('aria-hidden'), 'false');
  await page.locator('#subject-extra').press('Escape');
  await page.waitForFunction(() => document.getElementById('subject-modal').getAttribute('aria-hidden') === 'true'
    && !(history.state?.niaTodoUi?.layers || []).includes('subject-modal'));

  console.log('✅ Shared entity editor modal renderer and lifecycle contracts passed');
} finally {
  await browser.close();
}

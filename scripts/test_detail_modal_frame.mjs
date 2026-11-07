#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { renderDetailModalFrame } from '../web/static/js/ui/detail-modal.js';
import { renderEntityEditorModal } from '../web/static/js/features/entity-editor-modal.js';
import { TASK_DIALOGS_HTML } from '../web/static/js/modules/tasks-dialogs.js';
import { SHOPPING_DIALOGS_HTML } from '../web/static/js/modules/shopping-dialogs.js';

assert.throws(() => renderDetailModalFrame(), /modal id/);
assert.throws(() => renderDetailModalFrame({ id: 'invalid', rootAttributes: { 'bad attribute': 'x' } }), /attribute name/);

const bare = renderDetailModalFrame({ id: 'bare-modal' });
const fixture = renderDetailModalFrame({
  id: 'frame-fixture',
  rootClasses: 'modal ui-detail-modal custom-root',
  contentClasses: ['modal-content', 'custom-content'],
  rootAttributes: { 'aria-hidden': 'true', 'data-note': '\"<&', hidden: true, 'data-omitted': false },
  overlayId: 'frame-backdrop',
  overlayAttributes: { 'data-frame-action': 'cancel' },
  contentAttributes: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'frame-title', style: 'max-width: 30rem;' },
  headerHtml: '<header id="frame-header"><h3 id="frame-title">Fixture</h3></header>',
  bodyId: 'frame-body',
  bodyClasses: 'modal-body custom-body',
  bodyHtml: '<input id="frame-field" aria-label="Fixture field">',
  footerHtml: '<footer id="frame-footer"><button type="button">Close</button></footer>',
});
const entity = renderEntityEditorModal({
  prefix: 'frame-entity', icon: 'folder', createTitleKey: 'project.new',
  subtitleKey: 'project.modalHint', deleteKey: 'project.delete',
  contentClassNames: ['custom-entity-content'],
  formContentHtml: '<input id="frame-entity-domain">',
  sharingHtml: '<section id="frame-entity-sharing"></section>',
});

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(bare + fixture + entity + TASK_DIALOGS_HTML + SHOPPING_DIALOGS_HTML);

  assert.equal(await page.locator('#bare-modal input, #bare-modal form, #bare-modal button').count(), 0,
    'the neutral frame must not inject domain fields or actions');
  assert.equal(await page.locator('#bare-modal > .modal-overlay').getAttribute('data-close-modal'), 'bare-modal');
  assert.equal(await page.locator('#frame-fixture').getAttribute('data-note'), '\"<&', 'attribute values must survive escaped rendering');
  assert.equal(await page.locator('#frame-fixture').getAttribute('data-omitted'), null);
  assert.equal(await page.locator('#frame-fixture').getAttribute('role'), null, 'root attributes must not be forced onto content-hosted dialogs');
  assert.equal(await page.locator('#frame-fixture > #frame-backdrop').getAttribute('data-frame-action'), 'cancel');
  assert.equal(await page.locator('#frame-backdrop').getAttribute('data-close-modal'), null,
    'a module-specific overlay action must replace the default close action');
  const content = page.locator('#frame-fixture > .modal-content');
  assert.equal(await content.getAttribute('role'), 'dialog');
  assert.equal(await content.getAttribute('aria-modal'), 'true');
  assert.equal(await content.getAttribute('aria-labelledby'), 'frame-title');
  assert.equal(await content.getAttribute('style'), 'max-width: 30rem;');
  assert.deepEqual(await content.evaluate(element => [...element.children].map(child => child.id)),
    ['frame-header', 'frame-body', 'frame-footer'], 'header, body and footer slots must retain their sibling layout');
  assert.equal(await page.locator('#frame-body > #frame-field').count(), 1);
  assert.equal(await page.locator('#frame-body').getAttribute('class'), 'modal-body custom-body');

  for (const [id, prefix] of [
    ['frame-entity-modal', 'frame-entity'], ['project-modal', 'project'],
    ['shopping-list-modal', 'shopping-list'], ['shopping-store-modal', 'shopping-store'],
    ['shopping-item-modal', 'shopping-item'],
  ]) {
    const modal = page.locator(`#${id}`);
    assert.equal(await modal.count(), 1, `${id} must be defined exactly once`);
    assert.equal(await modal.getAttribute('class'), 'modal ui-detail-modal ui-detail-view');
    assert.equal(await modal.getAttribute('role'), 'dialog');
    assert.equal(await modal.getAttribute('aria-modal'), 'true');
    assert.equal(await modal.getAttribute('aria-hidden'), 'true');
    assert.equal(await modal.getAttribute('aria-labelledby'), `${prefix}-modal-title`);
    assert.equal(await modal.locator(':scope > .modal-overlay').getAttribute('data-close-modal'), id);
    assert.equal(await modal.locator(':scope > .modal-content > .ui-detail-modal-header').count(), 1);
    assert.equal(await modal.locator(':scope > .modal-content > .modal-body.entity-modal-body.ui-detail-modal-body').count(), 1);
    assert.equal(await modal.locator(`.modal-body > #${prefix}-form`).count(), 1);
    assert.equal(await modal.locator(`#${prefix}-save-btn`).getAttribute('form'), `${prefix}-form`);
    assert.equal(await modal.locator('.modal-close-x').getAttribute('data-close-modal'), id);
  }
  assert.equal(await page.locator('#frame-entity-modal > .custom-entity-content').count(), 1);
  assert.equal(await page.locator('#frame-entity-form > #frame-entity-domain').count(), 1);
  assert.equal(await page.locator('#frame-entity-form + #frame-entity-sharing').count(), 1,
    'sharing remains alongside the entity form, not nested inside it');

  const todo = page.locator('#todo-modal');
  assert.equal(await todo.count(), 1, 'create and edit must keep one Todo window');
  assert.equal(await todo.getAttribute('class'), 'modal ui-detail-modal');
  assert.equal(await todo.getAttribute('role'), null, 'preserve existing Todo dialog attribute placement');
  assert.equal(await todo.locator(':scope > .modal-overlay').getAttribute('data-close-modal'), 'todo-modal');
  assert.equal(await todo.locator(':scope > .modal-content').getAttribute('class'), 'modal-content todo-modal-content ui-detail-modal-content');
  assert.equal(await todo.locator('.modal-content > .modal-body').getAttribute('class'), 'modal-body todo-modal-body ui-detail-modal-body');
  assert.equal(await todo.locator('.modal-body > #todo-form').count(), 1);
  assert.equal(await todo.locator('#todo-save-btn').getAttribute('form'), 'todo-form');
  for (const id of ['todo-detail-header-actions', 'todo-detail-duplicate-action', 'todo-detail-delete-action', 'todo-title', 'todo-id']) {
    assert.equal(await todo.locator(`#${id}`).count(), 1, `preserve ${id}`);
  }
  assert.equal(await page.locator('#shopping-item-modal #shopping-item-name').count(), 1);
  assert.equal(await page.locator('#shopping-store-modal #shopping-store-name').count(), 1);
  assert.equal(await page.locator('#shopping-item-modal #shopping-item-color, #shopping-store-modal #shopping-store-color').count(), 0,
    'item/store adapters must not inherit entity appearance fields');

  for (const relative of ['features/entity-editor-modal.js', 'modules/tasks-dialogs.js', 'modules/shopping-dialogs.js']) {
    const source = readFileSync(new URL(`../web/static/js/${relative}`, import.meta.url), 'utf8');
    assert.match(source, /renderDetailModalFrame\(/, `${relative} must use the shared window definition`);
    assert.doesNotMatch(source, /<div class="modal[^"\n]*" id="(?:todo-modal|shopping-item-modal|shopping-store-modal|\$\{escapeHtmlAttr\(modalId\)\})"/,
      `${relative} must not duplicate a migrated modal frame`);
  }
  console.log('✅ Shared detail modal slots and existing Todo/entity/Shopping dialog contracts passed');
} finally {
  await browser.close();
}

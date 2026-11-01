#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const tasksDialogsSource = readFileSync(new URL('../web/static/js/modules/tasks-dialogs.js', import.meta.url), 'utf8');
const shoppingDialogsSource = readFileSync(new URL('../web/static/js/modules/shopping-dialogs.js', import.meta.url), 'utf8');
const projectSharingSource = readFileSync(new URL('../web/static/js/features/project-sharing.js', import.meta.url), 'utf8');
const shoppingDetailsSource = readFileSync(new URL('../web/static/js/features/shopping-list-details.js', import.meta.url), 'utf8');
const projectSharingBrowserSource = readFileSync(new URL('./test_frontend_sharing.mjs', import.meta.url), 'utf8');
const entityModalCss = readFileSync(new URL('../web/static/css/82-entity-modals.css', import.meta.url), 'utf8');
const navigationCss = readFileSync(new URL('../web/static/css/10-navigation-sidebar.css', import.meta.url), 'utf8');

assert.match(tasksDialogsSource, /renderEntityDirectSharingSection\(\{ prefix: 'project'/, 'Projects must render the neutral direct-sharing section');
assert.match(shoppingDialogsSource, /renderEntityDirectSharingSection\(\{ prefix: 'shopping-list'/, 'Shopping must render the neutral direct-sharing section');
assert.match(projectSharingSource, /createEntityDirectSharingFeature\(\{[\s\S]*prefix: 'project'/, 'Projects must use the neutral direct-sharing controller');
assert.match(shoppingDetailsSource, /createEntityDirectSharingFeature\(\{[\s\S]*prefix: 'shopping-list'/, 'Shopping must use the neutral direct-sharing controller');
assert.match(projectSharingBrowserSource, /#project-share-identifier/, 'the Project integration browser must target the neutral sharing identifier input');
assert.match(projectSharingBrowserSource, /\.entity-sharing-member-row/, 'the Project integration browser must target neutral sharing member rows');
assert.match(projectSharingBrowserSource, /data-entity-sharing-action=[\\"']revoke/, 'the Project integration browser must target the neutral revoke action');
assert.match(projectSharingBrowserSource, /#project-leave-row \[data-entity-sharing-action=[\\"']leave[\\"']\]/, 'the Project integration browser must target the complete neutral Leave control');
assert.match(projectSharingBrowserSource, /leaveBtn\.count\(\)/, 'the Project integration browser must require the real Leave control to exist before checking visibility');
assert.doesNotMatch(projectSharingBrowserSource, /project-share-username|\.sharing-member-row|data-remove-member|project-leave-btn/, 'the Project integration browser must not retain removed sharing selectors');
for (const source of [entityModalCss, navigationCss]) {
  assert.doesNotMatch(source, /project-(?:sharing|share|owner)-(?:card|row|inline|info|label|name)/, 'shared direct-sharing geometry must not retain project-only CSS authorities');
  assert.doesNotMatch(source, /#project-modal\s+\.entity-sharing-/, 'shared direct-sharing geometry must not retain project-modal overrides');
}

const fixtureSource = `
  import { createEntityDirectSharingFeature, renderEntityDirectSharingSection } from '/static/js/features/entity-direct-sharing.js';
  import { initI18n } from '/static/js/i18n/index.js';

  localStorage.setItem('nia-todo-language', 'de');
  await initI18n();
  document.body.innerHTML = '<div id="subject-modal" class="ui-detail-modal">' + renderEntityDirectSharingSection({ prefix: 'subject', leaveKey: 'project.share.leave' }) + '</div>'
    + '<button id="confirm-sink">confirm</button>'
    + '<div id="project-modal" class="ui-detail-modal"><div class="entity-modal-body">' + renderEntityDirectSharingSection({ prefix: 'project-geometry', leaveKey: 'project.share.leave' }) + '</div></div>'
    + '<div id="shopping-list-modal" class="ui-detail-modal"><div class="entity-modal-body">' + renderEntityDirectSharingSection({ prefix: 'shopping-geometry', leaveKey: 'shopping.list.share.leave' }) + '</div></div>';
  let entity = null;
  let members = [];
  const calls = [];
  const confirmations = [];
  let confirmResult = true;
  let confirmMovesFocus = false;
  let deferredGrant = null;
  let failRevoke = false;
  let failLeave = false;
  const feature = createEntityDirectSharingFeature({
    document,
    prefix: 'subject',
    listMembers: async id => { calls.push(['list', id]); return members; },
    grantMember: async (id, identifier) => {
      calls.push(['grant', id, identifier]);
      if (identifier === 'slow') {
        return await new Promise(resolve => {
          deferredGrant = () => {
            deferredGrant = null;
            resolve({ id: 10, username: identifier, display_name: 'Langsam' });
          };
        });
      }
      return { id: 9, username: identifier, display_name: 'Neue Person' };
    },
    revokeMember: async (id, memberId) => { calls.push(['revoke', id, memberId]); if (failRevoke) throw new Error('revoke failed'); },
    leaveEntity: async id => { calls.push(['leave', id]); if (failLeave) throw new Error('leave failed'); },
    confirmDanger: async options => {
      confirmations.push({ title: options.title, message: options.message, confirmText: options.confirmText });
      if (confirmResult && confirmMovesFocus) document.getElementById('confirm-sink').focus();
      return confirmResult;
    },
  });
  feature.bind();
  window.test = {
    set: async next => { entity = next; await feature.setEntity(entity); },
    setMembers: next => { members = structuredClone(next); },
    calls: () => structuredClone(calls),
    confirmations: () => structuredClone(confirmations),
    setConfirmResult: value => { confirmResult = Boolean(value); },
    setConfirmMovesFocus: value => { confirmMovesFocus = Boolean(value); },
    resolveGrant: () => deferredGrant?.(),
    grantPending: () => Boolean(deferredGrant),
    currentEntity: () => structuredClone(entity),
    setFailRevoke: value => { failRevoke = Boolean(value); },
    setFailLeave: value => { failLeave = Boolean(value); },
  };
`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 760 } });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error?.stack || error)));

try {
  await page.route('http://nia.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/static/style.css"></head><body><script type="module" src="/fixture.js"></script></body></html>' });
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: fixtureSource });
    if (url.pathname.startsWith('/static/')) {
      try {
        const body = readFileSync(new URL(`../web${url.pathname}`, import.meta.url), 'utf8');
        const contentType = url.pathname.endsWith('.json') ? 'application/json' : (url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
        return route.fulfill({ contentType, body });
      } catch {
        return route.fulfill({ status: 404, contentType: 'text/plain', body: `Missing fixture asset: ${url.pathname}` });
      }
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto('http://nia.test/');
  await page.waitForFunction(() => Boolean(window.test));
  const sharedGeometry = await page.evaluate(() => ({
    projectMarginBottom: getComputedStyle(document.getElementById('project-geometry-sharing-section')).marginBottom,
    shoppingMarginBottom: getComputedStyle(document.getElementById('shopping-geometry-sharing-section')).marginBottom,
  }));
  assert.equal(sharedGeometry.projectMarginBottom, sharedGeometry.shoppingMarginBottom, 'Project and Shopping sharing sections must have identical final geometry');
  const section = page.locator('#subject-sharing-section');
  const content = page.locator('#subject-sharing-content');
  const start = page.locator('#subject-share-start-row');
  const input = page.locator('#subject-share-identifier');

  await page.evaluate(() => window.test.setMembers([]));
  await section.evaluate(element => { element.style.display = 'none'; });
  await page.evaluate(() => window.test.set({ id: 1, name: 'Privat', can_manage: 1, is_owner: 1, is_shared: 0, ownership_type: 'user' }));
  assert.equal(await section.isVisible(), true);
  assert.notEqual(await section.evaluate(element => getComputedStyle(element).display), 'none', 'opening an entity after create mode must clear stale inline hiding');
  assert.equal(await page.locator('#subject-owner-info').evaluate(element => getComputedStyle(element).display), 'none', 'hidden owner metadata must stay out of layout');
  assert.equal(await start.isVisible(), true, 'an unshared personal entity starts with the common Share action');
  assert.equal(await page.locator('#subject-leave-row').isHidden(), true, 'an owner must never see the Leave action');
  assert.equal(await content.isHidden(), true);
  assert.deepEqual(await page.evaluate(() => window.test.calls()), [['list', 1]]);

  await section.locator('[data-entity-sharing-action="show-share-input"]').click();
  assert.equal(await content.isVisible(), true);
  await input.fill('alex');
  await section.locator('[data-entity-sharing-action="grant"]').click();
  await page.waitForFunction(() => window.test.calls().some(call => call[0] === 'grant'));
  assert.deepEqual(await page.evaluate(() => window.test.calls()), [['list', 1], ['grant', 1, 'alex']]);
  assert.equal((await page.locator('.entity-sharing-member-name').textContent()).trim(), 'Neue Person');

  await section.locator('[data-entity-sharing-action="revoke"]').click();
  await page.waitForFunction(() => window.test.confirmations().length === 1);
  await page.waitForFunction(() => window.test.calls().some(call => call[0] === 'revoke'));
  assert.deepEqual((await page.evaluate(() => window.test.calls())).at(-1), ['revoke', 1, 9]);
  assert.equal(await page.locator('.entity-sharing-member-row').count(), 0);

  await page.evaluate(() => window.test.setMembers([]));
  await page.evaluate(() => window.test.set({ id: 10, name: 'A', can_manage: 1, is_owner: 1, is_shared: 0, ownership_type: 'user' }));
  await section.locator('[data-entity-sharing-action="show-share-input"]').click();
  await input.fill('slow');
  await section.locator('[data-entity-sharing-action="grant"]').click();
  await page.waitForFunction(() => window.test.grantPending());
  await page.evaluate(() => window.test.set({ id: 11, name: 'B', can_manage: 1, is_owner: 1, is_shared: 0, ownership_type: 'user' }));
  await page.evaluate(() => window.test.resolveGrant());
  await page.waitForFunction(() => !window.test.grantPending());
  assert.equal(await page.locator('.entity-sharing-member-row').count(), 0, 'a late grant response must not render in a newly opened entity');
  assert.equal((await page.evaluate(() => window.test.currentEntity())).has_sharing_activity, undefined, 'a late grant response must not mutate the newly opened entity');

  await page.evaluate(() => window.test.setMembers([{ id: 12, username: 'remove-me', display_name: null }]));
  await page.evaluate(() => window.test.set({ id: 12, name: 'Revoke', can_manage: 1, is_owner: 1, is_shared: 0, ownership_type: 'user' }));
  await page.evaluate(() => { window.test.setFailRevoke(true); window.test.setConfirmMovesFocus(true); });
  await section.locator('[data-entity-sharing-action="revoke"]').click();
  await page.waitForFunction(() => document.getElementById('subject-share-error')?.textContent);
  await page.waitForFunction(() => document.activeElement?.dataset?.entitySharingAction === 'revoke');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.entitySharingAction), 'revoke', 'failed revoke must restore focus to the live member action');
  await page.evaluate(() => { window.test.setFailRevoke(false); window.test.setConfirmMovesFocus(false); });

  await page.evaluate(() => window.test.setMembers([{ user_id: 8, username: 'pending-user', display_name: null, status: 'pending' }]));
  await page.evaluate(() => window.test.set({ id: 2, name: 'Pending', can_manage: true, is_owner: true, is_shared: false, ownership_type: 'user', has_sharing_activity: true }));
  assert.equal((await page.locator('.entity-sharing-pending').textContent()).trim(), 'ausstehend', 'pending state remains a supported adapter value for Projects');

  const callsBeforeRecipient = (await page.evaluate(() => window.test.calls())).length;
  await page.evaluate(() => window.test.set({ id: 3, name: 'Geteilt', can_manage: 0, is_owner: 0, is_shared: 1, ownership_type: 'user', owner_display_name: 'Tobi', owner_username: 'weedpump' }));
  assert.equal(await page.locator('#subject-owner-info').isVisible(), true);
  assert.equal(await page.locator('#subject-owner-info').evaluate(element => getComputedStyle(element).display), 'flex', 'visible owner metadata must retain the shared inline layout');
  assert.equal((await page.locator('#subject-owner-info .entity-sharing-owner-name').textContent()).trim(), 'Tobi (weedpump)');
  assert.equal(await page.locator('#subject-leave-row').isVisible(), true);
  assert.equal(await start.isHidden(), true, 'a direct recipient must never see the Share action');
  assert.equal(await content.isHidden(), true);
  assert.equal((await page.evaluate(() => window.test.calls())).length, callsBeforeRecipient, 'direct recipients must not call the manager-only member endpoint');
  await section.locator('[data-entity-sharing-action="leave"]').click();
  await page.waitForFunction(() => window.test.calls().some(call => call[0] === 'leave'));
  assert.deepEqual((await page.evaluate(() => window.test.calls())).at(-1), ['leave', 3]);

  await page.evaluate(() => { window.test.setFailLeave(true); return window.test.set({ id: 5, name: 'Leave failure', can_manage: 0, is_owner: 0, is_shared: 1, ownership_type: 'user', owner_username: 'owner' }); });
  await section.locator('[data-entity-sharing-action="leave"]').click();
  await page.waitForFunction(() => document.getElementById('subject-share-error')?.textContent);
  assert.equal(await page.locator('#subject-share-error').isVisible(), true, 'leave failures must be visible to direct recipients');

  const callsBeforeHousehold = (await page.evaluate(() => window.test.calls())).length;
  await page.evaluate(() => window.test.set({ id: 4, name: 'Haushalt', can_manage: true, is_owner: true, is_shared: false, ownership_type: 'household', owner_household_id: 7 }));
  assert.equal(await section.isHidden(), true, 'household entities never expose direct sharing');
  assert.equal((await page.evaluate(() => window.test.calls())).length, callsBeforeHousehold, 'household entities must not initialize the member endpoint');

  assert.deepEqual(pageErrors, []);
  console.log('✅ Shared entity direct-sharing component passed');
} finally {
  await browser.close();
}

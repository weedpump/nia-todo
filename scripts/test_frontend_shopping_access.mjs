#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const fixtureSource = `
  import { createShoppingListDetailsFeature } from '/static/js/features/shopping-list-details.js';
  import { SHOPPING_DIALOGS_HTML } from '/static/js/modules/shopping-dialogs.js';
  import { initI18n } from '/static/js/i18n/index.js';

  localStorage.setItem('nia-todo-language', 'de');
  await initI18n();
  document.body.innerHTML = \`
    <button data-entity-sidebar-action="add" data-entity-type="shopping-list">add</button>
    <button data-entity-sidebar-action="detail" data-entity-type="shopping-list" data-entity-id="1">personal</button>
    <button data-entity-sidebar-action="detail" data-entity-type="shopping-list" data-entity-id="2">household</button>
    <button data-entity-sidebar-action="detail" data-entity-type="shopping-list" data-entity-id="3">shared-manager</button>
    <button data-entity-sidebar-action="detail" data-entity-type="shopping-list" data-entity-id="4">shared-recipient</button>
    <button id="confirm-sink">confirm</button>
    \${SHOPPING_DIALOGS_HTML}
  \`;
  let lists = [
    { id: 1, name: 'Privat', color: '#2563eb', icon: 'shopping-cart', can_manage: true, can_edit: true, is_owner: true, is_shared: false, ownership_type: 'user', owner_household_id: null, sections: [], items: [], preferences: {} },
    { id: 2, name: 'Familie', color: '#16a34a', icon: 'shopping-cart', can_manage: false, can_edit: true, is_owner: false, is_shared: true, ownership_type: 'household', owner_household_id: 7, household_name: 'Zuhause', sections: [], items: [], preferences: {} },
    { id: 3, name: 'Direkt geteilt', color: '#9333ea', icon: 'shopping-cart', can_manage: true, can_edit: true, is_owner: true, is_shared: false, ownership_type: 'user', owner_household_id: null, sections: [], items: [], preferences: {} },
    { id: 4, name: 'Von Tobi', color: '#ea580c', icon: 'shopping-cart', can_manage: false, can_edit: true, is_owner: false, is_shared: true, ownership_type: 'user', owner_household_id: null, owner_display_name: 'Tobi', owner_username: 'weedpump', sections: [], items: [], preferences: {} },
  ];
  const mutations = [];
  const transfers = [];
  const confirmations = [];
  const sharingCalls = [];
  const membersByList = new Map([[3, []]]);
  let confirmResult = true;
  let transferFailure = false;
  let tempSequence = 0;
  const feature = createShoppingListDetailsFeature({
    document,
    eventTarget: window,
    getLists: () => lists,
    setLists: next => { lists = structuredClone(next); },
    getAccessSnapshot: () => ({ household: { id: 7, name: 'Zuhause', role: 'member' } }),
    commitMutation: async build => {
      const mutation = build();
      if (mutation) mutations.push(structuredClone(mutation));
      return mutation;
    },
    createTempListId: () => 'temp-shopping-list-' + (++tempSequence),
    isOnlineForSync: () => true,
    shoppingApi: {
      transferToHousehold: async (listId, householdId) => {
        transfers.push({ listId, householdId });
        if (transferFailure) throw new Error('transfer failed');
        return { ...lists.find(list => String(list.id) === String(listId)), ownership_type: 'household', owner_household_id: householdId, household_name: 'Zuhause', can_manage: false, is_owner: false, is_shared: true };
      },
      listMembers: async listId => {
        sharingCalls.push(['list', listId]);
        return { members: structuredClone(membersByList.get(Number(listId)) || []) };
      },
      shareList: async (listId, data) => {
        sharingCalls.push(['grant', listId, data.identifier]);
        const member = { id: 19, username: data.identifier, display_name: 'Alex' };
        membersByList.set(Number(listId), [member]);
        return member;
      },
      revokeMember: async (listId, userId) => {
        sharingCalls.push(['revoke', listId, userId]);
        membersByList.set(Number(listId), []);
      },
      leaveList: async listId => { sharingCalls.push(['leave', listId]); },
    },
    confirmDanger: async options => {
      confirmations.push({ title: options.title, message: options.message, confirmText: options.confirmText });
      if (confirmResult) document.getElementById('confirm-sink').focus();
      return confirmResult;
    },
    selectList: () => true,
  });
  feature.bind();
  window.test = {
    showCreate: () => feature.showListModal(null),
    show: id => feature.showListModal(lists.find(list => String(list.id) === String(id))),
    lists: () => structuredClone(lists),
    mutations: () => structuredClone(mutations),
    transfers: () => structuredClone(transfers),
    confirmations: () => structuredClone(confirmations),
    sharingCalls: () => structuredClone(sharingCalls),
    setConfirmResult: value => { confirmResult = Boolean(value); },
    setTransferFailure: value => { transferFailure = Boolean(value); },
  };
`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error?.stack || error)));

try {
  await page.route('http://nia.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/static/style.css"></head><body><script type="module" src="/fixture.js"></script></body></html>' });
      return;
    }
    if (url.pathname === '/fixture.js') {
      await route.fulfill({ contentType: 'text/javascript', body: fixtureSource });
      return;
    }
    if (url.pathname.startsWith('/static/')) {
      try {
        const body = readFileSync(new URL(`../web${url.pathname}`, import.meta.url), 'utf8');
        await route.fulfill({ contentType: url.pathname.endsWith('.json') ? 'application/json' : (url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript'), body });
      } catch {
        await route.fulfill({ status: 404, contentType: 'text/plain', body: `Missing fixture asset: ${url.pathname}` });
      }
      return;
    }
    await route.fulfill({ status: 404 });
  });

  await page.goto('http://nia.test/');
  await page.waitForFunction(() => Boolean(window.test));
  const modal = page.locator('#shopping-list-modal');
  const ownershipGroup = page.locator('#shopping-list-household-group');
  const ownershipSelect = page.locator('#shopping-list-household-id');

  await page.evaluate(() => window.test.showCreate());
  assert.equal(await ownershipGroup.isVisible(), true, 'shopping create must expose the shared ownership field');
  assert.deepEqual(await ownershipSelect.locator('option').allTextContents(), ['Nur für mich', 'Haushalt „Zuhause“']);
  assert.equal(await ownershipSelect.inputValue(), '', 'shopping create must default to personal ownership');
  await page.locator('#shopping-list-name').fill('Gemeinsamer Einkauf');
  await ownershipSelect.selectOption('7');
  await page.locator('#shopping-list-form').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => window.test.mutations().length === 1);
  const createMutation = (await page.evaluate(() => window.test.mutations()))[0];
  assert.equal(createMutation.action, 'CREATE_SHOPPING_LIST');
  assert.equal(createMutation.data.household_id, 7);
  assert.equal(createMutation.list.owner_household_id, 7);
  assert.equal(createMutation.list.ownership_type, 'household');
  assert.equal(createMutation.list.can_edit, true);
  assert.equal(createMutation.list.can_manage, false, 'an ordinary household member must not optimistically gain list management');
  assert.equal(createMutation.list.is_owner, false);

  await page.evaluate(() => window.test.show(1));
  assert.equal(await ownershipSelect.inputValue(), '');
  assert.equal(await ownershipSelect.isDisabled(), false);
  await page.evaluate(() => window.test.setConfirmResult(false));
  await ownershipSelect.selectOption('7');
  await page.locator('#shopping-list-form').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => window.test.confirmations().length === 1);
  assert.equal(await modal.getAttribute('aria-hidden'), 'false', 'cancelled household transfer keeps the list editor open');
  assert.equal(await ownershipSelect.inputValue(), '', 'cancelled transfer restores personal ownership');
  assert.equal(await page.locator('#shopping-list-name').isDisabled(), false, 'cancelled transfer restores editable metadata');
  assert.deepEqual(await page.evaluate(() => window.test.transfers()), []);

  await page.evaluate(() => window.test.setConfirmResult(true));
  await ownershipSelect.selectOption('7');
  await page.locator('#shopping-list-form').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => window.test.transfers().length === 1);
  assert.deepEqual(await page.evaluate(() => window.test.transfers()), [{ listId: 1, householdId: 7 }]);
  await page.waitForFunction(() => document.getElementById('shopping-list-modal')?.getAttribute('aria-hidden') === 'true');
  const transferred = (await page.evaluate(() => window.test.lists())).find(list => list.id === 1);
  assert.equal(transferred.owner_household_id, 7);
  assert.equal(transferred.can_manage, false);

  await page.evaluate(() => window.test.show(2));
  assert.equal(await ownershipSelect.isHidden(), true, 'ordinary household members must not receive an ownership select');
  assert.equal(await page.locator('#shopping-list-household-readonly').isVisible(), true);
  assert.equal((await page.locator('#shopping-list-household-readonly').textContent()).trim(), 'Haushalt „Zuhause“');
  assert.equal(await page.locator('#shopping-list-sharing-section').isHidden(), true, 'household lists must not expose direct sharing');
  assert.equal((await page.evaluate(() => window.test.sharingCalls())).some(call => call[0] === 'list' && call[1] === 2), false, 'household lists must not call the direct-members endpoint');

  await page.evaluate(() => { window.test.setTransferFailure(true); window.test.show(3); });
  await ownershipSelect.selectOption('7');
  await page.locator('#shopping-list-form').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => document.getElementById('shopping-list-error')?.textContent);
  assert.equal(await page.evaluate(() => document.activeElement?.classList?.contains('ui-select-trigger')), true, 'failed household transfer must restore focus to the ownership control');
  await page.evaluate(() => window.test.setTransferFailure(false));

  await page.evaluate(() => window.test.show(3));
  await page.waitForFunction(() => window.test.sharingCalls().some(call => call[0] === 'list' && call[1] === 3));
  assert.equal(await page.locator('#shopping-list-sharing-section').isVisible(), true);
  assert.equal(await page.locator('#shopping-list-share-start-row').isVisible(), true);
  assert.equal(await page.locator('#shopping-list-leave-row').isHidden(), true, 'shopping-list owners must never see the Leave action');
  await page.locator('#shopping-list-share-start-row [data-entity-sharing-action="show-share-input"]').click();
  await page.locator('#shopping-list-share-identifier').fill('alex');
  await page.locator('#shopping-list-sharing-content [data-entity-sharing-action="grant"]').click();
  await page.waitForFunction(() => window.test.sharingCalls().some(call => call[0] === 'grant'));
  assert.deepEqual((await page.evaluate(() => window.test.sharingCalls())).find(call => call[0] === 'grant'), ['grant', 3, 'alex']);
  assert.equal((await page.locator('#shopping-list-members-list .entity-sharing-member-name').textContent()).trim(), 'Alex');
  await page.locator('#shopping-list-members-list [data-entity-sharing-action="revoke"]').click();
  await page.waitForFunction(() => window.test.sharingCalls().some(call => call[0] === 'revoke'));
  assert.deepEqual((await page.evaluate(() => window.test.sharingCalls())).find(call => call[0] === 'revoke'), ['revoke', 3, 19]);

  const memberCallsBeforeRecipient = (await page.evaluate(() => window.test.sharingCalls())).filter(call => call[0] === 'list').length;
  await page.evaluate(() => window.test.show(4));
  assert.equal(await page.locator('#shopping-list-owner-info').isVisible(), true);
  assert.equal((await page.locator('#shopping-list-owner-info .entity-sharing-owner-name').textContent()).trim(), 'Tobi (weedpump)');
  assert.equal(await page.locator('#shopping-list-leave-row').isVisible(), true);
  assert.equal(await page.locator('#shopping-list-share-start-row').isHidden(), true, 'direct shopping-list recipients must never see the Share action');
  assert.equal((await page.evaluate(() => window.test.sharingCalls())).filter(call => call[0] === 'list').length, memberCallsBeforeRecipient, 'direct recipients must not call the manager-only member endpoint');
  await page.locator('#shopping-list-leave-row [data-entity-sharing-action="leave"]').click();
  await page.waitForFunction(() => window.test.sharingCalls().some(call => call[0] === 'leave'));
  assert.deepEqual((await page.evaluate(() => window.test.sharingCalls())).find(call => call[0] === 'leave'), ['leave', 4]);
  await page.waitForFunction(() => !window.test.lists().some(list => list.id === 4));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.test.show(3));
  assert.equal(await page.locator('#shopping-list-sharing-content').isVisible(), true, 'existing sharing activity keeps the shared controls visible on mobile');
  const mobileLayout = await page.evaluate(() => {
    const modal = document.querySelector('#shopping-list-modal .ui-detail-modal-content');
    const inline = document.querySelector('#shopping-list-sharing-section .entity-sharing-inline');
    const button = inline?.querySelector('[data-entity-sharing-action="grant"]');
    return {
      modal: modal?.getBoundingClientRect().toJSON(),
      inlineDisplay: inline ? getComputedStyle(inline).display : '',
      inlineWidth: inline?.getBoundingClientRect().width || 0,
      buttonWidth: button?.getBoundingClientRect().width || 0,
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  assert.equal(mobileLayout.inlineDisplay, 'grid', 'mobile sharing must use the shared stacked control layout');
  assert(mobileLayout.buttonWidth >= mobileLayout.inlineWidth - 1, 'mobile Add action must span the shared sharing row');
  assert(mobileLayout.modal.width <= mobileLayout.viewportWidth, 'mobile list details must stay within the viewport');
  assert(mobileLayout.documentWidth <= mobileLayout.viewportWidth, 'mobile sharing must not introduce horizontal overflow');

  assert.deepEqual(pageErrors, []);
  console.log('✅ Shopping ownership, direct sharing and transfer passed');
} finally {
  await browser.close();
}

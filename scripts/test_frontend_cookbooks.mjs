#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { waitForPageCondition } from './browser_page_condition.mjs';

const fixture = `
  import { initI18n } from '/static/js/i18n/index.js';
  import { createModuleShell } from '/static/js/features/module-shell.js';
  import { createModuleSwitcher } from '/static/js/features/module-switcher.js';
  import { createUiShell } from '/static/js/features/ui-shell.js';
  import { createConfirmDialogFeature } from '/static/js/features/confirm-dialog.js';
  import { createCookbookNavigationFeature } from '/static/js/features/cookbook-navigation.js';
  import { createCookbookDetailsFeature } from '/static/js/features/cookbook-details.js';
  import { createCookbooksController } from '/static/js/features/cookbooks.js';
  import { openDatabase, getAll, put, remove, commitCookbookMutation, commitCookbookReplay, evictPendingCookbookEntities } from '/static/js/storage/indexed-db.js';
  localStorage.setItem('nia-todo-language', 'de'); localStorage.setItem('nia-active-module', 'recipes');
  await initI18n(); await openDatabase();
  for (const id of ['login-overlay', 'boot-overlay']) { const node = document.getElementById(id); node.classList.add('hidden'); node.style.display = 'none'; }
  let actor = '11:session', online = true, sequence = 0, deferredCommit = null, pendingCommits = 0;
  // This fixture mocks every API; host/network-namespace state is unrelated.
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  let access = { household: { id: 7, name: 'Family', role: 'owner' } };
  let books = [
    { id: 1, name: 'Personal', description: '<Plain text>', color: '#6366f1', icon: 'book-open', can_manage: true, can_edit: true, is_owner: true, owner_user_id: 11 },
    { id: 2, name: 'Household manager', description: '', color: '#16a34a', icon: 'house-heart', can_manage: true, can_edit: true, owner_household_id: 7 },
    { id: 3, name: 'Direct recipient', description: '', color: '#9333ea', icon: 'share-2', can_manage: false, can_edit: true, is_shared: true, owner_user_id: 12, owner_username: 'other' },
    { id: 4, name: 'Household member', description: '', color: '#ca8a04', icon: 'users', can_manage: false, can_edit: true, owner_household_id: 7 },
  ];
  for (const book of books) await put('cookbooks', book);
  const calls = [], errors = [], members = new Map();
  let nav, details;
  const ui = createUiShell({ renderMarkdown: String, showTodoModal() { throw new Error('Tasks capture must not open'); } });
  ui.bindModalCloseControls(); ui.bindSidebarControls(); ui.bindKeyboardShortcuts();
  const confirm = createConfirmDialogFeature(); confirm.bindConfirmDialog();
  const setBooks = next => { nav.replaceCookbooks(next); details?.reconcileCookbooksChanged(); };
  const removeAccess = async id => { await evictPendingCookbookEntities([id]); setBooks(books.filter(book => String(book.id) !== String(id))); };
  const api = {
    listInvites: async () => [], listMembers: async id => members.get(String(id)) || [],
    shareCookbook: async (id, data) => { calls.push(['share', id, data.identifier]); const member = { user_id: 55, username: data.identifier, status: 'pending' }; members.set(String(id), [member]); return { member }; },
    revokeMember: async (id, user) => { calls.push(['revoke', id, user]); members.set(String(id), []); },
    leaveCookbook: async id => { calls.push(['leave', id]); },
    transferToHousehold: async (id, household) => { calls.push(['transfer', id, household]); const book = books.find(book => String(book.id) === String(id)); const next = { ...book, owner_user_id: null, owner_household_id: household, ownership_type: 'household', household_name: 'Family' }; await put('cookbooks', next); setBooks(books.map(book => String(book.id) === String(id) ? next : book)); return next; },
    respondInvite: async (id, invite, accept) => { calls.push(['respond', id, invite, accept]); if (accept) { const next = { id, name: 'Accepted cookbook', description: 'Private content', can_manage: false, can_edit: true, is_shared: true, owner_user_id: 12 }; await put('cookbooks', next); setBooks([...books, next]); } },
  };
  const controller = createCookbooksController({ getCookbooks: () => books, setCookbooks: setBooks,
    getCurrentUser: () => ({ id: 11 }), getSessionIdentity: () => actor, getAccessSnapshot: () => access,
    createTempId: () => 'temp-cookbook-fixture-' + (++sequence),
    commitMutation: async build => { pendingCommits++; try { if (deferredCommit) await deferredCommit.promise; const mutation = build(); if (mutation) await commitCookbookMutation(mutation); return mutation; } finally { pendingCommits--; } },
    onError: error => errors.push(error.message),
  });
  nav = createCookbookNavigationFeature({ getCookbooks: () => books, setCookbooks: next => { books = next; },
    getActorId: () => 11,
    closeSidebar: options => ui.closeSidebar(options), onAdd: () => details.showCookbookModal(),
    onDetail: id => details.showCookbookModal(books.find(book => String(book.id) === String(id))),
    onCookbookIdRemap: (from, to) => details.remapCookbookId(from, to), onDeactivate: () => details?.deactivate(),
    cookbookApi: api, loadAuthoritativeProjection: async () => ({ cookbooks: books }), removePendingEntities: async ids => { for (const id of ids) await removeAccess(id); },
    onError: error => errors.push(error.message),
  });
  const shell = createModuleShell({ getUser: () => ({ id: 11, disabled_modules: [] }) });
  shell.registerController('recipes', { onActivate: () => nav.activate(), onDeactivate: () => nav.deactivate(), onSearch: value => nav.setSearchQuery(value) });
  shell.bind();
  createModuleSwitcher({ getModules: () => shell.getEnabledModules(), onModuleChange: id => shell.navigateToModule(id) }).bind();
  details = createCookbookDetailsFeature({ getCookbooks: () => books, cookbookController: controller, cookbookApi: api,
    getSessionIdentity: () => actor, getAccessSnapshot: () => access, isOnlineForSync: () => online,
    confirmDanger: options => confirm.confirmDanger(options), selectCookbook: id => nav.selectCookbook(id),
    normalizeActiveCookbookNavigation: () => nav.normalizeActiveCookbookNavigation(), focusActiveCookbookAction: () => nav.focusActiveCookbookAction(),
    refreshCookbooks: async () => { nav.render(); }, removeCookbookAccess: removeAccess, onError: error => errors.push(error.message),
    getPendingMutations: () => getAll('syncQueue'),
  });
  details.bind(); nav.activate();
  document.getElementById('search-input').addEventListener('input', () => shell.handleSearch());
  window.testCookbooks = { nav, details, api, shell, calls, errors,
    pendingCommits: () => pendingCommits, books: () => structuredClone(books), queue: () => getAll('syncQueue'), stored: () => getAll('cookbooks'),
    createCustom: () => controller.create({ name: 'Own custom receipt', client_mutation_id: '123' }),
    seed: async book => { await put('cookbooks', book); setBooks([...books, book]); },
    acknowledge: async id => { for (const entry of await getAll('syncQueue')) if (String(entry.data.id ?? entry.data.temp_id) === String(id) && entry.action.includes('COOKBOOK')) await remove('syncQueue', entry.id); },
    setBooks, setActor: value => { actor = value; }, setOnline: value => { online = value; },
    defer: () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); deferredCommit = { promise, resolve }; },
    release: () => { const pending = deferredCommit; deferredCommit = null; pending?.resolve(); },
    canonical: async (from, to) => { const book = books.find(book => String(book.id) === String(from)); const entity = { ...book, id: to, client_mutation_id: book.client_mutation_id ?? from, created_by_user_id: 11, is_pending: false }; const queue = await getAll('syncQueue'); const create = queue.find(entry => entry.action === 'CREATE_COOKBOOK' && entry.data.temp_id === from); await commitCookbookReplay({ entity, removeIds: [from], queueDeleteId: create?.id }); setBooks(books.map(book => String(book.id) === String(from) ? entity : book)); },
  };
`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.route('http://cookbooks.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') {
      const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      return route.fulfill({ contentType: 'text/html', body: html.replace('</body>', '<script type="module" src="/fixture.js"></script></body>') });
    }
    if (pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: fixture });
    if (pathname.startsWith('/static/')) {
      try { return route.fulfill({ body: readFileSync(new URL(`../web${pathname}`, import.meta.url)), contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.json') ? 'application/json' : pathname.endsWith('.css') ? 'text/css' : 'application/octet-stream' }); }
      catch { return route.fulfill({ status: 404, body: `Missing asset: ${pathname}` }); }
    }
    return route.fulfill({ status: 404, body: 'No service used by this fixture' });
  });
  await page.goto('http://cookbooks.test/');
  await page.waitForFunction(() => Boolean(window.testCookbooks));
  const modal = page.locator('#cookbook-modal');
  const detail = id => page.locator(`#cookbook-sidebar [data-entity-sidebar-action="detail"][data-entity-id="${id}"]`);
  const add = page.locator('#module-sidebar-slot [data-entity-type="cookbook"][data-entity-sidebar-action="add"]');
  const closed = () => page.waitForFunction(() => document.getElementById('cookbook-modal').getAttribute('aria-hidden') === 'true' && !(history.state?.niaTodoUi?.layers || []).includes('cookbook-modal'));
  const close = async () => { await modal.locator('button[data-close-modal="cookbook-modal"]').click(); await closed(); };
  assert.equal(await page.locator('#cookbook-sidebar .entity-sidebar-select').count(), 4);
  assert.equal(await page.locator('#cookbook-sidebar [data-entity-section="household"] .entity-sidebar-select').count(), 2);
  assert.equal(await page.locator('#cookbook-sidebar [data-entity-section="shared"] .entity-sidebar-select').count(), 1);
  assert.equal(await page.locator('#workspace-switcher').isHidden(), true);
  assert.equal(await page.locator('[data-module-panel="recipes"][data-module-slot="floating"] button').count(), 0);
  assert.equal(await page.locator('#cookbook-navigation-main h1').textContent(), 'Personal');
  assert.equal(await page.locator('#cookbook-navigation-main').getByText('<Plain text>', { exact: true }).count(), 1, 'descriptions must render as escaped plain text');

  await page.locator('#cookbook-sidebar .entity-sidebar-select[data-entity-id="1"]').click();
  await page.locator('#cookbook-sidebar .entity-sidebar-select[data-entity-id="2"]').click();
  await page.goBack();
  await page.waitForFunction(() => window.testCookbooks.nav.getActiveCookbookId() === 1);

  await add.click();
  await modal.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#cookbook-save-btn').isHidden(), true);
  await page.fill('#cookbook-name', 'Family meals'); await page.fill('#cookbook-description', 'Weeknight meals');
  await page.selectOption('#cookbook-household-id', '7', { force: true });
  await page.click('#cookbook-save-btn'); await closed();
  const created = await waitForPageCondition(page, () => window.testCookbooks.books().find(book => book.name === 'Family meals'));
  assert.equal(created.owner_household_id, 7);
  assert.equal(created.can_manage, true);
  const queue = await page.evaluate(() => window.testCookbooks.queue());
  assert.equal(queue[0].data.client_mutation_id, created.id);
  assert.equal(queue[0].data.description, 'Weeknight meals');
  await detail(created.id).click();
  await page.fill('#cookbook-name', 'Preserve this draft'); await page.fill('#cookbook-description', 'Still unsaved');
  await page.evaluate(id => { const test = window.testCookbooks; test.setBooks([...test.books(), { id: 82, client_mutation_id: id, created_by_user_id: 22, name: 'Other creator', can_manage: false, is_shared: true }]); }, created.id);
  assert.equal(await page.locator('#cookbook-id').inputValue(), created.id, 'another creator with the same CMI must not remap the open editor');
  assert.equal(await page.evaluate(() => window.testCookbooks.nav.getActiveCookbookId()), created.id, 'another creator receipt must not change selection');
  await page.evaluate(from => window.testCookbooks.canonical(from, 81), created.id);
  assert.equal(await page.locator('#cookbook-id').inputValue(), '81');
  assert.equal(await page.locator('#cookbook-name').inputValue(), 'Preserve this draft');
  assert.equal(await page.locator('#cookbook-description').inputValue(), 'Still unsaved');
  await close();
  await page.evaluate(() => window.testCookbooks.nav.selectCookbook(2));
  await page.goBack();
  await page.waitForFunction(() => window.testCookbooks.nav.getActiveCookbookId() === 81);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#sidebar-toggle-btn'); await detail(1).click();
  assert.equal(await page.locator('#sidebar').evaluate(node => node.classList.contains('open')), false);
  await page.fill('#cookbook-description', 'Updated description'); await page.click('#cookbook-save-btn'); await closed();
  assert.equal((await page.evaluate(() => window.testCookbooks.stored())).find(book => book.id === 1).description, 'Updated description');
  await page.click('#sidebar-toggle-btn'); await detail(3).click();
  assert.equal(await page.locator('#cookbook-name').isDisabled(), true);
  assert.equal(await page.locator('#cookbook-description').isDisabled(), true);
  assert.equal(await page.locator('#cookbook-save-btn').isHidden(), true);
  assert.equal(await page.locator('#cookbook-detail-header-menu').isHidden(), true);
  await page.locator('#cookbook-leave-row button').click();
  await closed();
  await waitForPageCondition(page, () => !window.testCookbooks.books().some(book => book.id === 3));

  await page.setViewportSize({ width: 1280, height: 900 });
  await detail(1).click();
  await page.locator('#cookbook-share-start-row button').click();
  await page.fill('#cookbook-share-identifier', 'moni'); await page.locator('#cookbook-share-row button').click();
  await page.locator('#cookbook-members-list .entity-sharing-member-row').waitFor({ state: 'visible' });
  await page.locator('#cookbook-members-list [data-entity-sharing-action="revoke"]').click();
  await page.click('#confirm-confirm-btn');
  await page.locator('#cookbook-members-list .entity-sharing-member-row').waitFor({ state: 'hidden' });
  await page.selectOption('#cookbook-household-id', '7', { force: true });
  await page.click('#cookbook-save-btn'); await page.click('#confirm-confirm-btn');
  await page.locator('#cookbook-error').getByText(/synchronisiert/).waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => window.testCookbooks.calls.some(call => call[0] === 'transfer')), false, 'pending metadata writes must block household transfer');
  await page.evaluate(() => window.testCookbooks.acknowledge(1));
  await page.click('#cookbook-save-btn'); await page.click('#confirm-confirm-btn'); await closed();
  assert.equal((await page.evaluate(() => window.testCookbooks.books())).find(book => book.id === 1).owner_household_id, 7);
  assert.deepEqual(await page.evaluate(() => window.testCookbooks.calls.filter(call => ['share', 'revoke', 'transfer', 'leave'].includes(call[0])).map(call => call[0])), ['leave', 'share', 'revoke', 'transfer']);
  await detail(81).click();
  await page.locator('#cookbook-detail-header-menu summary').click(); await page.click('#cookbook-delete-btn');
  await page.click('#confirm-confirm-btn'); await closed();
  await waitForPageCondition(page, () => !window.testCookbooks.books().some(book => book.id === 81));
  assert.equal((await page.evaluate(() => window.testCookbooks.stored())).some(book => book.id === 81), false, 'delete must durably remove the cookbook');

  await page.evaluate(() => window.testCookbooks.nav.setInvites([{ id: 91, entity_type: 'cookbook', entity_id: 90, entity_name: 'Invitation' }]));
  assert.equal(await page.locator('#cookbook-sidebar [data-entity-id="90"]').count(), 0);
  await page.locator('#cookbook-invites-list [data-entity-invitation-action="accept"]').click();
  await page.locator('#cookbook-invites-section').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#cookbook-sidebar .entity-sidebar-select[data-entity-id="90"]').count(), 1);

  await page.evaluate(() => window.testCookbooks.seed({ id: 123, name: 'Canonical ID123', owner_household_id: 7, can_manage: true, created_by_user_id: 22 }));
  const custom = await page.evaluate(() => window.testCookbooks.createCustom());
  assert.notEqual(custom.id, '123', 'custom mutation IDs must have an independent temporary entity ID');
  await page.locator('#cookbook-sidebar .entity-sidebar-select[data-entity-id="123"]').click();
  assert.equal(await page.locator('#cookbook-navigation-main h1').textContent(), 'Canonical ID123', 'an exact canonical ID takes precedence over another cookbook CMI');
  await page.locator(`#cookbook-sidebar .entity-sidebar-select[data-entity-id="${custom.id}"]`).click();
  await detail(custom.id).click(); await page.fill('#cookbook-name', 'Custom receipt draft');
  await page.evaluate(from => window.testCookbooks.canonical(from, 181), custom.id);
  assert.equal(await page.locator('#cookbook-id').inputValue(), '181', 'receipt must remap the actual temporary ID when it differs from CMI');
  assert.equal(await page.locator('#cookbook-name').inputValue(), 'Custom receipt draft');
  assert.equal(await page.evaluate(() => window.testCookbooks.nav.getActiveCookbookId()), 181);
  await close();
  await page.locator('#cookbook-sidebar .entity-sidebar-select[data-entity-id="123"]').click();
  assert.equal(await page.evaluate(() => window.testCookbooks.nav.remapCookbookId('123', 181)), false, 'a mutation ID cannot remap an existing other canonical cookbook');
  assert.equal(await page.evaluate(() => window.testCookbooks.nav.getActiveCookbookId()), 123);
  await page.goBack();
  await page.waitForFunction(() => window.testCookbooks.nav.getActiveCookbookId() === 181);
  await page.goBack();
  await page.waitForFunction(() => window.testCookbooks.nav.getActiveCookbookId() === 123);

  await detail(2).click(); await page.fill('#cookbook-name', 'Must not save after revocation');
  const before = await page.evaluate(async () => (await window.testCookbooks.queue()).length);
  await page.evaluate(() => window.testCookbooks.defer()); await page.click('#cookbook-save-btn');
  await page.evaluate(() => { const test = window.testCookbooks; test.setBooks(test.books().map(book => book.id === 2 ? { ...book, can_manage: false } : book)); test.release(); });
  await page.waitForFunction(() => document.getElementById('cookbook-name').disabled);
  await waitForPageCondition(page, () => window.testCookbooks.pendingCommits() === 0);
  assert.equal((await page.evaluate(() => window.testCookbooks.queue())).length, before, 'permission loss at durable commit must not enqueue edits');
  await close();

  await add.click(); await page.fill('#cookbook-name', 'Old account draft');
  await page.evaluate(() => window.testCookbooks.defer()); await page.click('#cookbook-save-btn');
  await page.evaluate(async () => { window.testCookbooks.setActor(null); await window.testCookbooks.nav.suspendAccessPrivacy(); window.testCookbooks.release(); });
  await closed();
  await waitForPageCondition(page, () => window.testCookbooks.pendingCommits() === 0);
  assert.equal((await page.evaluate(() => window.testCookbooks.queue())).length, before, 'account transition must cancel the previous session draft');
  await page.evaluate(() => { const test = window.testCookbooks; test.setActor('11:session'); test.nav.resumeAccessPrivacy(); test.setBooks(test.books().map(book => book.id === 1 ? { ...book, name: 'L'.repeat(200), description: 'D'.repeat(4000) } : book)); test.nav.selectCookbook(1); });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `cookbook page must not overflow at ${width}px`);
    if (process.env.NIA_TODO_TEST_OUTPUT_DIR) { mkdirSync(process.env.NIA_TODO_TEST_OUTPUT_DIR, { recursive: true }); await page.screenshot({ path: `${process.env.NIA_TODO_TEST_OUTPUT_DIR}/cookbooks-${width}.png`, fullPage: true }); }
  }
  await page.click('#sidebar-toggle-btn'); await detail(1).click();
  assert.equal(await modal.evaluate(element => element.querySelector('.modal-content').scrollWidth <= element.querySelector('.modal-content').clientWidth), true, 'mobile cookbook editor must not overflow');
  await page.locator('#cookbook-description').press('Escape'); await closed();
  assert.deepEqual(await page.evaluate(() => window.testCookbooks.errors), []);
  assert.deepEqual(errors, []);
  console.log('✅ Cookbooks shared UI, ownership, invitations, durable mutations, session fences and mobile layout passed');
} finally { await browser.close(); }

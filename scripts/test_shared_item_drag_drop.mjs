#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';

const fixtureSource = `
  import { createDragDropFeature } from '/static/js/features/drag-drop.js';
  import { createSectionRootRegistry, renderSectionCollection } from '/static/js/features/section-ui.js';
  import { createShoppingItemsController, renderShoppingItem } from '/static/js/features/shopping-items.js';

  let lists = [{
    id: 7,
    can_edit: true,
    can_manage: false,
    sections: [
      { id: 71, name: 'Produce', sort_order: 0 },
      { id: 72, name: 'Bakery', sort_order: 1 },
    ],
    items: [
      { id: 711, client_mutation_id: 'stable-milk', name: 'Milk', section_id: 71, completed: false },
      { id: 712, name: 'Bread', section_id: 72, completed: false },
    ],
  }];
  let mutationCount = 0;
  let editCount = 0;
  const root = document.getElementById('shopping-root');
  const sectionRegistry = createSectionRootRegistry();
  let controller;

  const labels = item => ({
    markCompleted: item.name + ' complete',
    markOpen: item.name + ' reopen',
    edit: item.name + ' edit',
    swipeComplete: 'Complete',
    swipeReopen: 'Reopen',
  });

  const itemDrag = {
    cardSelector: '[data-item-dnd="true"][data-shopping-item-key]',
    interactiveStartSelector: '.shopping-item-edit-trigger',
    protectedStartSelector: '.shopping-item-check',
    canDrag: () => lists[0]?.can_edit === true,
    keyFromElement: element => element.dataset.shoppingItemKey,
    resolveSectionId: rawId => rawId === 'null'
      ? null
      : (lists[0].sections.find(section => String(section.id) === String(rawId))?.id ?? rawId),
    moveToSection: (key, sectionId) => controller.moveToSection(7, key, sectionId),
    focusItem: key => {
      const item = lists[0].items.find(candidate => String(candidate.id) === String(key) || String(candidate.client_mutation_id) === String(key));
      Array.from(root.querySelectorAll('.shopping-item-card[data-shopping-item-key]'))
        .find(element => String(element.dataset.shoppingItemKey) === String(item?.id))
        ?.querySelector('.shopping-item-edit-trigger')
        ?.focus();
    },
  };
  const sectionAdapter = {
    getRoot: () => root,
    getSections: () => lists[0].sections,
    canManage: () => false,
    resolveSectionId: itemDrag.resolveSectionId,
    itemDrag,
  };

  function render() {
    root.innerHTML = renderSectionCollection({
      sections: lists[0].sections,
      items: lists[0].items,
      canManage: false,
      unsortedLabel: 'Unsorted',
      showUnsorted: true,
      renderItem: item => renderShoppingItem({ item, canEdit: lists[0].can_edit, labels: labels(item) }),
    });
    controller.bindRoot(root);
  }

  controller = createShoppingItemsController({
    getLists: () => lists,
    setLists: next => { lists = next; },
    getActiveListId: () => 7,
    commitMutation: async build => {
      const mutation = build();
      if (mutation) mutationCount += 1;
      return mutation;
    },
    render,
    onEdit: () => { editCount += 1; },
  });
  render();
  sectionRegistry.register(root, sectionAdapter);
  const dragDrop = createDragDropFeature({ sectionRegistry, taskSectionAdapter: null });
  dragDrop.bindStandardDragDrop();
  dragDrop.bindNativePointerDragDrop();

  window.test = {
    mutationCount: () => mutationCount,
    editCount: () => editCount,
    sectionId: key => lists[0].items.find(item => String(item.id) === String(key) || String(item.client_mutation_id) === String(key))?.section_id,
    completed: key => lists[0].items.find(item => String(item.id) === String(key) || String(item.client_mutation_id) === String(key))?.completed,
  };
`;

const browserName = process.env.ITEM_DND_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const browser = await ({ chromium, webkit })[browserName].launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error?.stack || error)));

async function installFixtureRoutes(targetPage) {
  await targetPage.route('http://nia.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html class="mobile-swipe-ui"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/style.css"></head><body><main id="shopping-root" data-section-root="shopping"></main><aside id="foreign-root"><div class="section-todos" data-section-id="72"></div></aside><script type="module" src="/fixture.js"></script></body></html>',
      });
      return;
    }
    if (url.pathname === '/fixture.js') {
      await route.fulfill({ contentType: 'text/javascript', body: fixtureSource });
      return;
    }
    if (url.pathname.startsWith('/static/')) {
      try {
        const body = readFileSync(new URL(`../web${url.pathname}`, import.meta.url), 'utf8');
        const contentType = url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript';
        await route.fulfill({ contentType, body });
      } catch {
        await route.fulfill({ status: 404, contentType: 'text/plain', body: `Missing fixture asset: ${url.pathname}` });
      }
      return;
    }
    await route.fulfill({ status: 404, contentType: 'text/plain', body: `Unexpected fixture request: ${url.pathname}` });
  });
}

try {
  await installFixtureRoutes(page);

  await page.goto('http://nia.test/');
  await page.waitForFunction(() => Boolean(window.test));

  const source = page.locator('.shopping-item-card[data-shopping-item-key="711"]');
  const target = page.locator('#shopping-root .section-todos[data-section-id="72"]');
  await source.locator('.shopping-item-edit-trigger').focus();
  await source.dispatchEvent('dragstart', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
  const draggingStyle = await source.evaluate(element => ({
    borderStyle: getComputedStyle(element).borderStyle,
    opacity: getComputedStyle(element).opacity,
  }));
  assert.equal(draggingStyle.borderStyle, 'dashed', 'all dragged item cards must share the Todo source feedback');
  assert.equal(draggingStyle.opacity, '0.6');
  await target.dispatchEvent('dragover', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
  await target.dispatchEvent('drop', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
  await page.waitForFunction(() => window.test.sectionId('stable-milk') === 72);

  assert.equal(await page.evaluate(() => window.test.mutationCount()), 1);
  assert.equal(await page.locator('.section-todos[data-section-id="72"] .shopping-item-card[data-shopping-item-key="711"]').count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('shopping-item-edit-trigger')), true, 'focus must follow the moved card after rerender');

  const movedSource = page.locator('.shopping-item-card[data-shopping-item-key="711"]');
  await movedSource.dispatchEvent('dragstart', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
  await target.dispatchEvent('drop', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.test.mutationCount()), 1, 'dropping into the current section must be a no-op');

  await movedSource.dispatchEvent('dragstart', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
  await page.locator('#foreign-root .section-todos').dispatchEvent('drop', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.test.mutationCount()), 1, 'a drop outside the registered module root must be ignored');

  await movedSource.dispatchEvent('dragstart', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
  await page.locator('.section-todos[data-section-id="null"]').dispatchEvent('drop', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
  await page.waitForFunction(() => window.test.sectionId('stable-milk') === null);
  assert.equal(await page.evaluate(() => window.test.mutationCount()), 2, 'dropping into the unsectioned container must clear section_id');

  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mobilePage = await mobileContext.newPage();
  const mobileErrors = [];
  mobilePage.on('pageerror', error => mobileErrors.push(String(error?.stack || error)));
  await installFixtureRoutes(mobilePage);
  await mobilePage.goto('http://nia.test/');
  await mobilePage.waitForFunction(() => Boolean(window.test));

  async function touch(type, selector, { pointerId, x, y } = {}) {
    const box = await mobilePage.locator(selector).boundingBox();
    assert.ok(box, `missing mobile box for ${selector}`);
    await mobilePage.locator(selector).dispatchEvent(type, {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: x ?? box.x + box.width / 2,
      clientY: y ?? box.y + box.height / 2,
      bubbles: true,
      cancelable: true,
    });
  }

  const mobileTrigger = '#shopping-root .shopping-item-card[data-shopping-item-key="711"] .shopping-item-edit-trigger';
  await touch('pointerdown', mobileTrigger, { pointerId: 81 });
  await touch('pointerup', mobileTrigger, { pointerId: 81 });
  await mobilePage.locator(mobileTrigger).dispatchEvent('click');
  assert.equal(await mobilePage.evaluate(() => window.test.editCount()), 1, 'a short tap must keep opening the item editor');

  await touch('pointerdown', mobileTrigger, { pointerId: 82 });
  const triggerBox = await mobilePage.locator(mobileTrigger).boundingBox();
  await touch('pointermove', mobileTrigger, { pointerId: 82, x: triggerBox.x + triggerBox.width / 2, y: triggerBox.y + triggerBox.height / 2 + 32 });
  await mobilePage.waitForTimeout(360);
  assert.equal(await mobilePage.locator('body.native-pointer-dragging').count(), 0, 'vertical movement before the hold threshold must remain scrolling');
  assert.equal(await mobilePage.evaluate(() => window.test.mutationCount()), 0);

  await touch('pointerdown', mobileTrigger, { pointerId: 85 });
  const swipeBox = await mobilePage.locator(mobileTrigger).boundingBox();
  await touch('pointermove', mobileTrigger, { pointerId: 85, x: swipeBox.x - 160, y: swipeBox.y + swipeBox.height / 2 });
  await touch('pointerup', mobileTrigger, { pointerId: 85, x: swipeBox.x - 160, y: swipeBox.y + swipeBox.height / 2 });
  await mobilePage.waitForFunction(() => window.test.completed('stable-milk') === true);
  assert.equal(await mobilePage.locator('body.native-pointer-dragging').count(), 0, 'horizontal movement must stay with the shared swipe controller');
  assert.equal(await mobilePage.evaluate(() => window.test.mutationCount()), 1);

  const checkbox = '#shopping-root .shopping-item-card[data-shopping-item-key="711"] .shopping-item-check';
  await touch('pointerdown', checkbox, { pointerId: 83 });
  await mobilePage.waitForTimeout(360);
  assert.equal(await mobilePage.locator('body.native-pointer-dragging').count(), 0, 'the completion checkbox must never start item drag-and-drop');
  await touch('pointerup', checkbox, { pointerId: 83 });

  const destination = mobilePage.locator('#shopping-root .section-todos[data-section-id="72"]');
  const destinationBox = await destination.boundingBox();
  await touch('pointerdown', mobileTrigger, { pointerId: 84 });
  await mobilePage.waitForTimeout(360);
  assert.equal(await mobilePage.locator('body.native-pointer-dragging').count(), 1, 'a stationary 320ms hold on the edit surface must activate drag-and-drop');
  const mobileSourceStyle = await mobilePage.locator('.shopping-item-card[data-shopping-item-key="711"]:not(.native-drag-ghost)').evaluate(element => ({
    borderStyle: getComputedStyle(element).borderStyle,
    opacity: getComputedStyle(element).opacity,
  }));
  assert.equal(mobileSourceStyle.borderStyle, 'dashed', 'the held source card must keep the shared dragged-item outline');
  assert.equal(mobileSourceStyle.opacity, '0.6');
  const ghostBeforeMove = await mobilePage.locator('.native-drag-ghost.shopping-item-card').evaluate(element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      position: style.position,
      visibility: style.visibility,
      opacity: style.opacity,
      borderStyle: style.borderStyle,
      boxShadow: style.boxShadow,
      x: rect.x,
      y: rect.y,
    };
  });
  assert.equal(ghostBeforeMove.position, 'fixed', 'the cloned item must be viewport-positioned so it follows the finger independently of document flow');
  assert.equal(ghostBeforeMove.visibility, 'visible');
  assert.equal(ghostBeforeMove.opacity, '0.92');
  assert.equal(ghostBeforeMove.borderStyle, 'solid', 'the moving clone must keep the highlighted outline');
  assert.notEqual(ghostBeforeMove.boxShadow, 'none');
  await touch('pointermove', mobileTrigger, {
    pointerId: 84,
    x: destinationBox.x + destinationBox.width / 2,
    y: destinationBox.y + Math.max(4, destinationBox.height / 2),
  });
  await touch('pointerup', mobileTrigger, {
    pointerId: 84,
    x: destinationBox.x + destinationBox.width / 2,
    y: destinationBox.y + Math.max(4, destinationBox.height / 2),
  });
  await mobilePage.waitForFunction(() => window.test.sectionId('stable-milk') === 72);
  assert.equal(await mobilePage.evaluate(() => window.test.mutationCount()), 2);
  assert.equal(await mobilePage.locator('.native-drag-ghost').count(), 0, 'the drag ghost must be cleaned after drop');
  assert.equal(await mobilePage.locator('body.native-pointer-dragging').count(), 0, 'the global drag state must be cleaned after drop');

  const movedMobileTrigger = '.section-todos[data-section-id="72"] .shopping-item-card[data-shopping-item-key="711"] .shopping-item-edit-trigger';
  await mobilePage.locator(movedMobileTrigger).dispatchEvent('click');
  assert.equal(await mobilePage.evaluate(() => window.test.editCount()), 1, 'the synthetic click after long-press drag must be suppressed only on the dragged card');
  await mobilePage.waitForTimeout(650);
  await mobilePage.locator(movedMobileTrigger).dispatchEvent('click');
  assert.equal(await mobilePage.evaluate(() => window.test.editCount()), 2, 'the moved card must remain normally editable after suppression expires');

  assert.equal(mobileErrors.length, 0, mobileErrors.join('\n'));
  await mobileContext.close();
  console.log(`✅ Shared Shopping item drag-drop desktop and touch contracts passed (${browserName})`);
} finally {
  await browser.close();
}

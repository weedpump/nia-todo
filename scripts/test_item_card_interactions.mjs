#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const fixtureSource = `
  import { renderTodoItem } from '/static/js/features/todo-rendering.js';
  import { renderShoppingItem } from '/static/js/features/shopping-items.js';
  import { bindItemCardInteractions } from '/static/js/ui/item-card.js';
  import { createDragDropFeature } from '/static/js/features/drag-drop.js';

  const root = document.querySelector('main');
  root.innerHTML = renderTodoItem({
    id: 1, title: 'Plan dinner', status: 'pending', priority: 3,
    description: 'Read the [recipe](https://example.test/recipe) before shopping.',
  }) + renderShoppingItem({
    item: { id: 2, name: 'Milk', quantity_value: 2, quantity_unit: 'l', note: 'Fresh' },
    canEdit: true, labels: { markCompleted: 'Complete milk', edit: 'Edit milk' },
  }) + renderShoppingItem({
    item: { id: 3, name: 'Read-only bread' }, canEdit: false,
    labels: { markCompleted: 'Complete bread' },
  });

  const counts = { todo: 0, shopping: 0 };
  let enabled = true;
  let preventActivation = false;
  let destroy = () => {};
  let lastTrigger = null;
  root.addEventListener('click', event => {
    if (preventActivation) event.preventDefault();
  }, true);
  const bind = () => {
    destroy();
    destroy = bindItemCardInteractions({
      root,
      cardSelector: '.ui-item-card',
      protectedTargetSelector: '.todo-actions, .todo-status-control, .shopping-item-check',
      canActivate: item => enabled && Boolean(item.querySelector('[data-item-card-open]')),
      onActivate: (item, trigger) => {
        counts[item.matches('.todo-item') ? 'todo' : 'shopping'] += 1;
        lastTrigger = trigger;
      },
    });
  };
  bind();
  const dragDrop = createDragDropFeature({
    taskSectionAdapter: {
      itemDrag: {
        canDrag: () => true,
        keyFromElement: item => item.dataset.id || item.dataset.shoppingItemKey,
        moveToSection: async () => null,
      },
    },
  });
  let nativeDragStarts = 0;
  dragDrop.bindStandardDragDrop();
  document.addEventListener('dragstart', event => {
    if (event.isTrusted && event.target.closest('.ui-item-card')?.classList.contains('dragging')) nativeDragStarts += 1;
  });
  // The private empty drop sink accepts native dragging without mutating an item.
  document.addEventListener('dragover', event => event.preventDefault());
  window.test = {
    counts: () => ({ ...counts }),
    setEnabled: value => { enabled = value; },
    setPrevented: value => { preventActivation = value; },
    triggerIs: selector => lastTrigger === document.querySelector(selector),
    destroy: () => destroy(),
    bind,
    nativeDragStarts: () => nativeDragStarts,
    renderAppearancePairs: () => {
      root.innerHTML = [
        renderTodoItem({ id: 10, title: 'Same title', status: 'pending', priority: 3 }),
        renderShoppingItem({ item: { id: 11, name: 'Same title' }, canEdit: true, labels: { edit: 'Edit same title' } }),
        renderTodoItem({ id: 12, title: 'Same title', status: 'pending', priority: 3, description: 'Secondary text' }),
        renderShoppingItem({ item: { id: 13, name: 'Same title', note: 'Secondary text' }, canEdit: true, labels: { edit: 'Edit same title' } }),
        renderTodoItem({ id: 14, title: 'Same title', status: 'done', priority: 3 }),
        renderShoppingItem({ item: { id: 15, name: 'Same title', completed: true }, canEdit: true, labels: { edit: 'Edit same title' } }),
      ].join('');
    },
  };
`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.setDefaultTimeout(5000);
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error?.stack || error)));

try {
  await page.route('http://nia.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <html><head><link rel="stylesheet" href="/static/style.css"></head>
        <body><main style="padding:40px"></main><script type="module" src="/fixture.js"></script></body></html>` });
    } else if (pathname === '/fixture.js') {
      await route.fulfill({ contentType: 'text/javascript', body: fixtureSource });
    } else if (pathname.startsWith('/static/')) {
      try {
        await route.fulfill({
          contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: readFileSync(new URL(`../web${pathname}`, import.meta.url), 'utf8'),
        });
      } catch {
        await route.fulfill({ status: 404, body: 'Missing fixture asset' });
      }
    } else {
      await route.fulfill({ status: 404, body: 'Unexpected fixture request' });
    }
  });
  await page.goto('http://nia.test/');
  await page.waitForFunction(() => Boolean(window.test));

  const cards = [
    { key: 'todo', selector: '.todo-item[data-id="1"]' },
    { key: 'shopping', selector: '.shopping-item-card[data-shopping-item-key="2"]' },
  ];
  const counts = () => page.evaluate(() => window.test.counts());
  const clickCardSpace = async card => {
    const width = await card.evaluate(element => element.clientWidth);
    await card.click({ position: { x: width / 2, y: 6 } });
  };

  for (const { key, selector } of cards) {
    const card = page.locator(selector);
    const action = card.locator('[data-item-card-open]');
    assert.equal(await action.count(), 1, `${key}: one shared native open action`);
    assert.equal(await action.evaluate(element => element.tagName), 'BUTTON');
    assert.ok(await action.getAttribute('aria-label'), `${key}: the open action must be named`);

    let before = await counts();
    await clickCardSpace(card);
    assert.equal((await counts())[key], before[key] + 1, `${key}: clicking free card space opens it once`);
    before = await counts();
    await action.click();
    assert.equal((await counts())[key], before[key] + 1, `${key}: clicking the title opens it once`);
    assert.equal(await page.evaluate(selector => window.test.triggerIs(selector), `${selector} [data-item-card-open]`), true, `${key}: opening returns the live shared focus target`);

    // A real pressed title must highlight its card, without the former child rectangle.
    const bounds = await action.boundingBox();
    assert.ok(bounds);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    assert.equal(await action.evaluate(element => element.matches(':active')), true);
    assert.equal(await card.evaluate(element => element.classList.contains('ui-item-card-press-active')), true);
    const innerStyle = await action.evaluate(async element => {
      await Promise.all(element.getAnimations().map(animation => animation.finished));
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, shadow: style.boxShadow, transform: style.transform };
    });
    assert.deepEqual(innerStyle, { background: 'rgba(0, 0, 0, 0)', shadow: 'none', transform: 'none' }, `${key}: pressed title feedback must belong to the card`);
    await page.mouse.up();
    assert.equal(await card.evaluate(element => element.classList.contains('ui-item-card-press-active')), false);

    for (const end of ['move', 'cancel', 'drag']) {
      await action.dispatchEvent('pointerdown', { pointerId: 41, isPrimary: true, button: 0, clientX: 50, clientY: 50 });
      assert.equal(await card.evaluate(element => element.classList.contains('ui-item-card-press-active')), true);
      if (end === 'move') {
        await action.dispatchEvent('pointermove', { pointerId: 41, clientX: 58, clientY: 50 });
      } else if (end === 'cancel') {
        await action.dispatchEvent('pointercancel', { pointerId: 41 });
      } else {
        await card.dispatchEvent('dragstart');
      }
      assert.equal(await card.evaluate(element => element.classList.contains('ui-item-card-press-active')), false, `${key}: ${end} must clear card press feedback`);
    }

    for (const keyboardKey of ['Enter', 'Space']) {
      await action.focus();
      before = await counts();
      await page.keyboard.press(keyboardKey);
      assert.equal((await counts())[key], before[key] + 1, `${key}: native ${keyboardKey} activation fires once`);
    }
    const focus = await action.evaluate(element => ({
      visible: element.matches(':focus-visible'),
      outlineStyle: getComputedStyle(element).outlineStyle,
      outlineWidth: getComputedStyle(element).outlineWidth,
    }));
    assert.equal(focus.visible, true, `${key}: keyboard activation retains visible focus`);
    assert.equal(focus.outlineStyle, 'solid');
    assert.notEqual(focus.outlineWidth, '0px');
  }

  const isolatedBefore = await counts();
  // The legacy Todo checkbox is hidden in the desktop status-menu layout.
  await page.locator('.todo-check').dispatchEvent('click');
  // Actions may be collapsed until the module's separate reveal controller runs.
  await page.locator('.todo-pin-btn').dispatchEvent('click');
  for (const selector of ['.todo-status-menu-left > summary', '.shopping-item-check']) {
    await page.locator(selector).first().click();
  }
  const link = page.locator('.todo-desc-preview a');
  assert.equal(await link.count(), 1, 'the actual Todo renderer must retain the Markdown link');
  assert.equal(await link.evaluate(element => element.closest('[data-item-card-open]')), null, 'description links must not be nested in the open button');
  assert.equal(await link.getAttribute('href'), 'https://example.test/recipe');
  // Prevent navigation after root delegation so this tests the interactive exclusion itself.
  await page.evaluate(() => document.addEventListener('click', event => {
    if (event.target.closest('.todo-desc-preview a')) event.preventDefault();
  }));
  await link.click();
  assert.deepEqual(await counts(), isolatedBefore, 'checkbox, menu, action and description-link clicks must stay isolated');

  await page.evaluate(() => window.test.setPrevented(true));
  for (const { selector } of cards) await page.locator(`${selector} [data-item-card-open]`).click();
  await page.evaluate(() => window.test.setPrevented(false));
  assert.deepEqual(await counts(), isolatedBefore, 'defaultPrevented clicks must not activate cards');

  await page.evaluate(() => window.test.setEnabled(false));
  for (const { selector } of cards) {
    await clickCardSpace(page.locator(selector));
    assert.equal(await page.locator(selector).evaluate(element => element.classList.contains('ui-item-card-press-active')), false);
  }
  assert.deepEqual(await counts(), isolatedBefore, 'canActivate guards must block activation');
  await page.evaluate(() => window.test.setEnabled(true));

  const readOnly = page.locator('.shopping-item-card[data-shopping-item-key="3"]');
  assert.equal(await readOnly.locator('[data-item-card-open]').count(), 0);
  await readOnly.click();
  assert.deepEqual(await counts(), isolatedBefore, 'read-only Shopping content must not activate');

  const firstAction = page.locator(`${cards[0].selector} [data-item-card-open]`);
  await firstAction.dispatchEvent('pointerdown', { pointerId: 52, isPrimary: true, button: 0 });
  await page.evaluate(() => window.test.destroy());
  assert.equal(await page.locator('.ui-item-card-press-active').count(), 0, 'destroy must clear active feedback');
  await firstAction.click();
  assert.deepEqual(await counts(), isolatedBefore, 'destroy must remove activation listeners');
  await page.evaluate(() => { window.test.bind(); window.test.bind(); });
  for (const { key, selector } of cards) {
    const before = await counts();
    await page.locator(`${selector} [data-item-card-open]`).click();
    assert.equal((await counts())[key], before[key] + 1, `${key}: rebinding must not duplicate listeners`);
  }

  await page.evaluate(() => window.test.renderAppearancePairs());
  const pairs = [
    { name: 'plain', todo: '.todo-item[data-id="10"]', shopping: '.shopping-item-card[data-shopping-item-key="11"]' },
    { name: 'with secondary text', todo: '.todo-item[data-id="12"]', shopping: '.shopping-item-card[data-shopping-item-key="13"]' },
    { name: 'completed', todo: '.todo-item[data-id="14"]', shopping: '.shopping-item-card[data-shopping-item-key="15"]' },
  ];
  const environments = [
    { name: 'desktop', width: 1100, mobile: false, native: false },
    { name: 'mobile browser', width: 390, mobile: true, native: false },
    { name: 'native Android mobile', width: 390, mobile: true, native: true },
  ];
  const settle = async locator => locator.evaluate(async item => {
    await Promise.allSettled(item.getAnimations().map(animation => animation.finished));
  });
  const snapshot = async locator => locator.evaluate(async item => {
    await Promise.allSettled(item.getAnimations().map(animation => animation.finished));
    const style = getComputedStyle(item);
    const rect = item.getBoundingClientRect();
    const title = getComputedStyle(item.querySelector('.todo-title, .shopping-item-title'));
    const shell = item.closest('.ui-swipe-shell');
    const shellStyle = shell ? getComputedStyle(shell) : null;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    context.fillStyle = style.backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return {
      surface: Object.fromEntries([
        'backgroundColor', 'backgroundImage', 'opacity', 'transform', 'filter',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
        'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
        'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
        'borderTopLeftRadius', 'borderBottomRightRadius', 'outlineStyle', 'outlineWidth',
        'overflowX', 'overflowY', 'boxShadow', 'minHeight', 'gap', 'paddingTop',
        'paddingBottom', 'paddingLeft', 'transitionProperty', 'transitionDuration',
      ].map(property => [property, style[property]])),
      title: Object.fromEntries(['display', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color', 'textDecorationLine'].map(property => [property, title[property]])),
      shell: shellStyle ? Object.fromEntries(['borderRadius', 'overflowX', 'overflowY'].map(property => [property, shellStyle[property]])) : null,
      backgroundAlpha: context.getImageData(0, 0, 1, 1).data[3],
      width: rect.width, height: rect.height,
      hovered: item.matches(':hover'), focused: item.matches(':focus-within'),
      pressed: item.classList.contains('ui-item-card-press-active'),
      dragging: item.classList.contains('dragging'),
    };
  });
  const clearHoverAndFocus = async () => {
    await page.evaluate(() => document.activeElement?.blur());
    const viewport = page.viewportSize();
    await page.mouse.move(viewport.width - 2, viewport.height - 2);
  };
  const assertLeftAccent = (paint, label) => {
    assert.match(paint.boxShadow, /3px 0px 0px 0px inset$/, `${label}: one inset left accent must mark the active card`);
    assert.equal(paint.boxShadow.includes('), '), false, `${label}: card feedback must not add an outer glow`);
  };
  const assertTransitions = (paint, label) => {
    const properties = paint.transitionProperty.split(',').map(value => value.trim());
    const durations = paint.transitionDuration.split(',').map(value => Number.parseFloat(value));
    const durationFor = property => durations[properties.indexOf(property) % durations.length];
    assert.equal(durationFor('background'), 0.15, `${label}: the Tasks background transition must be shared`);
    assert.equal(durationFor('box-shadow'), 0.15, `${label}: the Tasks accent transition must be shared`);
    assert.equal(durationFor('transform'), 0.12, `${label}: the Tasks movement transition must be shared`);
  };

  for (const environment of environments) {
    await page.setViewportSize({ width: environment.width, height: 844 });
    await page.evaluate(({ mobile, native }) => {
      document.documentElement.classList.toggle('mobile-swipe-ui', mobile);
      document.body.classList.toggle('native-app', native);
      document.body.classList.toggle('native-android', native);
      window.test.renderAppearancePairs();
    }, environment);
    for (const theme of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      for (const pair of pairs) {
        const label = `${environment.name}, ${theme}, ${pair.name}`;
        const states = {};
        for (const module of ['todo', 'shopping']) {
          const card = page.locator(pair[module]);
          const action = card.locator('[data-item-card-open]');
          await clearHoverAndFocus();
          const idle = await snapshot(card);
          assert.equal(idle.hovered, false);
          assert.equal(idle.focused, false);
          assert.equal(Boolean(idle.shell), environment.mobile, `${label} ${module}: mobile cards must use the actual shared swipe wrapper`);
          assertTransitions(idle.surface, `${label} ${module}`);

          await card.hover();
          const hovered = await snapshot(card);
          assertTransitions(hovered.surface, `${label} ${module} hover`);
          assert.equal(hovered.hovered, true, `${label} ${module}: exercise an actual pointer hover`);
          assert.equal(hovered.backgroundAlpha, 255, `${label} ${module}: active background must be opaque, not the translucent idle paint`);
          if (environment.native) assert.equal(hovered.surface.boxShadow, 'none', `${label}: native scrolling hover remains neutral`);
          else {
            assertLeftAccent(hovered.surface, `${label} ${module} hover`);
            if (pair.name !== 'completed') assert.notEqual(hovered.surface.backgroundColor, idle.surface.backgroundColor, `${label} ${module}: hovering must change the background`);
          }

          await clearHoverAndFocus();
          await action.focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Tab');
          assert.equal(await action.evaluate(element => element === document.activeElement), true, `${label} ${module}: keyboard navigation must reach the shared title action`);
          const focused = await snapshot(card);
          assert.equal(focused.focused, true);
          assertTransitions(focused.surface, `${label} ${module} keyboard focus`);
          assert.equal(focused.backgroundAlpha, 255, `${label} ${module}: keyboard focus must paint the complete card`);

          await clearHoverAndFocus();
          const bounds = await action.boundingBox();
          await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          await page.mouse.down();
          const pressed = await snapshot(card);
          assert.equal(pressed.pressed, true, `${label} ${module}: real pointer press belongs to the common card`);
          if (environment.native) assert.equal(pressed.surface.boxShadow, 'none', `${label}: native press feedback remains neutral`);
          await page.mouse.up();

          // Use the production HTML5 drag controller and actual browser mouse input.
          // dispatchEvent('dragstart') alone misses focus/hover paint at snapshot time.
          await clearHoverAndFocus();
          const startsBefore = await page.evaluate(() => window.test.nativeDragStarts());
          const dragBounds = await action.boundingBox();
          await page.mouse.move(dragBounds.x + dragBounds.width / 2, dragBounds.y + dragBounds.height / 2);
          await page.mouse.down();
          await page.mouse.move(environment.width - 2, 820, { steps: 8 });
          await page.waitForFunction(before => window.test.nativeDragStarts() > before, startsBefore);
          const dragging = await snapshot(card);
          assert.equal(dragging.dragging, true, `${label} ${module}: exercise the real dragged source`);
          assert.equal(dragging.backgroundAlpha, 255, `${label} ${module}: dragging must not lose the opaque active background`);
          assertLeftAccent(dragging.surface, `${label} ${module} dragging`);
          assert.equal(dragging.surface.opacity, idle.surface.opacity, `${label} ${module}: dragging must preserve completion opacity`);
          assert.equal(dragging.surface.transitionProperty, 'none', `${label} ${module}: drag paint must not retain the preceding press transition`);
          assert.equal(dragging.surface.transform, 'none', `${label} ${module}: dragging must not scale the card`);
          assert.ok(Math.abs(dragging.width - idle.width) < 0.5 && Math.abs(dragging.height - idle.height) < 0.5, `${label} ${module}: dragging must not resize the card`);
          if (!environment.native) {
            assert.equal(dragging.surface.backgroundColor, hovered.surface.backgroundColor, `${label} ${module}: a dragged card keeps its hovered background`);
          }
          await page.mouse.up();
          await page.waitForFunction(selector => !document.querySelector(selector).classList.contains('dragging'), pair[module]);
          await clearHoverAndFocus();

          // Touch previews are detached under body and inherit neither source hover
          // nor source focus. They must still retain the same active drag surface.
          const ghostHandle = await card.evaluateHandle(item => {
            const ghost = item.cloneNode(true);
            ghost.classList.remove('dragging', 'ui-item-card-press-active', 'touch-feedback');
            ghost.classList.add('native-drag-ghost');
            ghost.style.width = item.getBoundingClientRect().width + 'px';
            ghost.style.left = '40px';
            ghost.style.top = '40px';
            ghost.removeAttribute('draggable');
            document.body.appendChild(ghost);
            return ghost;
          });
          const ghost = await snapshot(ghostHandle.asElement());
          assert.equal(ghost.hovered, false, `${label} ${module}: detached preview must not accidentally inherit hover`);
          assert.equal(ghost.focused, false, `${label} ${module}: detached preview must not inherit source focus`);
          assert.equal(ghost.backgroundAlpha, 255, `${label} ${module}: the detached preview background must remain opaque`);
          assert.deepEqual(ghost.surface, dragging.surface, `${label} ${module}: detached touch preview and real mouse drag share one surface`);
          assert.ok(Math.abs(ghost.width - idle.width) < 0.5 && Math.abs(ghost.height - idle.height) < 0.5, `${label} ${module}: detached preview must preserve source size`);
          await ghostHandle.evaluate(element => element.remove());
          await ghostHandle.dispose();
          states[module] = { idle, hovered, focused, pressed, dragging, ghost };
        }
        for (const state of ['idle', 'hovered', 'focused', 'pressed', 'dragging', 'ghost']) {
          assert.deepEqual(states.shopping[state].surface, states.todo[state].surface, `${label} ${state}: Shopping must use the Tasks tile surface`);
          assert.deepEqual(states.shopping[state].title, states.todo[state].title, `${label} ${state}: title typography belongs to the common tile`);
          assert.deepEqual(states.shopping[state].shell, states.todo[state].shell, `${label} ${state}: mobile swipe wrapper clipping and rounding belong to the same tile`);
        }
      }
    }
  }

  assert.deepEqual(pageErrors, []);
  console.log('✅ Shared Tasks/Shopping activation and direct dark/light desktop/mobile/native hover, focus, press and real drag parity passed');
} finally {
  await browser.close();
}

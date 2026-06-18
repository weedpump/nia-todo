#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function run() {
  console.log('🔽 Running shared UI dropdown primitive test...');
  const { browser, page, openTodoModal, loginApp, assertNoFrontendErrors } = await launchPage();
  const openOrganizePanel = async () => {
    await page.evaluate(() => {
      document.getElementById('todo-modal')?.classList.add('todo-meta-editing');
      const panel = document.getElementById('todo-organize-panel');
      if (panel) panel.open = true;
    });
    await page.locator('#todo-organize-panel').waitFor({ state: 'visible', timeout: 5000 });
  };
  try {
    await loginApp();
    await page.evaluate(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const csrf = localStorage.getItem('csrf_token');
      const headers = { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
      const createProject = async (body) => fetch('/api/projects', { method: 'POST', headers, credentials: 'include', body: JSON.stringify(body) }).then(r => r.json());
      const parent = await createProject({ name: 'Dropdown Parent', color: '#6366f1' });
      const child = await createProject({ name: 'Dropdown Child', color: '#6366f1', parent_id: parent.id, workspace_id: parent.workspace_id });
      await createProject({ name: 'Dropdown Grandchild', color: '#6366f1', parent_id: child.id, workspace_id: parent.workspace_id });
      await window.refreshFromServer?.();
      await window.renderProjects?.();
    });
    await openTodoModal();
    await openOrganizePanel();

    const hiddenNative = await page.evaluate(() => {
      const ids = ['todo-priority', 'todo-status', 'todo-project', 'todo-section'];
      return ids.every((id) => {
        const select = document.getElementById(id);
        const rect = select?.getBoundingClientRect();
        return select?.classList.contains('visually-hidden-native-select') && rect && rect.width <= 1 && rect.height <= 1;
      });
    });
    if (!hiddenNative) throw new Error('Todo modal native selects are still visible');

    const sharedTriggerContract = await page.evaluate(() => {
      const trigger = document.querySelector('.ui-select[data-select-id="todo-priority"] .ui-select-trigger');
      const style = trigger ? getComputedStyle(trigger) : null;
      const rect = trigger?.getBoundingClientRect();
      return {
        exists: Boolean(trigger),
        width: rect?.width || 0,
        height: rect?.height || 0,
        radius: parseFloat(style?.borderRadius || '0'),
        boxShadow: style?.boxShadow,
        display: style?.display,
        alignItems: style?.alignItems,
      };
    });
    if (
      !sharedTriggerContract.exists
      || sharedTriggerContract.width <= 0
      || sharedTriggerContract.height <= 0
      || sharedTriggerContract.radius <= 0
      || sharedTriggerContract.boxShadow !== 'none'
      || !['flex', 'inline-flex'].includes(sharedTriggerContract.display)
      || sharedTriggerContract.alignItems !== 'center'
    ) {
      throw new Error(`Shared dropdown trigger contract failed: ${JSON.stringify(sharedTriggerContract)}`);
    }

    const accessibleLabels = await page.evaluate(() => {
      const labels = {};
      for (const id of ['todo-priority', 'todo-status', 'todo-project', 'todo-section']) {
        const trigger = document.querySelector(`.ui-select[data-select-id="${id}"] .ui-select-trigger`);
        const labelledBy = trigger?.getAttribute('aria-labelledby') || '';
        labels[id] = {
          labelledBy,
          labelText: labelledBy.split(/\s+/).map(labelId => document.getElementById(labelId)?.textContent?.trim()).filter(Boolean).join(' '),
          ariaHiddenNative: document.getElementById(id)?.getAttribute('aria-hidden'),
        };
      }
      return labels;
    });
    for (const [id, info] of Object.entries(accessibleLabels)) {
      if (!info.labelledBy || info.ariaHiddenNative !== 'true') throw new Error(`Missing accessible select labeling for ${id}: ${JSON.stringify(info)}`);
    }
    if (!accessibleLabels['todo-priority'].labelText.match(/Priority|Priorität/i)) throw new Error(`Priority trigger is not label-associated: ${JSON.stringify(accessibleLabels['todo-priority'])}`);
    if (!accessibleLabels['todo-status'].labelText.match(/Status/i)) throw new Error(`Status trigger is not label-associated: ${JSON.stringify(accessibleLabels['todo-status'])}`);
    if (!accessibleLabels['todo-project'].labelText.match(/Project|Projekt/i)) throw new Error(`Project trigger is not label-associated: ${JSON.stringify(accessibleLabels['todo-project'])}`);
    if (!accessibleLabels['todo-section'].labelText.match(/Section/i)) throw new Error(`Section trigger is not label-associated: ${JSON.stringify(accessibleLabels['todo-section'])}`);

    const priority = page.locator('.ui-select[data-select-id="todo-priority"] .ui-select-trigger');
    await priority.scrollIntoViewIfNeeded();
    await priority.click();
    await page.locator('.ui-select-menu').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#todo-title').click();
    await page.locator('.ui-select-menu').waitFor({ state: 'hidden', timeout: 5000 });

    await priority.click();
    await page.locator('.ui-select-menu').waitFor({ state: 'visible', timeout: 5000 });
    const selectedCheckIcon = await page.evaluate(() => {
      const selected = document.querySelector('.ui-select-option[aria-selected="true"] .ui-select-option-check');
      const icon = selected?.querySelector('svg.ui-icon');
      const style = selected ? getComputedStyle(selected) : null;
      const iconRect = icon?.getBoundingClientRect();
      return {
        hasIcon: Boolean(icon),
        text: selected?.textContent?.trim() || '',
        color: style?.color,
        width: iconRect?.width || 0,
        height: iconRect?.height || 0,
      };
    });
    if (!selectedCheckIcon.hasIcon || selectedCheckIcon.text !== '' || selectedCheckIcon.width !== 15 || selectedCheckIcon.height !== 15) {
      throw new Error(`Shared dropdown selected check icon does not match workspace icon style: ${JSON.stringify(selectedCheckIcon)}`);
    }
    await page.locator('.ui-select-option').filter({ hasText: /Sehr hoch|Very high/i }).click();
    const priorityValue = await page.locator('#todo-priority').evaluate((el) => el.value);
    if (priorityValue !== '1') throw new Error(`Priority native value did not sync, got ${priorityValue}`);

    await page.locator('.ui-select[data-select-id="todo-project"] .ui-select-trigger').click();
    await page.locator('.ui-select-menu').waitFor({ state: 'visible', timeout: 5000 });
    const projectDepths = await page.evaluate(() => Array.from(document.querySelectorAll('.ui-select-option')).map(option => ({
      label: option.textContent.trim(),
      depth: Number(option.dataset.depth || '0'),
      paddingLeft: Number.parseFloat(getComputedStyle(option).paddingLeft),
    })).filter(option => option.label.includes('Dropdown')));
    if (!projectDepths.some(option => option.label.includes('Child') && option.depth === 1)) throw new Error(`Child project depth missing: ${JSON.stringify(projectDepths)}`);
    if (!projectDepths.some(option => option.label.includes('Grandchild') && option.depth === 2)) throw new Error(`Grandchild project depth missing: ${JSON.stringify(projectDepths)}`);
    const child = projectDepths.find(option => option.label.includes('Child'));
    const grandchild = projectDepths.find(option => option.label.includes('Grandchild'));
    if (!(grandchild.paddingLeft > child.paddingLeft)) throw new Error(`Project indentation did not increase by depth: ${JSON.stringify(projectDepths)}`);
    await page.keyboard.press('Escape');
    await page.locator('.ui-select-menu').waitFor({ state: 'hidden', timeout: 5000 });

    await page.evaluate(() => window.closeModal?.('todo-modal'));
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await openTodoModal();
    await openOrganizePanel();
    const status = page.locator('.ui-select[data-select-id="todo-status"] .ui-select-trigger');
    await status.focus();
    await page.keyboard.press('Enter');
    await page.locator('.ui-select-menu').waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const statusValue = await page.locator('#todo-status').evaluate((el) => el.value);
    if (statusValue !== 'in_progress') throw new Error(`Keyboard status selection did not sync, got ${statusValue}`);

    await status.click();
    await page.locator('.ui-select-menu').waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.locator('.ui-select-menu').waitFor({ state: 'hidden', timeout: 5000 });

    await page.evaluate(() => window.closeModal?.('todo-modal'));
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.setViewportSize({ width: 390, height: 844 });
    await openTodoModal();
    await openOrganizePanel();
    const projectTrigger = page.locator('.ui-select[data-select-id="todo-project"] .ui-select-trigger');
    await page.evaluate(() => document.querySelector('.ui-select[data-select-id="todo-project"] .ui-select-trigger')?.scrollIntoView({ block: 'center' }));
    await projectTrigger.click();
    await page.locator('.ui-select-menu').waitFor({ state: 'visible', timeout: 5000 });
    const mobileMenuState = await page.evaluate(() => {
      const menu = document.querySelector('.ui-select-menu');
      const trigger = document.querySelector('.ui-select[data-select-id="todo-project"] .ui-select-trigger');
      const rect = menu?.getBoundingClientRect();
      const triggerRect = trigger?.getBoundingClientRect();
      return {
        hasPopoverClass: menu?.classList.contains('is-mobile-popover') || false,
        isSheet: menu?.classList.contains('is-mobile-sheet') || false,
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        height: rect.height,
        triggerBottom: triggerRect.bottom,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        overflow: document.body.scrollWidth > window.innerWidth + 1,
      };
    });
    if (!mobileMenuState.hasPopoverClass || mobileMenuState.isSheet) throw new Error(`Mobile dropdown did not use anchored popover placement: ${JSON.stringify(mobileMenuState)}`);
    if (mobileMenuState.top < 8 || mobileMenuState.bottom > mobileMenuState.viewportHeight - 8) throw new Error(`Mobile popover is not viewport-clamped: ${JSON.stringify(mobileMenuState)}`);
    if (mobileMenuState.left < 8 || mobileMenuState.right > mobileMenuState.viewportWidth - 8) throw new Error(`Mobile popover is not horizontally clamped: ${JSON.stringify(mobileMenuState)}`);
    if (mobileMenuState.height > 290) throw new Error(`Mobile popover is too tall: ${JSON.stringify(mobileMenuState)}`);
    if (Math.abs(mobileMenuState.top - mobileMenuState.triggerBottom) > 80 && mobileMenuState.top > mobileMenuState.triggerBottom) throw new Error(`Mobile popover is not field anchored: ${JSON.stringify(mobileMenuState)}`);
    if (mobileMenuState.overflow) throw new Error('Mobile dropdown caused horizontal overflow');

    const ownScrollHandling = await page.evaluate(() => {
      const menu = document.querySelector('.ui-select-menu');
      const trigger = document.querySelector('.ui-select[data-select-id="todo-project"] .ui-select-trigger');
      if (!menu || !trigger) return { missing: true };
      const originalGetBoundingClientRect = trigger.getBoundingClientRect.bind(trigger);
      let triggerRectReads = 0;
      trigger.getBoundingClientRect = () => {
        triggerRectReads += 1;
        return originalGetBoundingClientRect();
      };
      menu.dispatchEvent(new Event('scroll'));
      const style = getComputedStyle(menu);
      trigger.getBoundingClientRect = originalGetBoundingClientRect;
      return {
        triggerRectReads,
        overscrollBehavior: style.overscrollBehaviorY || style.overscrollBehavior,
        webkitOverflowScrolling: style.webkitOverflowScrolling || '',
        touchAction: style.touchAction,
      };
    });
    if (ownScrollHandling.missing || ownScrollHandling.triggerRectReads !== 0) {
      throw new Error(`Dropdown repositioned while its own menu scrolled: ${JSON.stringify(ownScrollHandling)}`);
    }
    if (ownScrollHandling.overscrollBehavior !== 'contain' || ownScrollHandling.touchAction !== 'pan-y') {
      throw new Error(`Mobile dropdown scroll containment styles missing: ${JSON.stringify(ownScrollHandling)}`);
    }

    assertNoFrontendErrors();
    console.log('✅ Shared UI dropdown primitive test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);

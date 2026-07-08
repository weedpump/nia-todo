#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function run() {
  console.log('🌐 Running Playwright frontend drag-drop test...');
  const { browser, page, loginApp, clickProjectNav, openTodoModal, createSection, ensureSectionOptions, assertNoFrontendErrors } = await launchPage();

  try {
    await loginApp();

    await page.click('button[data-nav-action="new-project"]');
    await page.fill('#project-name', 'Drag Project');
    await page.click('button[form="project-form"]');
    await page.locator('#project-modal').waitFor({ state: 'hidden', timeout: 5000 });

    await clickProjectNav('Drag Project');
    await createSection('Drag A');
    await createSection('Drag B');

    await openTodoModal();
    await page.fill('#todo-title', 'Drag Todo');
    await page.selectOption('#todo-project', { label: 'Drag Project' }, { force: true });
    await ensureSectionOptions(['Drag A', 'Drag B']);
    await page.selectOption('#todo-section', { label: 'Drag A' }, { force: true });
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });

    await page.waitForFunction(() => {
      const containers = Array.from(document.querySelectorAll('.section-todos'));
      const todo = document.querySelector('.todo-item[data-id]');
      return containers.some(el => el.innerText.includes('Drag Todo')) && todo && !String(todo.dataset.id).startsWith('temp-');
    }, { timeout: 10000 });

    const afterCreate = await page.evaluate(() => Array.from(document.querySelectorAll('.section-todos')).map(el => ({
      section: el.previousElementSibling?.textContent?.trim() || 'unknown',
      text: el.innerText,
      sectionId: el.dataset.sectionId,
    })));
    const createdInA = afterCreate.some(entry => entry.section.includes('Drag A') && entry.text.includes('Drag Todo'));
    if (!createdInA) throw new Error(`Drag Todo not created in Drag A: ${JSON.stringify(afterCreate)}`);

    await page.evaluate(() => {
      const todo = document.querySelector('.todo-item[data-id]');
      const target = Array.from(document.querySelectorAll('.section-todos')).find(el => el.previousElementSibling?.textContent?.includes('Drag B'));
      if (!todo || !target) throw new Error('Drag/drop DOM not found');
      const dataTransfer = new DataTransfer();
      todo.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    });

    await page.waitForTimeout(300);
    const afterSectionMove = await page.evaluate(() => Array.from(document.querySelectorAll('.section-todos')).map(el => ({
      section: el.previousElementSibling?.textContent?.trim() || 'unknown',
      text: el.innerText,
      sectionId: el.dataset.sectionId,
    })));
    const movedToB = afterSectionMove.some(entry => entry.section.includes('Drag B') && entry.text.includes('Drag Todo'));
    if (!movedToB) throw new Error(`Drag Todo not moved to Drag B: ${JSON.stringify(afterSectionMove)}`);

    // Keep this focused: one real todo section move is enough to cover the drag/drop contract.
    // Project moves, offline queueing and section reorder are covered by narrower domain/sync tests.
    assertNoFrontendErrors();
    console.log('✅ Frontend drag-drop test passed');
  } finally {
    await page.context().setOffline(false).catch(() => {});
    await browser.close();
  }
}

await withFreshDb(run);

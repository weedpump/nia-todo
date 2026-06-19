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

    await page.click('button[data-nav-action="new-project"]');
    await page.fill('#project-name', 'Drop Target Project');
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

    await page.evaluate(() => {
      const todo = document.querySelector('.todo-item[data-id]');
      const unsorted = Array.from(document.querySelectorAll('.section-todos')).find(el => el.dataset.sectionId === 'null');
      if (!todo || !unsorted) throw new Error('Unsorted drop zone not found');
      const dataTransfer = new DataTransfer();
      todo.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
      unsorted.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
      unsorted.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    });

    await page.waitForTimeout(300);
    const afterUnsortedMove = await page.evaluate(() => Array.from(document.querySelectorAll('.section-todos')).map(el => ({
      section: el.previousElementSibling?.textContent?.trim() || 'unknown',
      text: el.innerText,
      sectionId: el.dataset.sectionId,
    })));
    const movedToUnsorted = afterUnsortedMove.some(entry => (entry.section.includes('Unsortiert') || entry.section.includes('Unsorted')) && entry.text.includes('Drag Todo'));
    if (!movedToUnsorted) throw new Error(`Drag Todo not moved to Unsortiert: ${JSON.stringify(afterUnsortedMove)}`);

    const sectionOrder = await page.evaluate(async () => {
      const headers = Array.from(document.querySelectorAll('.section-header'));
      const dragB = headers.find(el => el.textContent?.includes('Drag B'));
      const firstDropzone = document.querySelector('.section-dropzone[data-drop-index="0"]');
      if (!dragB || !firstDropzone) throw new Error('Section drag/dropzone not found');
      const dataTransfer = new DataTransfer();
      dragB.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
      firstDropzone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
      firstDropzone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      await new Promise(resolve => setTimeout(resolve, 300));
      return Array.from(document.querySelectorAll('.section-header .section-name')).map(el => el.textContent?.trim());
    });

    if (sectionOrder[0] !== 'Drag B' || sectionOrder[1] !== 'Drag A') {
      throw new Error(`Section order not updated via dropzone: ${JSON.stringify(sectionOrder)}`);
    }

    await page.context().setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false, null, { timeout: 5000 });

    await page.evaluate(() => {
      const todo = document.querySelector('.todo-item[data-id]');
      const targetProject = Array.from(document.querySelectorAll('.project-drop-target[data-project-id]'))
        .find(el => el.textContent?.includes('Drop Target Project'));
      if (!todo || !targetProject) throw new Error('Project drop DOM not found');
      const dataTransfer = new DataTransfer();
      todo.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
      targetProject.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
      targetProject.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    });

    await page.waitForTimeout(300);
    await clickProjectNav('Drop Target Project');
    await page.waitForFunction(() => document.body.innerText.includes('Drag Todo'), { timeout: 5000 });
    const projectMoveState = await page.evaluate(() => Array.from(document.querySelectorAll('.section-todos')).map(el => ({
      section: el.previousElementSibling?.textContent?.trim() || 'unknown',
      text: el.innerText,
      sectionId: el.dataset.sectionId,
    })));
    const movedToTargetProjectUnsorted = projectMoveState.some(entry => entry.sectionId === 'null' && entry.text.includes('Drag Todo'));
    if (!movedToTargetProjectUnsorted) throw new Error(`Drag Todo not moved to target project unsorted section: ${JSON.stringify(projectMoveState)}`);

    const queuedProjectMove = await page.evaluate(async () => {
      const queue = await window.dbGetAll('syncQueue');
      return queue.some(item => item.action === 'UPDATE_TODO' && item.data?.changes?.project_id && item.data?.changes?.section_id === null);
    });
    if (!queuedProjectMove) throw new Error('Offline project drop did not enqueue UPDATE_TODO with project_id and section_id=null');

    await page.context().setOffline(false);
    await page.waitForFunction(() => navigator.onLine === true, null, { timeout: 5000 });

    await page.waitForTimeout(300);

    assertNoFrontendErrors();
    console.log('✅ Frontend drag-drop test passed');
  } finally {
    await page.context().setOffline(false).catch(() => {});
    await browser.close();
  }
}

await withFreshDb(run);

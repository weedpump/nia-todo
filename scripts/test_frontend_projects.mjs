#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function chooseUiSelectOption(page, selectId, option) {
  const trigger = page.locator(`.ui-select[data-select-id="${selectId}"] .ui-select-trigger`);
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await page.locator('.ui-select-menu').waitFor({ state: 'visible', timeout: 5000 });
  if (option?.label) {
    await page.locator('.ui-select-option').filter({ hasText: option.label }).first().click();
  } else if (option?.value !== undefined) {
    await page.locator(`.ui-select-option[data-value="${option.value}"]`).first().click();
  } else {
    await page.locator('.ui-select-option').first().click();
  }
  await page.locator('.ui-select-menu').waitFor({ state: 'hidden', timeout: 5000 });
}

async function run() {
  console.log('🌐 Running Playwright frontend projects test...');
  const { browser, page, visible, loginApp, waitForText, assertNoFrontendErrors } = await launchPage();

  try {
    await loginApp();

    await page.click('button[onclick="showProjectModal()"]');
    await visible('#project-modal');
    await page.fill('#project-name', 'Project Parent');
    await page.fill('#project-color', '#123456');
    await page.click('button[form="project-form"]');
    await page.locator('#project-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await waitForText('Project Parent');

    await page.click('button[onclick="showProjectModal()"]');
    await visible('#project-modal');
    await page.fill('#project-name', 'Project Child');
    const childModalSelectState = await page.evaluate(() => {
      const select = document.getElementById('project-parent-id');
      const rect = select?.getBoundingClientRect();
      return {
        hiddenNative: select?.classList.contains('visually-hidden-native-select') && rect && rect.width <= 1,
        hasTrigger: !!document.querySelector('.ui-select[data-select-id="project-parent-id"] .ui-select-trigger'),
      };
    });
    if (!childModalSelectState.hiddenNative || !childModalSelectState.hasTrigger) throw new Error(`Project parent select was not hydrated: ${JSON.stringify(childModalSelectState)}`);
    await chooseUiSelectOption(page, 'project-parent-id', { label: 'Project Parent' });
    await page.click('button[form="project-form"]');
    await page.locator('#project-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction(() => document.body.innerText.includes('Project Child'), { timeout: 10000 });

    await page.locator('.project-tree-item').filter({ hasText: 'Project Parent' }).first().locator('.nav-edit').click();
    await visible('#project-modal');
    const workspaceSelectState = await page.evaluate(() => {
      const select = document.getElementById('project-display-workspace-id');
      const rect = select?.getBoundingClientRect();
      return {
        hiddenNative: select?.classList.contains('visually-hidden-native-select') && rect && rect.width <= 1,
        hasTrigger: !!document.querySelector('.ui-select[data-select-id="project-display-workspace-id"] .ui-select-trigger'),
        groupDisplay: document.getElementById('project-display-workspace-group')?.style.display || '',
      };
    });
    if (!workspaceSelectState.hiddenNative || !workspaceSelectState.hasTrigger) throw new Error(`Project workspace select was not hydrated: ${JSON.stringify(workspaceSelectState)}`);
    await page.fill('#project-name', 'Project Parent Renamed');
    await page.click('button[form="project-form"]');
    await page.locator('#project-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await waitForText('Project Parent Renamed');

    await page.waitForFunction(() => {
      const names = Array.from(document.querySelectorAll('.project-tree-item .nav-btn')).map(el => el.textContent || '');
      return names.some(name => name.includes('Project Child'));
    }, { timeout: 10000 });

    await page.locator('.project-tree-item').filter({ hasText: 'Project Child' }).first().locator('.nav-edit').click();
    await visible('#project-modal');
    await chooseUiSelectOption(page, 'project-parent-id', { value: '' });
    await page.click('button[form="project-form"]');
    await page.locator('#project-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/projects', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      return data.projects.some(project => project.name === 'Project Child' && project.parent_id === null);
    }, null, { timeout: 10000 });

    await page.locator('.project-tree-item').filter({ hasText: 'Project Child' }).first().locator('.nav-edit').click();
    await visible('#project-modal');
    await chooseUiSelectOption(page, 'project-parent-id', { label: 'Project Parent Renamed' });
    await page.click('button[form="project-form"]');
    await page.locator('#project-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction(async () => {
      const jwt = localStorage.getItem('jwt_token');
      const data = await fetch('/api/projects', { headers: { 'Authorization': `Bearer ${jwt}` }, credentials: 'include' }).then(r => r.json());
      const parent = data.projects.find(project => project.name === 'Project Parent Renamed');
      return data.projects.some(project => project.name === 'Project Child' && project.parent_id === parent?.id);
    }, null, { timeout: 10000 });

    await page.evaluate(() => {
      const projects = Array.from(document.querySelectorAll('.project-tree-item .nav-btn'));
      const childBtn = projects.find(el => el.textContent?.includes('Project Child'));
      if (!childBtn) throw new Error('Project Child button not found');
      childBtn.click();
    });
    await page.waitForFunction(() => document.querySelector('.add-section-row') !== null, { timeout: 10000 });

    await page.getByRole('button', { name: /Neues Todo|New todo/i }).click();
    await visible('#todo-modal');
    await page.fill('#todo-title', 'Project Delete Todo');
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction(() => document.body.innerText.includes('Project Delete Todo'), { timeout: 10000 });

    const childRow = page.locator('.project-tree-item').filter({ hasText: 'Project Child' }).first();
    await childRow.locator('.nav-edit').click();
    await visible('#project-modal');
    await page.click('#project-delete-btn');
    await visible('#confirm-modal');
    await page.click('#confirm-confirm-btn');
    await page.waitForFunction(() => !document.body.innerText.includes('Project Child'), { timeout: 10000 });

    await page.locator('.nav-btn[data-filter="all"]').click();
    await page.waitForFunction(() => document.body.innerText.includes('Project Delete Todo'), { timeout: 10000 });

    assertNoFrontendErrors();
    console.log('✅ Frontend projects test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);

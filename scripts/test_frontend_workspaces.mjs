#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function run() {
  console.log('🧭 Running frontend workspaces test...');
  const { browser, page, loginApp, visible, waitForText } = await launchPage();

  async function openWorkspaceMenu() {
    await page.evaluate(() => window.renderWorkspaces?.());
    await page.locator('#workspace-current-btn').click();
    await page.locator('#workspace-menu.open').waitFor({ state: 'visible', timeout: 5000 });
  }

  async function waitForWorkspaceMenuRow(name) {
    await page.waitForFunction((workspaceName) => {
      window.renderWorkspaces?.();
      return [...document.querySelectorAll('#workspace-menu .workspace-menu-row')]
        .some(row => row.textContent?.includes(workspaceName));
    }, name, { timeout: 10000 });
    return page.locator('#workspace-menu .workspace-menu-row').filter({ hasText: name }).first();
  }

  async function chooseWorkspace(name) {
    await openWorkspaceMenu();
    const row = await waitForWorkspaceMenuRow(name);
    await row.locator('.workspace-menu-choice').click();
  }

  async function editWorkspace(name) {
    await openWorkspaceMenu();
    const row = await waitForWorkspaceMenuRow(name);
    await row.locator('.workspace-menu-edit').click();
  }

  try {
    await page.addInitScript(() => localStorage.setItem('nia-todo-language', 'de'));
    await loginApp();
    await visible('#workspace-current-btn');
    await waitForText('Inbox');
    await page.waitForFunction(() => document.querySelector('#workspace-current-name')?.textContent === 'Personal', null, { timeout: 10000 });

    await openWorkspaceMenu();
    await page.locator('.workspace-menu-add').click();
    await page.locator('#workspace-modal').waitFor({ state: 'visible', timeout: 5000 });
    await page.fill('#workspace-name', 'Beruflich');
    await page.locator('#workspace-modal .btn-primary').click();
    await page.locator('#workspace-modal').waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('#workspace-current-name')?.textContent === 'Beruflich', null, { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('#count-all')?.textContent === '0', null, { timeout: 10000 });

    await page.getByRole('button', { name: /Projekt hinzufügen/ }).click();
    await page.locator('#project-modal').waitFor({ state: 'visible', timeout: 5000 });
    await page.fill('#project-name', 'Beruf Projekt');
    await page.click('button[form="project-form"]');
    await page.locator('#project-modal').waitFor({ state: 'hidden', timeout: 10000 });
    await waitForText('Beruf Projekt');

    await chooseWorkspace('Personal');
    await page.waitForFunction(() => !document.body.innerText.includes('Beruf Projekt'), null, { timeout: 10000 });

    await page.getByRole('button', { name: /Projekt hinzufügen/ }).click();
    await page.locator('#project-modal').waitFor({ state: 'visible', timeout: 5000 });
    await page.fill('#project-name', 'Beruf Projekt');
    await page.click('button[form="project-form"]');
    await page.locator('#project-modal').waitFor({ state: 'hidden', timeout: 10000 });
    await waitForText('Beruf Projekt');

    await chooseWorkspace('Beruflich');
    await waitForText('Beruf Projekt');

    await editWorkspace('Beruflich');
    await page.locator('#workspace-modal').waitFor({ state: 'visible', timeout: 5000 });
    await page.fill('#workspace-name', 'Arbeit');
    await page.locator('#workspace-modal .btn-primary').click();
    await page.locator('#workspace-modal').waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('#workspace-current-name')?.textContent === 'Arbeit', null, { timeout: 10000 });

    await page.getByRole('button', { name: /Projekt hinzufügen/ }).click();
    await page.locator('#project-modal').waitFor({ state: 'visible', timeout: 5000 });
    await page.fill('#project-name', 'Delete Workspace Project');
    await page.click('button[form="project-form"]');
    await page.locator('#project-modal').waitFor({ state: 'hidden', timeout: 10000 });
    await waitForText('Delete Workspace Project');
    await page.locator('.project-tree-item').filter({ hasText: 'Delete Workspace Project' }).locator('.nav-btn').click();
    await page.getByRole('button', { name: /Neues Todo|New todo/i }).click();
    await visible('#todo-modal');
    await page.fill('#todo-title', 'Stays In Workspace Inbox');
    await page.click('button[form="todo-form"]');
    await page.locator('#todo-modal').waitFor({ state: 'hidden', timeout: 5000 });
    await waitForText('Stays In Workspace Inbox');
    await page.locator('.project-tree-item').filter({ hasText: 'Delete Workspace Project' }).locator('.nav-edit').click();
    await visible('#project-modal');
    await page.click('#project-delete-btn');
    await visible('#confirm-modal');
    await page.click('#confirm-confirm-btn');
    await page.waitForFunction(() => !document.body.innerText.includes('Delete Workspace Project'), null, { timeout: 10000 });
    await page.locator('.nav-btn[data-filter="all"]').click();
    await waitForText('Stays In Workspace Inbox');

    await editWorkspace('Arbeit');
    await page.locator('#workspace-modal').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#workspace-delete-btn').click();
    await visible('#confirm-modal');
    await page.click('#confirm-confirm-btn');
    await page.locator('#workspace-modal').waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('#workspace-current-name')?.textContent === 'Personal', null, { timeout: 10000 });
    await page.locator('.nav-btn[data-filter="all"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.nav-btn').length >= 2 && document.body.innerText.includes('Beruf Projekt'), null, { timeout: 20000 });

    console.log('✅ Frontend workspaces test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);

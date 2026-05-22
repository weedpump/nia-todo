#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function run() {
  console.log('🧭 Running frontend workspaces test...');
  const { browser, page, loginApp, visible, waitForText } = await launchPage();

  try {
    await loginApp();
    await visible('#workspace-current-btn');
    await waitForText('Inbox');

    const initialName = await page.locator('#workspace-current-name').textContent();
    if (initialName !== 'Privat') throw new Error('Default workspace missing');

    await page.locator('#workspace-current-btn').click();
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

    await page.locator('#workspace-current-btn').click();
    await page.locator('.workspace-menu-choice').filter({ hasText: 'Privat' }).click();
    await page.waitForFunction(() => !document.body.innerText.includes('Beruf Projekt'), null, { timeout: 10000 });

    await page.getByRole('button', { name: /Projekt hinzufügen/ }).click();
    await page.locator('#project-modal').waitFor({ state: 'visible', timeout: 5000 });
    await page.fill('#project-name', 'Beruf Projekt');
    await page.click('button[form="project-form"]');
    await page.locator('#project-modal').waitFor({ state: 'hidden', timeout: 10000 });

    await page.locator('#workspace-current-btn').click();
    await page.locator('.workspace-menu-choice').filter({ hasText: 'Beruflich' }).click();
    await waitForText('Beruf Projekt');

    await page.locator('#workspace-current-btn').click();
    await page.locator('.workspace-menu-row').filter({ hasText: 'Beruflich' }).locator('.workspace-menu-edit').click();
    await page.locator('#workspace-modal').waitFor({ state: 'visible', timeout: 5000 });
    await page.fill('#workspace-name', 'Arbeit');
    await page.locator('#workspace-modal .btn-primary').click();
    await page.locator('#workspace-modal').waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('#workspace-current-name')?.textContent === 'Arbeit', null, { timeout: 10000 });

    await page.locator('#workspace-current-btn').click();
    await page.locator('.workspace-menu-row').filter({ hasText: 'Arbeit' }).locator('.workspace-menu-edit').click();
    await page.locator('#workspace-modal').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#workspace-delete-btn').click();
    await page.locator('#workspace-modal').waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('#workspace-current-name')?.textContent === 'Privat', null, { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('.nav-btn').length >= 2 && document.body.innerText.includes('Beruf Projekt'), null, { timeout: 10000 });

    console.log('✅ Frontend workspaces test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);

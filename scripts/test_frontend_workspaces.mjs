#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function run() {
  console.log('🧭 Running frontend workspaces test...');
  const { browser, page, loginApp, visible, waitForText } = await launchPage();

  try {
    await page.addInitScript(() => { window.prompt = () => 'Beruflich'; });
    await loginApp();
    await visible('#workspace-select');
    await waitForText('Inbox');

    const initial = await page.locator('#workspace-select option').allTextContents();
    if (!initial.includes('Privat')) throw new Error('Default workspace missing');

    await page.locator('.workspace-add-btn').click();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('#workspace-select option')).some(option => option.textContent === 'Beruflich'),
      null,
      { timeout: 10000 }
    );

    await page.selectOption('#workspace-select', { label: 'Beruflich' });
    await page.waitForFunction(() => document.querySelector('#count-all')?.textContent === '0', null, { timeout: 10000 });

    await page.getByRole('button', { name: /Projekt hinzufügen/ }).click();
    await page.locator('#project-modal').waitFor({ state: 'visible', timeout: 5000 });
    await page.fill('#project-name', 'Beruf Projekt');
    await page.click('button[form="project-form"]');
    await page.locator('#project-modal').waitFor({ state: 'hidden', timeout: 10000 });
    await waitForText('Beruf Projekt');

    await page.selectOption('#workspace-select', { label: 'Privat' });
    await page.waitForFunction(() => !document.body.innerText.includes('Beruf Projekt'), null, { timeout: 10000 });

    await page.selectOption('#workspace-select', { label: 'Beruflich' });
    await waitForText('Beruf Projekt');

    console.log('✅ Frontend workspaces test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);

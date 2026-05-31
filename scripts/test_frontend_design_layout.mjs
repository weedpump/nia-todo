#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

function assertCloseEnough(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected}±${tolerance}, got ${actual}`);
  }
}

async function run() {
  console.log('🎛️ Running design layout consistency test...');
  const { browser, page, loginApp, assertNoFrontendErrors } = await launchPage();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginApp();

    await page.locator('.fab-add-todo').waitFor({ state: 'visible', timeout: 5000 });
    const fabLayers = await page.evaluate(() => {
      if (!document.querySelector('#braindump-fab')) {
        const mic = document.createElement('button');
        mic.id = 'braindump-fab';
        mic.className = 'braindump-fab';
        mic.type = 'button';
        mic.textContent = 'mic';
        document.body.appendChild(mic);
      }
      const add = document.querySelector('.fab-add-todo');
      const mic = document.querySelector('#braindump-fab');
      const sidebar = document.querySelector('#sidebar');
      const overlay = document.querySelector('#sidebar-overlay');
      const z = (el) => Number.parseInt(getComputedStyle(el).zIndex, 10);
      return { add: z(add), mic: z(mic), sidebar: z(sidebar), overlay: z(overlay) };
    });
    if (fabLayers.add !== fabLayers.mic) {
      throw new Error(`FAB z-index mismatch: ${JSON.stringify(fabLayers)}`);
    }
    if (!(fabLayers.add < fabLayers.overlay && fabLayers.mic < fabLayers.overlay && fabLayers.overlay < fabLayers.sidebar)) {
      throw new Error(`Sidebar layering contract broken: ${JSON.stringify(fabLayers)}`);
    }

    await page.evaluate(() => window.showProjectModal?.());
    await page.locator('#project-modal.active').waitFor({ state: 'visible', timeout: 5000 });
    const projectCardGap = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#project-form > .ui-section-card'));
      if (cards.length < 2) return null;
      const first = cards[0].getBoundingClientRect();
      const second = cards[1].getBoundingClientRect();
      return second.top - first.bottom;
    });
    if (projectCardGap == null) throw new Error('Project modal cards not found');
    assertCloseEnough(projectCardGap, 14, 0.5, 'Project modal card gap');

    assertNoFrontendErrors();
    console.log('✅ Design layout consistency test passed');
  } finally {
    await browser.close();
  }
}

await withFreshDb(run);

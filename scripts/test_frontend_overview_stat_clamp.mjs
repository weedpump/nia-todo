#!/usr/bin/env node
import { withFreshDb, launchPage } from './frontend_test_lib.mjs';

async function main() {
  console.log('📐 Running overview stat clamp test...');
  await withFreshDb(async () => {
    const { browser, page, loginApp, assertNoFrontendErrors } = await launchPage();
    try {
      await page.setViewportSize({ width: 834, height: 1112 });
      await loginApp();
      await page.evaluate(() => {
        const grid = document.createElement('div');
        grid.className = 'overview-stat-grid';
        grid.style.width = '462px';
        grid.innerHTML = `
          <div class="overview-stat-card due">
            <div class="overview-stat-num">1</div>
            <div>
              <div class="overview-stat-label">Überfällig</div>
              <div class="overview-stat-hint">Brauchen Aufmerksamkeit</div>
            </div>
          </div>
        `;
        document.body.appendChild(grid);
      });
      const metrics = await page.evaluate(() => {
        const card = document.querySelector('.overview-stat-grid .overview-stat-card');
        const label = card?.querySelector('.overview-stat-label');
        const hint = card?.querySelector('.overview-stat-hint');
        const textWrap = card?.querySelector('.overview-stat-card > div:last-child');
        const read = (el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return {
            left: rect.left,
            right: rect.right,
            width: rect.width,
            scrollWidth: el.scrollWidth,
            overflow: style.overflow,
            textOverflow: style.textOverflow,
            whiteSpace: style.whiteSpace,
            minWidth: style.minWidth,
          };
        };
        return {
          card: read(card),
          label: read(label),
          hint: read(hint),
          textWrap: read(textWrap),
        };
      });
      const epsilon = 1;
      if (metrics.label.right > metrics.card.right + epsilon || metrics.hint.right > metrics.card.right + epsilon) {
        throw new Error(`Overview stat text overflows card bounds: ${JSON.stringify(metrics)}`);
      }
      for (const [name, item] of Object.entries({ label: metrics.label, hint: metrics.hint })) {
        if (item.overflow !== 'hidden' || item.textOverflow !== 'ellipsis' || item.whiteSpace !== 'nowrap') {
          throw new Error(`${name} should be ellipsized in constrained stat cards: ${JSON.stringify(metrics)}`);
        }
      }
      if (metrics.textWrap.minWidth !== '0px') {
        throw new Error(`Overview stat text wrapper should be allowed to shrink: ${JSON.stringify(metrics)}`);
      }
      assertNoFrontendErrors();
      console.log('✅ Overview stat clamp test passed');
    } finally {
      await browser.close();
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

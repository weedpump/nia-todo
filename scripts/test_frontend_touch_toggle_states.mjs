#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const focusCss = readFileSync(new URL('../web/static/css/64-focus-controls.css', import.meta.url), 'utf8');
const mobileCss = readFileSync(new URL('../web/static/css/40-responsive-mobile.css', import.meta.url), 'utf8');

console.log('👆 Running touch toggle state regression test...');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

try {
  await page.setContent(`
    <style>
      :root {
        --accent: rgb(80, 110, 255);
        --accent-rgb: 80, 110, 255;
        --accent-intensity: 1;
        --bg-secondary: rgb(20, 30, 40);
        --text-secondary: rgb(150, 160, 170);
        --border: rgb(60, 70, 80);
      }
      ${focusCss}
      ${mobileCss}
    </style>
    <button type="button" class="today-focus-btn" id="today-focus-btn"><span>Fokus</span></button>
    <button type="button" class="minimal-todos-btn" id="minimal-todos-btn"><span>Minimal</span></button>
    <div class="search-box" id="search-box">
      <button type="button" class="btn btn-secondary btn-icon search-toggle-btn" id="search-toggle-btn">Suche</button>
      <input id="search-input">
    </div>
    <script>
      document.querySelector('#today-focus-btn').addEventListener('click', event => event.currentTarget.classList.toggle('active'));
      document.querySelector('#minimal-todos-btn').addEventListener('click', event => event.currentTarget.classList.toggle('active'));
      document.querySelector('#search-toggle-btn').addEventListener('click', () => document.querySelector('#search-box').classList.toggle('open'));
    </script>
  `);

  const inspectState = () => page.evaluate(() => {
    const inspect = selector => {
      const element = document.querySelector(selector);
      const style = getComputedStyle(element);
      return {
        active: element.classList.contains('active'),
        color: style.color,
        backgroundColor: style.backgroundColor,
      };
    };
    return {
      focus: inspect('#today-focus-btn'),
      minimal: inspect('#minimal-todos-btn'),
      search: inspect('#search-toggle-btn'),
      searchOpen: document.querySelector('#search-box').classList.contains('open'),
    };
  });

  const baseline = await inspectState();
  for (const selector of ['#today-focus-btn', '#minimal-todos-btn', '#search-toggle-btn']) {
    await page.locator(selector).tap();
    await page.locator(selector).tap();
  }

  const state = await inspectState();

  assert.equal(state.focus.active, false);
  assert.equal(state.minimal.active, false);
  assert.equal(state.searchOpen, false);
  for (const [name, value] of Object.entries({ focus: state.focus, minimal: state.minimal, search: state.search })) {
    assert.equal(value.color, baseline[name].color, `${name} must return to its inactive color after a second touch`);
    assert.equal(value.backgroundColor, baseline[name].backgroundColor, `${name} must return to its inactive background after a second touch`);
  }

  console.log('✅ Touch toggles return to their inactive visual state');
} finally {
  await browser.close();
}

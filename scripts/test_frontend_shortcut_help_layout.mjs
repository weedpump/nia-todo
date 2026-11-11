#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

// Actual modal/module markup and styles, served at a private intercepted origin.
// No application boot, API, database, or development service is involved.
const source = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const modal = source.slice(source.indexOf('    <div class="modal ui-detail-modal ui-detail-view shortcuts-modal"'), source.indexOf('    <div class="modal app-downloads-modal"'));
assert.ok(modal.includes('id="module-shortcuts-slot"'));
const fixture = `
import { TASK_SHORTCUTS_HTML } from '/static/js/modules/tasks-shortcuts.js';
import { createShortcutHelpFeature } from '/static/js/features/shortcut-help.js';
import { initI18n,setLanguagePreference } from '/static/js/i18n/index.js';
import { hydrateIcons } from '/static/js/icons/lucide-icons.js';
localStorage.setItem('nia-todo-language','de');await initI18n();
const slot=document.getElementById('module-shortcuts-slot');
slot.innerHTML='<div class="module-slot-panel module-slot-panel-shortcuts" data-module-panel="tasks" data-module-slot="shortcuts">'+TASK_SHORTCUTS_HTML+'</div><div class="module-slot-panel module-slot-panel-shortcuts" data-module-panel="shopping" data-module-slot="shortcuts" hidden></div>';
hydrateIcons(document);
const help=createShortcutHelpFeature();help.bindShortcutHelpActions();
window.test={open:()=>help.openShortcutHelpModal({returnFocusTo:document.getElementById('opener')}),language:setLanguagePreference,
 tasks:enabled=>{slot.querySelector('[data-module-panel="tasks"]').hidden=!enabled;}};
`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];page.on('pageerror', error => errors.push(error.message));
  await page.route('http://shortcut-layout.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/static/style.css"></head><body><button id="opener">Open</button><div id="login-overlay" class="hidden"></div>${modal}<script type="module" src="/fixture.js"></script></body></html>` });
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: fixture });
    if (path.startsWith('/static/')) {
      try { return route.fulfill({ contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.json') ? 'application/json' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream', body: readFileSync(new URL(`../web${path}`, import.meta.url)) }); }
      catch { return route.fulfill({ status: 404 }); }
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('http://shortcut-layout.test/');await page.waitForFunction(() => Boolean(window.test));
  await page.evaluate(() => window.test.open());
  for (const width of [1440,1024,901,768,390,320]) {
    await page.setViewportSize({ width, height: 1000 });
    const bounds = await page.evaluate(() => {
      const measure=selector=>{const node=document.querySelector(selector),r=node.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth};};
      return {viewport:innerWidth,body:document.documentElement.scrollWidth,modal:measure('.shortcuts-modal-content'),shell:measure('.shortcuts-shell'),tasks:measure('[aria-labelledby="shortcuts-tasks-title"]'),editor:measure('[aria-labelledby="shortcuts-editor-title"]'),
        rows:[...document.querySelectorAll('.shortcuts-row')].map(node=>{const r=node.getBoundingClientRect();return{width:r.width,overflow:node.scrollWidth>node.clientWidth};}),
        headings:[...document.querySelectorAll('.shortcuts-section h4')].map(node=>node.textContent)};
    });
    assert.ok(bounds.body <= width, `body fits at ${width}px: ${JSON.stringify(bounds)}`);
    assert.ok(bounds.modal.left >= -1 && bounds.modal.right <= width+1, `modal fits at ${width}px`);
    assert.ok(bounds.modal.scrollWidth <= bounds.modal.clientWidth && bounds.shell.scrollWidth <= bounds.shell.clientWidth, `modal contents do not overflow at ${width}px`);
    assert.ok(bounds.rows.every(row=>!row.overflow), `all shortcut combinations remain within cards at ${width}px`);
    assert.equal(bounds.headings.length,4);
    if (width >= 901) {
      assert.ok(bounds.tasks.width >= bounds.shell.width*.95, `Tasks section fills desktop grid instead of the narrow module wrapper at ${width}px: ${JSON.stringify(bounds)}`);
      assert.ok(bounds.editor.width >= bounds.shell.width*.6, `editor shortcuts use the wider desktop column at ${width}px`);
      assert.ok(bounds.rows.slice(0,6).every(row=>row.width>=200), `general and Tasks cards retain readable widths at ${width}px`);
      assert.ok(bounds.modal.height <= 968, 'desktop modal keeps a viewport margin while its body scrolls');
    } else {
      assert.ok(Math.abs(bounds.tasks.width-bounds.shell.width)<=1, 'mobile retains full-width stacked sections');
    }
    if (width===1440 || width===390) await page.screenshot({path:`/tmp/nia-shortcut-layout-${width}.png`});
  }
  await page.setViewportSize({ width:1440,height:1000 });
  await page.evaluate(() => window.test.tasks(false));
  assert.equal(await page.locator('.shortcuts-section:visible').count(),1,'hidden module sections never appear through display:contents');
  const generalWidth=await page.locator('[aria-labelledby="shortcuts-general-title"]').evaluate(node=>node.getBoundingClientRect().width);
  assert.equal(generalWidth,await page.locator('.shortcuts-shell').evaluate(node=>node.getBoundingClientRect().width),'shared-only help fills the shell');
  assert.ok(await page.locator('.shortcuts-modal-content').evaluate(node=>node.getBoundingClientRect().height)<500,'shared-only help shrinks to content instead of retaining empty desktop rows');
  await page.evaluate(() => window.test.tasks(true));
  await page.evaluate(() => window.test.language('fr'));
  assert.equal(await page.locator('.shortcuts-row').evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth)),true,'translated combinations remain within their cards');
  await page.locator('#shortcuts-modal .modal-close-x').focus();await page.keyboard.press('Tab');
  assert.equal(await page.locator('#shortcuts-modal .modal-close-x').evaluate(node=>node===document.activeElement),true,'existing modal focus trap is preserved');
  await page.keyboard.press('Escape');await page.locator('#shortcuts-modal').waitFor({state:'hidden'});
  assert.equal(await page.locator('#opener').evaluate(node=>node===document.activeElement),true,'close restores invoking focus');
  assert.deepEqual(errors,[]);
  console.log('PASS shortcut help desktop/module grid, mobile bounds, translations and focus');
} finally { await browser.close(); }

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const html = await readFile(join(root, 'web/index.html'), 'utf8');
const taskShortcuts = await readFile(join(root, 'web/static/js/modules/tasks-shortcuts.js'), 'utf8');
const app = await readFile(join(root, 'web/static/js/app.js'), 'utf8');
const userMenu = await readFile(join(root, 'web/static/js/features/user-menu.js'), 'utf8');
const about = await readFile(join(root, 'web/static/js/features/about.js'), 'utf8');
const uiShell = await readFile(join(root, 'web/static/js/features/ui-shell.js'), 'utf8');
const shortcutCss = await readFile(join(root, 'web/static/css/55-shortcuts.css'), 'utf8');
const sw = await readFile(join(root, 'web/sw.js'), 'utf8');
const styleManifest = await readFile(join(root, 'web/static/style.css'), 'utf8');

assert.match(html, /data-user-menu-action="shortcuts"[^>]*role="menuitem"/);
assert.match(html, /class="[^"]*shortcut-help-menu-item[^"]*"[^>]*data-user-menu-action="shortcuts"/);
assert.match(html, /class="modal ui-detail-modal ui-detail-view shortcuts-modal" id="shortcuts-modal"/);
assert.match(html, /id="shortcuts-modal"[^>]*aria-labelledby="shortcuts-modal-title"/);
assert.match(html, /id="shortcuts-modal-title"[^>]*data-i18n-key="shortcuts.title"/);
assert.match(html, /class="modal-content ui-detail-modal-content shortcuts-modal-content"/);
assert.match(html, /class="ui-detail-modal-header"/);
assert.match(html, /class="modal-body ui-detail-modal-body"/);
assert.match(html, /class="shortcuts-shell ui-detail-shell"/);
assert.match(html, /data-i18n-key="shortcuts\.section\.general"/);
assert.doesNotMatch(html, /data-i18n-key="shortcuts\.section\.todoList"/);
assert.doesNotMatch(html, /data-i18n-key="shortcuts\.section\.editor"/);
assert.match(html, /id="module-shortcuts-slot"/);
assert.match(taskShortcuts, /data-i18n-key="shortcuts\.section\.todoList"/);
assert.match(taskShortcuts, /data-i18n-key="shortcuts\.section\.editor"/);
assert.match(html, /<kbd[^>]*>\?<\/kbd>/);
assert.doesNotMatch(html, /<kbd[^>]*>N<\/kbd>/);
assert.doesNotMatch(html, /<kbd[^>]*>T<\/kbd>/);
assert.doesNotMatch(html, /<kbd[^>]*>C<\/kbd>/);
assert.match(taskShortcuts, /<kbd[^>]*>N<\/kbd>/);
assert.match(taskShortcuts, /<kbd[^>]*>T<\/kbd>/);
assert.match(taskShortcuts, /<kbd[^>]*>C<\/kbd>/);
assert.match(html, /<kbd[^>]*>Alt<\/kbd>/);
assert.match(html, /<kbd[^>]*>1–6<\/kbd>/);
assert.match(taskShortcuts, /<kbd[^>]*>Space<\/kbd>/);
assert.match(taskShortcuts, /<kbd[^>]*>Delete<\/kbd>/);
assert.match(taskShortcuts, /<kbd[^>]*>Ctrl<\/kbd>/);
assert.match(taskShortcuts, /<kbd[^>]*>⌘<\/kbd>/);
assert.match(taskShortcuts, /<kbd[^>]*>Enter<\/kbd>/);
assert.match(taskShortcuts, /<kbd[^>]*>Backspace<\/kbd>/);
assert.match(html, /<kbd[^>]*>Esc<\/kbd>/);
assert.doesNotMatch(html, /<span aria-hidden="true">\+<\/span>/);
assert.match(taskShortcuts, /class="visually-hidden" data-i18n-key="shortcuts\.or"/);

assert.match(app, /createShortcutHelpFeature/);
assert.match(app, /openShortcutHelpModal:\s*options\s*=>\s*shortcutHelpFeature\.openShortcutHelpModal\(options\)/);
assert.match(app, /shortcutHelpFeature\.bindShortcutHelpActions\(\)/);
const mobileSearch = await readFile(join(root, 'web/static/js/features/mobile-search.js'), 'utf8');
assert.match(mobileSearch, /key !== 't' && key !== 'c'/);
assert.match(mobileSearch, /key === 't'/);
assert.doesNotMatch(mobileSearch, /key !== 'f'|key !== 'm'|key === 'f'|key === 'm'/);
assert.match(uiShell, /!document\.querySelector\('\.modal\.active, \.ui-menu\.active'\)/);
assert.match(uiShell, /login-overlay/);
assert.match(await readFile(join(root, 'web/static/js/features/shortcut-help.js'), 'utf8'), /event\.key !== '\?'/);
assert.doesNotMatch(about, /event\.key !== '\?'/);
assert.doesNotMatch(about, /openAboutModal\(\{ returnFocusTo: document\.activeElement \}\)/);
assert.match(userMenu, /openShortcutHelpModal = null/);
assert.match(userMenu, /action === 'shortcuts'/);
assert.match(userMenu, /openFromUserMenu\('shortcuts-modal'/);
assert.match(sw, /['"]\/static\/js\/features\/shortcut-help\.js['"]/);
assert.match(sw, /['"]\/static\/css\/55-shortcuts\.css['"]/);
assert.match(styleManifest, /@import url\("\/static\/css\/55-shortcuts\.css"\);/);
assert.match(shortcutCss, /\.shortcuts-keys[\s\S]*background: color-mix/);
assert.match(shortcutCss, /\.shortcuts-keys kbd[\s\S]*box-shadow: none/);
assert.match(shortcutCss, /#shortcuts-modal \.ui-detail-modal-body[\s\S]*overflow-y: auto/);
assert.match(shortcutCss, /@media \(max-width: 768px\)[\s\S]*html:not\(\.native-app\) \.shortcut-help-menu-item/);
assert.match(shortcutCss, /@media \(max-width: 768px\)[\s\S]*html\.native-android \.shortcut-help-menu-item[\s\S]*display: none/);

const requiredKeys = [
  'menu.shortcuts',
  'shortcuts.title',
  'shortcuts.subtitle',
  'shortcuts.section.general',
  'shortcuts.section.todoList',
  'shortcuts.section.editor',
  'shortcuts.openHelp',
  'shortcuts.or',
  'shortcuts.newTodo',
  'shortcuts.todayView',
  'shortcuts.calmView',
  'shortcuts.switchWorkspace',
  'shortcuts.cycleStatus',
  'shortcuts.deleteTodo',
  'shortcuts.saveTodo',
  'shortcuts.multiAddNext',
  'shortcuts.multiAddRemove',
  'shortcuts.multiAddSave',
  'shortcuts.closeDialog',
];
const localeDir = join(root, 'web/static/i18n');
const localeFiles = (await readdir(localeDir)).filter(name => name.endsWith('.json'));
assert.equal(localeFiles.length, 12);
for (const file of localeFiles) {
  const locale = JSON.parse(await readFile(join(localeDir, file), 'utf8'));
  for (const key of requiredKeys) {
    assert.equal(typeof locale[key], 'string', `${file} is missing ${key}`);
    assert.ok(locale[key].trim(), `${file} has an empty ${key}`);
  }
}

console.log('✓ Shortcut help modal follows the shared modal/menu/i18n contracts');

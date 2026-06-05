#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../web/static/style.css', import.meta.url), 'utf8');
const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
const preferences = await readFile(new URL('../web/static/js/features/view-preferences.js', import.meta.url), 'utf8');

assert(html.includes('id="minimal-todos-btn"'), 'top bar must expose the minimal todos toggle');
assert(preferences.includes("classList.toggle('is-minimal-todos', active)"), 'minimal toggle must drive the body class');
assert(css.includes('body.is-minimal-todos .todo-badges,\nbody.is-minimal-todos .todo-meta-row,\nbody.is-minimal-todos .todo-desc-preview {\n  display: none !important;\n}'), 'minimal mode must hide badges, meta pills, and descriptions');
assert(css.includes('body.is-minimal-todos .todo-title') && css.includes('white-space: nowrap'), 'minimal mode must keep todo titles on one line');
assert(!css.includes('body.is-minimal-todos .todo-meta-chip.todo-location {'), 'minimal mode must not restyle location pills instead of hiding the meta row');
assert(!css.includes('\n.todo-desc-preview {\n  display: none !important;\n}'), 'description hiding must be scoped to minimal mode only');
assert(css.includes('.todo-body .todo-desc-preview'), 'normal todo description preview styling must stay scoped to todo cards');

console.log('✅ Frontend minimal todo mode test passed');

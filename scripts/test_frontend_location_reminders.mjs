#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
const todos = await readFile(new URL('../web/static/js/features/todos.js', import.meta.url), 'utf8');
const sync = await readFile(new URL('../web/static/js/features/sync.js', import.meta.url), 'utf8');
const apiIndex = await readFile(new URL('../web/static/js/api/index.js', import.meta.url), 'utf8');

assert(html.includes('todo-location-enabled'), 'todo modal must expose location reminder toggle');
assert(html.includes('todo-location-latitude'), 'todo modal must capture latitude');
assert(html.includes('todo-location-longitude'), 'todo modal must capture longitude');
assert(html.includes('Web/PWA kann sie nur verwalten'), 'todo modal must clearly communicate Android-only triggering');
assert(todos.includes('locationReminderFromForm'), 'todo feature must serialize location reminders');
assert(todos.includes('populateLocationReminderForm'), 'todo feature must populate existing location reminders');
assert(todos.includes('todoData.location_reminder'), 'todo save payload must include location_reminder');
assert(sync.includes("'location_reminder'"), 'offline sync must allow location_reminder changes');
assert(apiIndex.includes('placesApi'), 'API index must export saved places API');

console.log('✅ Frontend location reminder tests passed');

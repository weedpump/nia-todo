#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
const todos = await readFile(new URL('../web/static/js/features/todos.js', import.meta.url), 'utf8');
const sync = await readFile(new URL('../web/static/js/features/sync.js', import.meta.url), 'utf8');
const apiIndex = await readFile(new URL('../web/static/js/api/index.js', import.meta.url), 'utf8');
const desktop = await readFile(new URL('../web/static/js/features/desktop-integration.js', import.meta.url), 'utf8');
const rendering = await readFile(new URL('../web/static/js/features/todo-rendering.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../web/static/style.css', import.meta.url), 'utf8');
const de = await readFile(new URL('../web/static/i18n/de.json', import.meta.url), 'utf8');
const en = await readFile(new URL('../web/static/i18n/en.json', import.meta.url), 'utf8');

assert(html.includes('todo-location-enabled'), 'todo modal must expose location reminder toggle');
assert(!html.includes('todo-location-latitude'), 'todo modal must not expose latitude to humans');
assert(!html.includes('todo-location-longitude'), 'todo modal must not expose longitude to humans');
assert(!html.includes('todo-location-radius'), 'todo modal must not expose radius to humans');
assert(html.includes('todo-location-place'), 'todo modal must allow selecting a saved place');
assert(html.includes('settings-section-places'), 'settings must expose saved places');
assert(html.includes('data-i18n-key="settings.places.title"'), 'places settings must use semantic i18n keys');
assert(html.includes('data-i18n-key="todo.location.hint"'), 'todo modal must clearly communicate Android-only triggering via i18n');
assert(todos.includes('locationReminderFromForm'), 'todo feature must serialize location reminders');
assert(todos.includes('populateLocationReminderForm'), 'todo feature must populate existing location reminders');
assert(todos.includes('todoData.location_reminder'), 'todo save payload must include location_reminder');
assert(todos.includes('selectedPlace?.address') && todos.includes('payload.address = String(selectedPlace.address)'), 'saved-place location reminders must keep address in the local payload for native scheduling before server refresh');
assert(!todos.includes('todo-location-latitude'), 'todo JS must not read latitude inputs');
assert(!todos.includes('todo-location-radius'), 'todo JS must not read radius inputs');
assert(sync.includes("'location_reminder'"), 'offline sync must allow location_reminder changes');
assert(apiIndex.includes('placesApi'), 'API index must export saved places API');
assert(desktop.includes("t('todo.location.notificationTitle')"), 'location notification title must use i18n');
assert(desktop.includes('const address = String(locationReminder.address ||'), 'native location schedules must use addresses, not server coordinates');
assert(!/locationReminder\.(latitude|longitude)/.test(desktop), 'frontend native schedules must not depend on server coordinates');
assert(!desktop.includes('radiusM'), 'frontend native location schedules must be address-only; radius is Android-internal');
assert(desktop.includes('if (locationReminders.length)') && desktop.indexOf('ensureNativeLocationPermission(true)') > desktop.indexOf('if (locationReminders.length)'), 'Android location permission must only be requested when at least one location reminder exists');
assert(desktop.indexOf('scheduleLocationReminders?.(locationReminders)') < desktop.indexOf('ensureNativeLocationPermission(true)'), 'Android location schedules must be stored before requesting permission');
assert(de.includes('todo.location.notificationTitle') && en.includes('todo.location.notificationTitle'), 'location notification title must be translated');
assert(rendering.includes('todo-meta-chip todo-location') && rendering.includes("iconSvg('map-pin')"), 'todo cards must render a location reminder pill');
assert(rendering.includes('locationReminderLabel'), 'todo cards must derive a location reminder label');
assert(css.includes('.todo-meta-chip.todo-location'), 'location reminder pill must have dedicated styling');
assert(de.includes('todo.location.arrivalShort') && en.includes('todo.location.departureShort'), 'location reminder pill labels must be translated');
assert(de.includes('Funktioniert nur in der Android-App') && en.includes('Only works in the Android app'), 'Web UI must clearly communicate Android-only location reminder triggering');

console.log('✅ Frontend location reminder tests passed');


import assert from 'node:assert/strict';
import fs from 'node:fs';
import { formatDate, parseDateValue } from '../web/static/js/core/utils.js';

const expected = { year: 2026, month: 9, day: 7 };

const dateOnly = parseDateValue('2026-10-07', { dateOnlyEndOfDay: true });
assert.equal(dateOnly.dateOnly, true, 'YYYY-MM-DD must be recognized as a date-only value');
assert.equal(dateOnly.date.getFullYear(), expected.year, 'date-only year must remain local');
assert.equal(dateOnly.date.getMonth(), expected.month, 'date-only month must remain local');
assert.equal(dateOnly.date.getDate(), expected.day, 'date-only day must remain local');
assert.equal(dateOnly.date.getHours(), 23, 'deadline date-only values must expire at local end of day');
assert.equal(dateOnly.date.getMinutes(), 59, 'deadline date-only values must expire at local end of day');
assert.equal(dateOnly.date.getSeconds(), 59, 'deadline date-only values must expire at local end of day');
assert.equal(dateOnly.date.getMilliseconds(), 999, 'deadline date-only values must expire at local end of day');

const formatted = formatDate('2026-10-07');
assert.match(formatted, /2026/, 'date-only formatting must retain the calendar year');
assert.doesNotMatch(formatted, /23:59|11:59/, 'date-only formatting must not invent a display time');

const timestamp = parseDateValue('2026-10-07T18:30:00');
assert.equal(timestamp.dateOnly, false, 'timestamps must retain date-time semantics');
assert.equal(timestamp.date.getHours(), 18, 'timestamps without an offset must retain their local time');

const todoRendering = fs.readFileSync(new URL('../web/static/js/features/todo-rendering.js', import.meta.url), 'utf8');
assert.match(
  todoRendering,
  /parseDateValue\(t\.due_date, \{ dateOnlyEndOfDay: true \}\)/,
  'Todo cards and Calm view must apply local end-of-day deadline semantics',
);

console.log(`✅ Local date-only semantics passed (${process.env.TZ || 'system timezone'})`);

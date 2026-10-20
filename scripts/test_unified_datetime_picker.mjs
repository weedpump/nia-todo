import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const pickerSource = readFileSync(new URL('../web/static/js/features/date-time-picker.js', import.meta.url), 'utf8');
const uiHistorySource = readFileSync(new URL('../web/static/js/features/ui-history.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../web/static/js/app.js', import.meta.url), 'utf8');
const todosSource = readFileSync(new URL('../web/static/js/features/todos.js', import.meta.url), 'utf8');
const uiShellSource = readFileSync(new URL('../web/static/js/features/ui-shell.js', import.meta.url), 'utf8');
const styleManifest = readFileSync(new URL('../web/static/style.css', import.meta.url), 'utf8');
const pickerCssSource = readFileSync(new URL('../web/static/css/97-date-time-picker.css', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../package.json', import.meta.url), 'utf8');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'de-DE', viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

await page.route('http://datetime-picker.test/**', async route => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === '/static/js/features/date-time-picker.js') {
    await route.fulfill({ contentType: 'text/javascript', body: pickerSource });
    return;
  }
  if (pathname === '/static/js/features/ui-history.js') {
    await route.fulfill({ contentType: 'text/javascript', body: uiHistorySource });
    return;
  }
  if (pathname === '/static/js/i18n/index.js') {
    await route.fulfill({
      contentType: 'text/javascript',
      body: `
        const labels = {
          'common.cancel': 'Abbrechen',
          'common.clear': 'Leeren',
          'datetimePicker.apply': 'Übernehmen',
          'datetimePicker.today': 'Heute',
          'datetimePicker.previousMonth': 'Vorheriger Monat',
          'datetimePicker.nextMonth': 'Nächster Zeitraum',
          'datetimePicker.previousPeriod': 'Vorheriger Zeitraum',
          'datetimePicker.nextPeriod': 'Nächster Zeitraum',
          'datetimePicker.chooseMonth': 'Monat auswählen',
          'datetimePicker.chooseYear': 'Jahr auswählen',
          'datetimePicker.hour': 'Stunde',
          'datetimePicker.minute': 'Minute',
          'datetimePicker.open': '{field} auswählen',
        };
        export function t(key, params = {}) {
          return Object.entries(params).reduce((value, [name, replacement]) => value.replaceAll('{' + name + '}', replacement), labels[key] || key);
        }
        export function getActiveLocale() { return 'de-DE'; }
      `,
    });
    return;
  }
  if (pathname !== '/picker-test') {
    await route.fulfill({ status: 404, body: 'Not found' });
    return;
  }
  await route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html>
      <html lang="de">
        <body style="min-height:3000px">
          <div class="modal active" id="todo-modal">
            <label for="todo-due-picker">Deadline</label>
            <div class="datetime-input-wrap">
              <input class="datetime-picker-native-value" type="datetime-local" id="todo-due" value="2026-10-20T18:30" tabindex="-1" aria-hidden="true">
              <button type="button" class="ui-field datetime-picker-trigger" id="todo-due-picker" data-datetime-picker-for="todo-due" aria-haspopup="dialog" aria-controls="date-time-picker-modal">
                <span data-datetime-picker-display></span>
              </button>
            </div>
          </div>
          <div class="modal date-time-picker-modal" id="date-time-picker-modal" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="date-time-picker-title">
            <div class="modal-overlay" data-datetime-picker-action="cancel"></div>
            <div class="modal-content date-time-picker-content">
              <div class="date-time-picker-header">
                <div>
                  <h3 id="date-time-picker-title"></h3>
                  <p id="date-time-picker-selection"></p>
                </div>
                <button type="button" data-datetime-picker-action="cancel">×</button>
              </div>
              <div class="date-time-picker-body">
                <div class="date-time-picker-month-nav">
                  <button type="button" data-datetime-picker-action="previous-period">‹</button>
                  <button type="button" class="date-time-picker-period" id="date-time-picker-month" data-datetime-picker-action="zoom-out"></button>
                  <button type="button" data-datetime-picker-action="next-period">›</button>
                </div>
                <div class="date-time-picker-weekdays" id="date-time-picker-weekdays"></div>
                <div class="date-time-picker-grid" id="date-time-picker-grid" role="grid"></div>
                <div class="date-time-picker-time">
                  <label><span data-datetime-picker-hour-label></span><input id="date-time-picker-hour" inputmode="numeric" maxlength="2"></label>
                  <span>:</span>
                  <label><span data-datetime-picker-minute-label></span><input id="date-time-picker-minute" inputmode="numeric" maxlength="2"></label>
                </div>
              </div>
              <div class="date-time-picker-actions">
                <button type="button" data-datetime-picker-action="today"></button>
                <button type="button" data-datetime-picker-action="clear"></button>
                <button type="button" data-datetime-picker-action="cancel"></button>
                <button type="button" data-datetime-picker-action="apply"></button>
              </div>
            </div>
          </div>
          <script type="module">
            import { createDateTimePickerFeature } from '/static/js/features/date-time-picker.js';
            const input = document.getElementById('todo-due');
            window.inputEvents = 0;
            window.changeEvents = 0;
            input.addEventListener('input', () => { window.inputEvents += 1; });
            input.addEventListener('change', () => { window.changeEvents += 1; });
            window.picker = createDateTimePickerFeature();
            window.picker.bind();
            window.pickerReady = true;
          </script>
        </body>
      </html>`,
  });
});

try {
  await page.goto('http://datetime-picker.test/picker-test');
  await page.waitForFunction(() => window.pickerReady === true);

  const initialDisplay = await page.locator('[data-datetime-picker-display]').textContent();
  assert.match(initialDisplay, /Di\.?/i, 'the field summary must include the selected weekday');
  assert.match(initialDisplay, /20/, 'the field summary must include the selected day');

  await page.click('[data-datetime-picker-for="todo-due"]');
  await page.locator('#date-time-picker-modal.active').waitFor();
  assert.equal(await page.locator('html').getAttribute('class'), 'date-time-picker-open', 'opening the picker must lock the document against mobile background scrolling');
  assert.equal(await page.locator('#date-time-picker-modal').getAttribute('aria-hidden'), 'false');
  assert.match(await page.locator('#date-time-picker-title').textContent(), /Deadline/);
  assert.match(await page.locator('#date-time-picker-selection').textContent(), /Dienstag, 20\. Oktober 2026/);
  assert.match(await page.locator('#date-time-picker-month').textContent(), /Oktober 2026/);
  assert.equal(await page.locator('.modal-overlay[data-datetime-picker-action="cancel"]').textContent(), '', 'the overlay must stay visually empty');

  const weekdayLabels = await page.locator('#date-time-picker-weekdays > *').allTextContents();
  assert.deepEqual(weekdayLabels, ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'], 'German calendars must start on Monday and expose all weekdays');
  assert.equal(await page.locator('#date-time-picker-grid > [role="row"]').count(), 6, 'the calendar grid must expose six accessible rows');
  assert.equal(await page.locator('#date-time-picker-grid > [role="row"] > [role="gridcell"]').count(), 42, 'the calendar must always render a stable six-week accessible grid');
  assert.equal(await page.locator('#date-time-picker-grid > [role="gridcell"]').count(), 0, 'grid cells must not be direct children of the grid');

  await page.click('[data-datetime-picker-action="zoom-out"]');
  assert.equal(await page.locator('#date-time-picker-grid .date-time-picker-month-option').count(), 12, 'zooming out once must show all twelve months');
  assert.equal(await page.locator('#date-time-picker-grid > [role="row"]').count(), 4, 'month selection must expose four accessible rows');
  assert.equal(await page.locator('#date-time-picker-grid [role="gridcell"][aria-selected]').count(), 12, 'month options must expose selection state on grid cells');
  assert.equal(await page.locator('#date-time-picker-weekdays').isHidden(), true, 'weekday headings must hide in month selection');
  assert.equal(await page.locator('#date-time-picker-month').textContent(), '2026');

  await page.click('[data-datetime-picker-action="zoom-out"]');
  assert.equal(await page.locator('#date-time-picker-grid .date-time-picker-year-option').count(), 12, 'zooming out twice must show a twelve-year range');
  assert.equal(await page.locator('#date-time-picker-grid > [role="row"]').count(), 4, 'year selection must expose four accessible rows');
  assert.equal(await page.locator('#date-time-picker-grid [role="gridcell"][aria-selected]').count(), 12, 'year options must expose selection state on grid cells');
  await page.click('[data-year="2026"]');
  assert.equal(await page.locator('#date-time-picker-grid .date-time-picker-month-option').count(), 12, 'choosing a year must return to month selection');
  await page.click('[data-month="9"]');
  assert.match(await page.locator('#date-time-picker-month').textContent(), /Oktober 2026/, 'choosing a month must return to the day calendar');
  assert.equal(await page.locator('#date-time-picker-grid [role="gridcell"]').count(), 42);

  await page.locator('[data-date="2026-10-20"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator(':focus').getAttribute('data-date'), '2026-10-21', 'ArrowRight must move calendar focus by one day');

  await page.click('[data-date="2026-10-22"]');
  await page.fill('#date-time-picker-hour', '7');
  await page.fill('#date-time-picker-minute', '5');
  await page.click('[data-datetime-picker-action="apply"]');
  assert.equal(await page.locator('#todo-due').inputValue(), '2026-10-22T07:05');
  assert.deepEqual(await page.evaluate(() => ({ input: window.inputEvents, change: window.changeEvents })), { input: 1, change: 1 });
  assert.equal(await page.locator('#date-time-picker-modal').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('html').getAttribute('class'), '', 'closing the picker must release the document scroll lock');
  assert.match(await page.locator('[data-datetime-picker-display]').textContent(), /Do\.?/i);

  await page.click('[data-datetime-picker-for="todo-due"]');
  await page.click('[data-date="2026-10-28"]');
  await page.click('button[data-datetime-picker-action="cancel"]:not(.modal-close-x)');
  assert.equal(await page.locator('#todo-due').inputValue(), '2026-10-22T07:05', 'cancel must preserve the stored value');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'todo-due-picker', 'closing the picker must restore focus to the visible trigger');

  await page.click('[data-datetime-picker-for="todo-due"]');
  await page.click('[data-datetime-picker-action="clear"]');
  assert.equal(await page.locator('#todo-due').inputValue(), '', 'clear must remove the stored value');
  assert.equal(await page.locator('[data-datetime-picker-display]').textContent(), '', 'clear must remove the visible value');
  assert.deepEqual(await page.evaluate(() => ({ input: window.inputEvents, change: window.changeEvents })), { input: 2, change: 2 });
} finally {
  await context.close();
  await browser.close();
}

assert.match(indexSource, /data-datetime-picker-for="todo-due"/, 'deadline must use the shared datetime picker trigger');
assert.match(indexSource, /data-datetime-picker-for="todo-remind"/, 'reminder must use the shared datetime picker trigger');
assert.match(indexSource, /<label for="todo-due-picker"[^>]*data-i18n-key="todo\.deadline"/, 'the deadline label must target the visible picker trigger');
assert.match(indexSource, /<label for="todo-remind-picker"[^>]*data-i18n-key="todo\.reminder"/, 'the reminder label must target the visible picker trigger');
assert.match(indexSource, /id="todo-due-picker"[^>]*data-datetime-picker-for="todo-due"/, 'the deadline picker trigger must expose the label target id');
assert.match(indexSource, /id="todo-remind-picker"[^>]*data-datetime-picker-for="todo-remind"/, 'the reminder picker trigger must expose the label target id');
assert.match(indexSource, /id="date-time-picker-modal"/, 'the shared datetime picker dialog must be shipped in the app shell');
assert.match(appSource, /createDateTimePickerFeature/, 'the app entrypoint must create the shared datetime picker');
assert.match(appSource, /dateTimePickerFeature\.bind\(\)/, 'the app entrypoint must bind the shared datetime picker');
assert.match(appSource, /syncDateTimePickers:\s*\(\)\s*=>\s*dateTimePickerFeature\.syncAll\(\)/, 'todo hydration must receive the picker display synchronizer');
assert.match(todosSource, /syncDateTimePickers\?\.\(\)/, 'todo creation and editing must refresh programmatically hydrated picker summaries');
assert.match(todosSource, /data-datetime-picker-for=\\?"\$\{CSS\.escape\(controlId\)\}\\?"/, 'todo metadata chips must resolve the shared picker trigger');
assert.doesNotMatch(todosSource, /control\.showPicker\(/, 'todo metadata chips must never reopen the platform-native picker');
assert.doesNotMatch(uiShellSource, /showPicker\(/, 'the shared picker must not fall back to platform-native date/time UI');
assert.match(styleManifest, /97-date-time-picker\.css/, 'the shared picker stylesheet must be part of the app cascade');
assert.match(pickerCssSource, /html\.date-time-picker-open[\s\S]*overflow:\s*hidden/, 'the picker must lock document scrolling while open');
assert.match(pickerCssSource, /overscroll-behavior:\s*none/, 'the fullscreen picker must contain mobile overscroll');
assert.match(packageSource, /test_unified_datetime_picker\.mjs/, 'the frontend test gate must run the shared picker regression');
assert.doesNotMatch(packageSource, /test_android_datetime_picker_opener\.mjs/, 'the obsolete platform-native picker regression must leave the frontend gate');

const pickerTranslationKeys = [
  'common.clear',
  'datetimePicker.apply',
  'datetimePicker.today',
  'datetimePicker.previousMonth',
  'datetimePicker.nextMonth',
  'datetimePicker.previousPeriod',
  'datetimePicker.nextPeriod',
  'datetimePicker.chooseMonth',
  'datetimePicker.chooseYear',
  'datetimePicker.hour',
  'datetimePicker.minute',
  'datetimePicker.open',
];
for (const locale of ['cs', 'de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'zh-CN']) {
  const dictionary = JSON.parse(readFileSync(new URL(`../web/static/i18n/${locale}.json`, import.meta.url), 'utf8'));
  for (const key of pickerTranslationKeys) {
    assert.equal(typeof dictionary[key], 'string', `${locale} must translate ${key}`);
    assert(dictionary[key].length > 0, `${locale} translation for ${key} must not be empty`);
  }
}

console.log('Unified datetime picker tests passed');

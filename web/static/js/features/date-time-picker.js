import { getActiveLocale, t } from '../i18n/index.js';
import { openUiLayer, registerUiLayer, requestCloseUiLayer } from './ui-history.js';

const PICKER_MODAL_ID = 'date-time-picker-modal';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseLocalDateTime(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
  ) return null;
  return date;
}

function localDateAtNoon(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
}

function addCalendarDays(date, days) {
  const result = localDateAtNoon(date);
  result.setDate(result.getDate() + days);
  return result;
}

function firstWeekday(locale) {
  try {
    const localeInfo = new Intl.Locale(locale);
    const firstDay = localeInfo.weekInfo?.firstDay ?? localeInfo.getWeekInfo?.().firstDay;
    if (Number.isInteger(firstDay)) return firstDay % 7;
  } catch (_error) {
    // Fall through to the supported-locale default below.
  }
  return String(locale).toLowerCase() === 'en-us' ? 0 : 1;
}

function calendarStart(viewDate, locale) {
  const firstOfMonth = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1, 12, 0, 0, 0);
  const offset = (firstOfMonth.getDay() - firstWeekday(locale) + 7) % 7;
  return addCalendarDays(firstOfMonth, -offset);
}

function appendGridRows(container, cells, columns) {
  for (let index = 0; index < cells.length; index += columns) {
    const row = document.createElement('div');
    row.className = 'date-time-picker-grid-row';
    row.setAttribute('role', 'row');
    cells.slice(index, index + columns).forEach(cell => row.append(cell));
    container.append(row);
  }
}

function formatter(locale, options) {
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch (_error) {
    return new Intl.DateTimeFormat(undefined, options);
  }
}

export function createDateTimePickerFeature() {
  let bound = false;
  let activeInput = null;
  let activeTrigger = null;
  let selectedDate = null;
  let viewDate = null;
  let viewMode = 'days';
  let yearRangeStart = null;
  let returnFocusTarget = null;
  let selectedDayPeriod = 'am';

  const modal = () => document.getElementById(PICKER_MODAL_ID);
  const grid = () => document.getElementById('date-time-picker-grid');
  const hourInput = () => document.getElementById('date-time-picker-hour');
  const minuteInput = () => document.getElementById('date-time-picker-minute');
  const dayInput = () => document.getElementById('date-time-picker-day');
  const monthInput = () => document.getElementById('date-time-picker-date-month');
  const yearInput = () => document.getElementById('date-time-picker-year');
  const validationError = () => document.getElementById('date-time-picker-error');
  const dayPeriodControl = () => document.getElementById('date-time-picker-day-period');

  function usesTwelveHourTime() {
    return String(getActiveLocale()).toLowerCase().startsWith('en');
  }

  function setDayPeriod(period) {
    selectedDayPeriod = period === 'pm' ? 'pm' : 'am';
    dayPeriodControl()?.querySelectorAll('[data-datetime-picker-day-period]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.datetimePickerDayPeriod === selectedDayPeriod));
    });
  }

  function setTimeInputs(hour, minute) {
    const twelveHour = usesTwelveHourTime();
    const control = dayPeriodControl();
    if (control) control.hidden = !twelveHour;
    if (twelveHour) {
      setDayPeriod(hour >= 12 ? 'pm' : 'am');
      if (hourInput()) hourInput().value = pad2(hour % 12 || 12);
    } else if (hourInput()) {
      hourInput().value = pad2(hour);
    }
    if (minuteInput()) minuteInput().value = pad2(minute);
  }

  function setDateInputs(date) {
    if (dayInput()) dayInput().value = pad2(date.getDate());
    if (monthInput()) monthInput().value = pad2(date.getMonth() + 1);
    if (yearInput()) yearInput().value = String(date.getFullYear());
  }

  function strictInteger(input, minimum, maximum) {
    const value = String(input?.value || '').trim();
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
  }

  function clearValidationError() {
    if (validationError()) validationError().textContent = '';
    modal()?.querySelectorAll('[aria-invalid="true"]').forEach(input => input.removeAttribute('aria-invalid'));
  }

  function showValidationError(key, input) {
    if (validationError()) validationError().textContent = t(key);
    input?.setAttribute('aria-invalid', 'true');
    input?.focus({ preventScroll: true });
  }

  function directDateValue() {
    const day = strictInteger(dayInput(), 1, 31);
    const month = strictInteger(monthInput(), 1, 12);
    const year = strictInteger(yearInput(), 1900, 9999);
    if (day === null || month === null || year === null) return null;
    const date = new Date(year, month - 1, day, 12, 0, 0, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return date;
  }

  function syncCalendarFromDateInputs() {
    const date = directDateValue();
    if (!date) return;
    selectedDate = localDateAtNoon(date);
    viewDate = new Date(date.getFullYear(), date.getMonth(), 1, 12, 0, 0, 0);
    viewMode = 'days';
    yearRangeStart = null;
    renderCalendar({ focusDate: selectedDate });
  }

  function handleDirectDateInput(event) {
    const input = event.target;
    const nextInput = input === dayInput()
      ? monthInput()
      : input === monthInput()
        ? yearInput()
        : input === yearInput()
          ? hourInput()
          : null;
    input.value = input.value.replace(/\D/g, '').slice(0, Number(input.maxLength) || undefined);
    clearValidationError();
    syncCalendarFromDateInputs();
    if (nextInput && input.value.length === Number(input.maxLength) && !String(event.inputType || '').startsWith('delete')) {
      nextInput.focus({ preventScroll: true });
      nextInput.select?.();
    }
  }

  function fieldLabel(trigger = activeTrigger) {
    if (!trigger) return '';
    const explicit = trigger.dataset.datetimePickerLabel;
    if (explicit) return explicit;
    const inputId = trigger.dataset.datetimePickerFor;
    const labelTargetId = trigger.id || inputId;
    return document.querySelector(`label[for="${CSS.escape(labelTargetId || '')}"]`)?.textContent?.trim() || '';
  }

  function formatStoredValue(input) {
    const value = parseLocalDateTime(input?.value);
    if (!value) return '';
    return formatter(getActiveLocale(), {
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(value);
  }

  function syncTrigger(trigger) {
    const input = document.getElementById(trigger?.dataset?.datetimePickerFor || '');
    if (!input) return;
    const display = trigger.querySelector('[data-datetime-picker-display]');
    const label = fieldLabel(trigger);
    const formatted = formatStoredValue(input);
    if (display) display.textContent = formatted;
    trigger.classList.toggle('is-empty', !formatted);
    trigger.setAttribute('aria-label', t('datetimePicker.open', { field: label }));
    trigger.title = formatted || t('datetimePicker.open', { field: label });
  }

  function syncAll() {
    document.querySelectorAll('[data-datetime-picker-for]').forEach(syncTrigger);
  }

  function renderWeekdays() {
    const container = document.getElementById('date-time-picker-weekdays');
    if (!container) return;
    const locale = getActiveLocale();
    const firstDay = firstWeekday(locale);
    const sunday = new Date(2024, 0, 7, 12, 0, 0, 0);
    container.replaceChildren();
    for (let index = 0; index < 7; index += 1) {
      const weekday = addCalendarDays(sunday, (firstDay + index) % 7);
      const item = document.createElement('span');
      item.textContent = formatter(locale, { weekday: 'short' }).format(weekday).replace(/\.$/, '');
      item.setAttribute('aria-hidden', 'true');
      container.append(item);
    }
  }

  function renderSelectionLabel() {
    const label = document.getElementById('date-time-picker-selection');
    if (!label || !selectedDate) return;
    label.textContent = formatter(getActiveLocale(), {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(selectedDate);
  }

  function setCalendarView(mode) {
    viewMode = mode;
    const container = grid();
    const weekdays = document.getElementById('date-time-picker-weekdays');
    container?.classList.toggle('is-months', mode === 'months');
    container?.classList.toggle('is-years', mode === 'years');
    if (weekdays) weekdays.hidden = mode !== 'days';
  }

  function setPeriodLabel(text, label, disabled = false) {
    const period = document.getElementById('date-time-picker-month');
    if (!period) return;
    period.textContent = text;
    period.setAttribute('aria-label', label);
    period.disabled = disabled;
  }

  function renderCalendar({ focusDate = null } = {}) {
    const container = grid();
    if (!container || !selectedDate || !viewDate) return;
    const locale = getActiveLocale();
    const todayKey = dateKey(new Date());
    const selectedKey = dateKey(selectedDate);
    const focusKey = dateKey(focusDate || selectedDate);
    const start = calendarStart(viewDate, locale);
    setCalendarView('days');
    setPeriodLabel(
      formatter(locale, { month: 'long', year: 'numeric' }).format(viewDate),
      t('datetimePicker.chooseMonth'),
    );
    renderWeekdays();
    renderSelectionLabel();
    container.replaceChildren();

    const cells = [];
    for (let index = 0; index < 42; index += 1) {
      const date = addCalendarDays(start, index);
      const key = dateKey(date);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'date-time-picker-day';
      button.dataset.date = key;
      button.setAttribute('role', 'gridcell');
      button.setAttribute('aria-label', formatter(locale, {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      }).format(date));
      button.setAttribute('aria-selected', String(key === selectedKey));
      button.tabIndex = key === focusKey ? 0 : -1;
      button.textContent = String(date.getDate());
      if (date.getMonth() !== viewDate.getMonth()) button.classList.add('is-outside-month');
      if (key === selectedKey) button.classList.add('is-selected');
      if (key === todayKey) button.classList.add('is-today');
      cells.push(button);
    }
    appendGridRows(container, cells, 7);
  }

  function renderMonthSelection({ focusMonth = viewDate?.getMonth() } = {}) {
    const container = grid();
    if (!container || !viewDate) return;
    const locale = getActiveLocale();
    const year = viewDate.getFullYear();
    setCalendarView('months');
    setPeriodLabel(String(year), t('datetimePicker.chooseYear'));
    container.replaceChildren();
    const cells = [];
    for (let month = 0; month < 12; month += 1) {
      const date = new Date(year, month, 1, 12, 0, 0, 0);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'date-time-picker-month-option';
      button.dataset.month = String(month);
      button.setAttribute('role', 'gridcell');
      button.textContent = formatter(locale, { month: 'short' }).format(date).replace(/\.$/, '');
      button.setAttribute('aria-label', formatter(locale, { month: 'long', year: 'numeric' }).format(date));
      button.setAttribute('aria-selected', String(month === selectedDate?.getMonth() && year === selectedDate?.getFullYear()));
      button.tabIndex = month === focusMonth ? 0 : -1;
      if (month === selectedDate?.getMonth() && year === selectedDate?.getFullYear()) button.classList.add('is-selected');
      if (month === new Date().getMonth() && year === new Date().getFullYear()) button.classList.add('is-today');
      cells.push(button);
    }
    appendGridRows(container, cells, 3);
  }

  function renderYearSelection({ focusYear = viewDate?.getFullYear() } = {}) {
    const container = grid();
    if (!container || !viewDate) return;
    const currentYear = new Date().getFullYear();
    if (!Number.isInteger(yearRangeStart)) yearRangeStart = Math.floor(viewDate.getFullYear() / 12) * 12;
    setCalendarView('years');
    setPeriodLabel(`${yearRangeStart}–${yearRangeStart + 11}`, t('datetimePicker.chooseYear'), true);
    container.replaceChildren();
    const cells = [];
    for (let offset = 0; offset < 12; offset += 1) {
      const year = yearRangeStart + offset;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'date-time-picker-year-option';
      button.dataset.year = String(year);
      button.setAttribute('role', 'gridcell');
      button.textContent = String(year);
      button.setAttribute('aria-selected', String(year === selectedDate?.getFullYear()));
      button.tabIndex = year === focusYear ? 0 : -1;
      if (year === selectedDate?.getFullYear()) button.classList.add('is-selected');
      if (year === currentYear) button.classList.add('is-today');
      cells.push(button);
    }
    appendGridRows(container, cells, 3);
  }

  function renderCurrentView(options = {}) {
    if (viewMode === 'months') renderMonthSelection(options);
    else if (viewMode === 'years') renderYearSelection(options);
    else renderCalendar(options);
  }

  function updateStaticLabels() {
    const title = document.getElementById('date-time-picker-title');
    if (title) title.textContent = fieldLabel();
    const previous = document.querySelector('[data-datetime-picker-action="previous-period"]');
    const next = document.querySelector('[data-datetime-picker-action="next-period"]');
    if (previous) previous.setAttribute('aria-label', t('datetimePicker.previousPeriod'));
    if (next) next.setAttribute('aria-label', t('datetimePicker.nextPeriod'));
    const hourLabel = document.querySelector('[data-datetime-picker-hour-label]');
    const minuteLabel = document.querySelector('[data-datetime-picker-minute-label]');
    const dayLabel = document.querySelector('[data-datetime-picker-day-label]');
    const monthLabel = document.querySelector('[data-datetime-picker-month-label]');
    const yearLabel = document.querySelector('[data-datetime-picker-year-label]');
    if (hourLabel) hourLabel.textContent = t('datetimePicker.hour');
    if (minuteLabel) minuteLabel.textContent = t('datetimePicker.minute');
    if (dayLabel) dayLabel.textContent = t('datetimePicker.day');
    if (monthLabel) monthLabel.textContent = t('datetimePicker.month');
    if (yearLabel) yearLabel.textContent = t('datetimePicker.year');
    const labels = {
      today: 'datetimePicker.today',
      clear: 'common.clear',
      cancel: 'common.cancel',
      apply: 'datetimePicker.apply',
    };
    Object.entries(labels).forEach(([action, key]) => {
      document.querySelectorAll(`button[data-datetime-picker-action="${action}"]`).forEach((button) => {
        if (!button.classList.contains('modal-close-x')) button.textContent = t(key);
      });
    });
  }

  function open(trigger, { returnFocusTarget: requestedReturnFocusTarget = null } = {}) {
    const input = document.getElementById(trigger?.dataset?.datetimePickerFor || '');
    const pickerModal = modal();
    if (!input || !pickerModal) return;
    const parsed = parseLocalDateTime(input.value);
    const initial = parsed || new Date();
    activeInput = input;
    activeTrigger = trigger;
    returnFocusTarget = requestedReturnFocusTarget || trigger;
    selectedDate = localDateAtNoon(initial);
    viewDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1, 12, 0, 0, 0);
    viewMode = 'days';
    yearRangeStart = null;
    clearValidationError();
    setDateInputs(selectedDate);
    setTimeInputs(initial.getHours(), initial.getMinutes());
    updateStaticLabels();
    renderCalendar();
    pickerModal.classList.add('active');
    pickerModal.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('date-time-picker-open');
    document.getElementById('todo-modal')?.setAttribute('aria-hidden', 'true');
    openUiLayer(PICKER_MODAL_ID);
    window.requestAnimationFrame(() => {
      grid()?.querySelector('.is-selected')?.focus({ preventScroll: true });
    });
  }

  function finishClose() {
    const pickerModal = modal();
    pickerModal?.classList.remove('active');
    pickerModal?.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('date-time-picker-open');
    const todoModal = document.getElementById('todo-modal');
    if (todoModal?.classList.contains('active')) todoModal.removeAttribute('aria-hidden');
    const focusTarget = typeof returnFocusTarget === 'function'
      ? returnFocusTarget()
      : returnFocusTarget;
    activeInput = null;
    activeTrigger = null;
    selectedDate = null;
    viewDate = null;
    viewMode = 'days';
    yearRangeStart = null;
    returnFocusTarget = null;
    focusTarget?.focus?.({ preventScroll: true });
  }

  function close({ fromHistory = false } = {}) {
    if (modal()?.classList.contains('active') && !fromHistory && requestCloseUiLayer(PICKER_MODAL_ID, { reason: 'ui' })) return;
    finishClose();
  }

  function emitValue(value) {
    if (!activeInput) return;
    activeInput.value = value;
    activeInput.dispatchEvent(new Event('input', { bubbles: true }));
    activeInput.dispatchEvent(new Event('change', { bubbles: true }));
    if (activeTrigger) syncTrigger(activeTrigger);
  }

  function apply() {
    if (!selectedDate) return;
    clearValidationError();
    const directDate = directDateValue();
    if (!directDate) {
      showValidationError('datetimePicker.invalidDate', dayInput());
      return;
    }
    const twelveHour = usesTwelveHourTime();
    const enteredHour = strictInteger(hourInput(), twelveHour ? 1 : 0, twelveHour ? 12 : 23);
    if (enteredHour === null) {
      showValidationError(twelveHour ? 'datetimePicker.invalidHour12' : 'datetimePicker.invalidHour24', hourInput());
      return;
    }
    const minute = strictInteger(minuteInput(), 0, 59);
    if (minute === null) {
      showValidationError('datetimePicker.invalidMinute', minuteInput());
      return;
    }
    const hour = twelveHour
      ? (enteredHour % 12) + (selectedDayPeriod === 'pm' ? 12 : 0)
      : enteredHour;
    selectedDate = directDate;
    if (hourInput()) hourInput().value = pad2(enteredHour);
    if (minuteInput()) minuteInput().value = pad2(minute);
    emitValue(`${dateKey(selectedDate)}T${pad2(hour)}:${pad2(minute)}`);
    close();
  }

  function clear() {
    emitValue('');
    close();
  }

  function selectDate(date) {
    selectedDate = localDateAtNoon(date);
    setDateInputs(selectedDate);
    viewDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1, 12, 0, 0, 0);
    viewMode = 'days';
    yearRangeStart = null;
    renderCalendar({ focusDate: selectedDate });
  }

  function moveMonth(offset) {
    viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + offset, 1, 12, 0, 0, 0);
    renderCalendar({ focusDate: viewDate });
    window.requestAnimationFrame(() => grid()?.querySelector('[tabindex="0"]')?.focus({ preventScroll: true }));
  }

  function movePeriod(offset) {
    if (viewMode === 'years') {
      yearRangeStart += offset * 12;
      renderYearSelection({ focusYear: yearRangeStart + (offset > 0 ? 0 : 11) });
    } else if (viewMode === 'months') {
      viewDate = new Date(viewDate.getFullYear() + offset, viewDate.getMonth(), 1, 12, 0, 0, 0);
      renderMonthSelection();
    } else {
      moveMonth(offset);
      return;
    }
    window.requestAnimationFrame(() => grid()?.querySelector('[tabindex="0"]')?.focus({ preventScroll: true }));
  }

  function zoomOut() {
    if (viewMode === 'days') {
      renderMonthSelection();
    } else if (viewMode === 'months') {
      yearRangeStart = Math.floor(viewDate.getFullYear() / 12) * 12;
      renderYearSelection();
    }
    window.requestAnimationFrame(() => grid()?.querySelector('[tabindex="0"]')?.focus({ preventScroll: true }));
  }

  function selectMonth(month) {
    viewDate = new Date(viewDate.getFullYear(), month, 1, 12, 0, 0, 0);
    const focusDate = selectedDate?.getFullYear() === viewDate.getFullYear() && selectedDate?.getMonth() === month
      ? selectedDate
      : viewDate;
    renderCalendar({ focusDate });
    window.requestAnimationFrame(() => grid()?.querySelector('[tabindex="0"]')?.focus({ preventScroll: true }));
  }

  function selectYear(year) {
    viewDate = new Date(year, viewDate.getMonth(), 1, 12, 0, 0, 0);
    yearRangeStart = null;
    renderMonthSelection();
    window.requestAnimationFrame(() => grid()?.querySelector('[tabindex="0"]')?.focus({ preventScroll: true }));
  }

  function moveFocusedDay(button, days) {
    const [year, month, day] = String(button.dataset.date || '').split('-').map(Number);
    if (!year || !month || !day) return;
    const next = addCalendarDays(new Date(year, month - 1, day, 12, 0, 0, 0), days);
    if (next.getMonth() !== viewDate.getMonth() || next.getFullYear() !== viewDate.getFullYear()) {
      viewDate = new Date(next.getFullYear(), next.getMonth(), 1, 12, 0, 0, 0);
      renderCalendar({ focusDate: next });
      window.requestAnimationFrame(() => grid()?.querySelector(`[data-date="${dateKey(next)}"]`)?.focus({ preventScroll: true }));
      return;
    }
    grid()?.querySelectorAll('[tabindex="0"]').forEach(element => { element.tabIndex = -1; });
    const target = grid()?.querySelector(`[data-date="${dateKey(next)}"]`);
    if (target) {
      target.tabIndex = 0;
      target.focus({ preventScroll: true });
    }
  }

  function moveFocusedChoice(button, offset) {
    const choices = Array.from(grid()?.querySelectorAll('.date-time-picker-month-option, .date-time-picker-year-option') || []);
    const currentIndex = choices.indexOf(button);
    if (currentIndex < 0) return;
    const next = choices[Math.min(choices.length - 1, Math.max(0, currentIndex + offset))];
    if (!next || next === button) return;
    button.tabIndex = -1;
    next.tabIndex = 0;
    next.focus({ preventScroll: true });
  }

  function handleGridKeydown(event) {
    const choice = event.target?.closest?.('.date-time-picker-month-option, .date-time-picker-year-option');
    if (choice) {
      const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 };
      if (moves[event.key]) {
        event.preventDefault();
        moveFocusedChoice(choice, moves[event.key]);
      }
      return;
    }
    const button = event.target?.closest?.('[data-date]');
    if (!button) return;
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (moves[event.key]) {
      event.preventDefault();
      moveFocusedDay(button, moves[event.key]);
      return;
    }
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      moveMonth(event.key === 'PageUp' ? -1 : 1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const [year, month, day] = String(button.dataset.date || '').split('-').map(Number);
      const date = new Date(year, month - 1, day, 12, 0, 0, 0);
      const start = firstWeekday(getActiveLocale());
      const offset = (date.getDay() - start + 7) % 7;
      moveFocusedDay(button, event.key === 'Home' ? -offset : 6 - offset);
    }
  }

  function trapFocus(event) {
    if (event.key !== 'Tab' || !modal()?.classList.contains('active')) return;
    const focusable = Array.from(modal().querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter(element => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function bind() {
    if (bound || typeof document === 'undefined') return;
    bound = true;
    syncAll();
    registerUiLayer(PICKER_MODAL_ID, () => close({ fromHistory: true }));
    document.addEventListener('click', (event) => {
      const trigger = event.target?.closest?.('[data-datetime-picker-for]');
      if (trigger) {
        event.preventDefault();
        open(trigger);
        return;
      }
      const day = event.target?.closest?.('#date-time-picker-grid [data-date]');
      if (day) {
        const [year, month, date] = day.dataset.date.split('-').map(Number);
        selectDate(new Date(year, month - 1, date, 12, 0, 0, 0));
        return;
      }
      const month = event.target?.closest?.('#date-time-picker-grid [data-month]');
      if (month) {
        selectMonth(Number(month.dataset.month));
        return;
      }
      const year = event.target?.closest?.('#date-time-picker-grid [data-year]');
      if (year) {
        selectYear(Number(year.dataset.year));
        return;
      }
      const dayPeriod = event.target?.closest?.('[data-datetime-picker-day-period]')?.dataset?.datetimePickerDayPeriod;
      if (dayPeriod) {
        event.preventDefault();
        setDayPeriod(dayPeriod);
        return;
      }
      const action = event.target?.closest?.('[data-datetime-picker-action]')?.dataset?.datetimePickerAction;
      if (!action) return;
      event.preventDefault();
      if (action === 'previous-period') movePeriod(-1);
      else if (action === 'next-period') movePeriod(1);
      else if (action === 'zoom-out') zoomOut();
      else if (action === 'today') selectDate(new Date());
      else if (action === 'clear') clear();
      else if (action === 'cancel') close();
      else if (action === 'apply') apply();
    });
    modal()?.addEventListener('input', (event) => {
      if (event.target?.matches?.('#date-time-picker-day, #date-time-picker-date-month, #date-time-picker-year')) {
        handleDirectDateInput(event);
      } else if (event.target?.matches?.('#date-time-picker-hour, #date-time-picker-minute')) {
        clearValidationError();
        if (
          event.target === hourInput()
          && /^\d+$/.test(event.target.value)
          && event.target.value.length === Number(event.target.maxLength)
          && !String(event.inputType || '').startsWith('delete')
        ) {
          minuteInput()?.focus({ preventScroll: true });
          minuteInput()?.select?.();
        }
      }
    });
    grid()?.addEventListener('keydown', handleGridKeydown);
    document.addEventListener('keydown', (event) => {
      if (!modal()?.classList.contains('active')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      trapFocus(event);
    }, true);
    document.querySelectorAll('[data-datetime-picker-for]').forEach((trigger) => {
      const input = document.getElementById(trigger.dataset.datetimePickerFor || '');
      input?.addEventListener('input', () => syncTrigger(trigger));
      input?.addEventListener('change', () => syncTrigger(trigger));
    });
    window.addEventListener('nia-language-change', () => {
      syncAll();
      if (modal()?.classList.contains('active')) {
        updateStaticLabels();
        renderCurrentView();
      }
    });
  }

  return { bind, close, open, syncAll };
}

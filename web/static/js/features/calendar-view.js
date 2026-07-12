import { t } from '../i18n/index.js';
import { iconSvg, markerHtml, safeColor } from '../icons/lucide-icons.js';

const MODE_KEY = 'nia-calendar-view-mode';
const ANCHOR_KEY = 'nia-calendar-anchor-date';
const CONTROLS_KEY = 'nia-calendar-controls-open';
const MODES = ['day', 'week', 'month'];

export function createCalendarViewFeature({
  escapeHtml,
  escapeHtmlAttr,
  renderTodos,
  openTodo,
  setTodoStatus,
}) {
  let mode = normalizeMode(localStorage.getItem(MODE_KEY));
  let anchorDate = parseStoredDate(localStorage.getItem(ANCHOR_KEY)) || startOfDay(new Date());
  let controlsOpen = localStorage.getItem(CONTROLS_KEY) === 'true';
  let actionsBound = false;
  let toolbarResizeObserver = null;
  let stickyWeekHeaderBound = false;
  let stickyWeekHeaderFrame = 0;
  let calendarSwipeBound = false;
  let calendarSwipeActive = null;
  let calendarViewSwipeBound = false;
  let calendarViewSwipeActive = null;
  let calendarViewTransitionDirection = 0;
  let calendarViewAnimating = false;
  let lastCalendarEvents = [];
  let suppressCalendarClickUntil = 0;
  let suppressCalendarViewClickUntil = 0;

  function normalizeMode(value) {
    return MODES.includes(value) ? value : 'month';
  }

  function parseStoredDate(value) {
    if (!value) return null;
    const date = new Date(`${value}T00:00:00`);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function startOfDay(date) {
    const next = new Date(date);
    next.setHours(0, 0, 0, 0);
    return next;
  }

  function addDays(date, amount) {
    const next = new Date(date);
    next.setDate(next.getDate() + amount);
    return next;
  }

  function addMonths(date, amount) {
    const next = new Date(date);
    const originalDay = next.getDate();
    next.setDate(1);
    next.setMonth(next.getMonth() + amount);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(originalDay, lastDay));
    return next;
  }

  function startOfWeek(date) {
    const next = startOfDay(date);
    const day = next.getDay() || 7;
    next.setDate(next.getDate() - day + 1);
    return next;
  }

  function startOfMonth(date) {
    return startOfDay(new Date(date.getFullYear(), date.getMonth(), 1));
  }

  function startOfMonthGrid(date) {
    return startOfWeek(startOfMonth(date));
  }

  function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function isSameDay(a, b) {
    return dateKey(a) === dateKey(b);
  }

  function isToday(date) {
    return isSameDay(date, new Date());
  }

  function parseTodoDueDate(todo) {
    if (!todo?.due_date) return null;
    const raw = String(todo.due_date);
    const allDay = /^\d{4}-\d{2}-\d{2}$/.test(raw);
    const normalized = allDay ? `${raw}T00:00:00` : raw.replace(' ', 'T');
    const date = new Date(normalized);
    if (!Number.isFinite(date.getTime())) return null;
    return { date, allDay };
  }

  function formatMonthTitle(date) {
    return new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric' }).format(date);
  }

  function formatDayTitle(date) {
    return new Intl.DateTimeFormat(locale(), { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).format(date);
  }

  function formatRangeTitle(start, end) {
    const currentLocale = locale();
    const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
    if (sameMonth) {
      const first = new Intl.DateTimeFormat(currentLocale, { day: '2-digit' }).format(start);
      const last = new Intl.DateTimeFormat(currentLocale, { day: '2-digit', month: 'long', year: 'numeric' }).format(end);
      return `${first}. – ${last}`;
    }
    const formatter = new Intl.DateTimeFormat(currentLocale, { day: '2-digit', month: 'short', year: 'numeric' });
    return `${formatter.format(start)} – ${formatter.format(end)}`;
  }

  function formatTime(date) {
    return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(date);
  }

  function formatShortDay(date) {
    return new Intl.DateTimeFormat(locale(), { weekday: 'short', day: '2-digit' }).format(date);
  }

  function locale() {
    return document.documentElement.lang === 'en' ? 'en-US' : 'de-DE';
  }

  function normalizeEvents(todos, projects, hideDone) {
    const projectById = new Map(projects.map(project => [Number(project.id), project]));
    return todos
      .filter(todo => todo?.due_date && (!hideDone || todo.status !== 'done'))
      .map(todo => {
        const due = parseTodoDueDate(todo);
        if (!due) return null;
        const project = projectById.get(Number(todo.project_id));
        return {
          id: `todo:${todo.id}`,
          todoId: todo.id,
          source: 'todo',
          title: todo.title || t('todo.title'),
          start: due.date,
          allDay: due.allDay,
          status: todo.status || 'pending',
          priority: Number(todo.priority || 3),
          project,
          color: project?.color ? safeColor(project.color) : 'var(--accent)',
          readonly: false,
        };
      })
      .filter(Boolean)
      .sort(compareEvents);
  }

  function compareEvents(a, b) {
    const timeDiff = a.start.getTime() - b.start.getTime();
    if (timeDiff) return timeDiff;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    if (a.status !== b.status) {
      const order = { in_progress: 0, pending: 1, done: 2 };
      return (order[a.status] ?? 9) - (order[b.status] ?? 9);
    }
    return a.priority - b.priority || a.title.localeCompare(b.title);
  }

  function eventsByDay(events) {
    const map = new Map();
    for (const event of events) {
      const key = dateKey(event.start);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(event);
    }
    return map;
  }

  function renderNavControls(extraClass = '') {
    return `<div class="calendar-nav-actions calendar-control-group ${extraClass}" aria-label="${escapeHtmlAttr(t('calendar.navigation'))}">
      <button type="button" class="btn btn-secondary btn-icon" data-calendar-action="prev" title="${escapeHtmlAttr(t('calendar.prev'))}">${iconSvg('chevron-left')}</button>
      <button type="button" class="btn btn-secondary btn-small" data-calendar-action="today">${escapeHtml(t('calendar.today'))}</button>
      <button type="button" class="btn btn-secondary btn-icon" data-calendar-action="next" title="${escapeHtmlAttr(t('calendar.next'))}">${iconSvg('chevron-right')}</button>
    </div>`;
  }

  function renderModeControls(extraClass = '') {
    return `<div class="calendar-mode-switch calendar-control-group ${extraClass}" role="group" aria-label="${escapeHtmlAttr(t('calendar.mode'))}">
      ${MODES.map(item => `<button type="button" class="btn btn-secondary btn-small calendar-mode-btn ${mode === item ? 'active' : ''}" data-calendar-mode="${escapeHtmlAttr(item)}">${escapeHtml(t(`calendar.mode.${item}`))}</button>`).join('')}
    </div>`;
  }

  function renderToolbar() {
    return `
      <div class="overview-dashboard calendar-toolbar ${controlsOpen ? 'is-controls-open' : ''}" data-calendar-controls-layout="pending">
        <div class="overview-dashboard-header calendar-heading">
          <div class="overview-greeting">
            <span class="overview-avatar calendar-avatar" aria-hidden="true">${iconSvg('calendar-days')}</span>
            <div class="calendar-title-wrap">
              <h2>${escapeHtml(t('calendar.title'))}</h2>
            </div>
          </div>
          <div class="calendar-header-controls">
            <div class="calendar-inline-controls" aria-label="${escapeHtmlAttr(t('calendar.inlineControls'))}">
              ${renderNavControls('calendar-inline-nav')}
              ${renderModeControls('calendar-inline-mode')}
            </div>
            <button type="button" class="btn btn-secondary btn-small calendar-controls-toggle" data-calendar-action="toggle-controls" aria-expanded="${controlsOpen ? 'true' : 'false'}">
              ${iconSvg(controlsOpen ? 'chevron-up' : 'chevron-down')}
              <span>${escapeHtml(controlsOpen ? t('calendar.controls.hide') : t('calendar.controls.show'))}</span>
            </button>
          </div>
        </div>
        <div class="calendar-toolbar-actions" ${controlsOpen ? '' : 'hidden'}>
          ${renderNavControls('calendar-panel-nav')}
          ${renderModeControls('calendar-panel-mode')}
        </div>
      </div>`;
  }

  function scheduleToolbarLayout() {
    window.requestAnimationFrame(() => {
      const toolbar = document.querySelector('.calendar-view .calendar-toolbar');
      if (!toolbar) return;
      updateToolbarLayout(toolbar);
      if (!toolbarResizeObserver) {
        toolbarResizeObserver = new ResizeObserver(entries => {
          for (const entry of entries) updateToolbarLayout(entry.target);
        });
      }
      toolbarResizeObserver.disconnect();
      toolbarResizeObserver.observe(toolbar);
    });
  }

  function updateToolbarLayout(toolbar) {
    const heading = toolbar.querySelector('.calendar-heading');
    const greeting = toolbar.querySelector('.overview-greeting');
    const nav = toolbar.querySelector('.calendar-inline-nav');
    const modeSwitch = toolbar.querySelector('.calendar-inline-mode');
    const toggle = toolbar.querySelector('.calendar-controls-toggle');
    if (!heading || !greeting || !nav || !modeSwitch || !toggle) return;

    if (window.matchMedia('(max-width: 900px)').matches) {
      toolbar.dataset.calendarControlsLayout = 'collapsed';
      return;
    }

    toolbar.dataset.calendarControlsLayout = 'measure';
    const available = Math.max(0, heading.clientWidth - greeting.offsetWidth - 18);
    const navWidth = nav.scrollWidth;
    const modeWidth = modeSwitch.scrollWidth;
    const toggleWidth = toggle.scrollWidth;
    const gap = 8;

    if (navWidth + modeWidth + gap <= available) {
      toolbar.dataset.calendarControlsLayout = 'full';
    } else if (navWidth + toggleWidth + gap <= available) {
      toolbar.dataset.calendarControlsLayout = 'partial';
    } else {
      toolbar.dataset.calendarControlsLayout = 'collapsed';
    }
  }


  function scheduleStickyWeekHeaderState() {
    queueStickyWeekHeaderStateUpdate();
    if (stickyWeekHeaderBound) return;
    stickyWeekHeaderBound = true;
    document.addEventListener('scroll', queueStickyWeekHeaderStateUpdate, { capture: true, passive: true });
    document.addEventListener('wheel', queueStickyWeekHeaderStateUpdate, { passive: true });
    document.addEventListener('touchmove', queueStickyWeekHeaderStateUpdate, { passive: true });
    window.addEventListener('resize', queueStickyWeekHeaderStateUpdate, { passive: true });
  }

  function queueStickyWeekHeaderStateUpdate() {
    if (stickyWeekHeaderFrame) return;
    stickyWeekHeaderFrame = window.requestAnimationFrame(() => {
      stickyWeekHeaderFrame = 0;
      updateStickyWeekHeaderState();
    });
  }

  function updateStickyWeekHeaderState() {
    const header = document.querySelector('.calendar-view .calendar-week-timeline-header');
    if (!header || !window.matchMedia('(max-width: 900px)').matches) {
      document.querySelectorAll('.calendar-week-timeline-header.is-stuck').forEach(item => item.classList.remove('is-stuck'));
      return;
    }
    const topValue = window.getComputedStyle(header).top;
    const stickyTop = Number.parseFloat(topValue) || 0;
    header.classList.toggle('is-stuck', header.getBoundingClientRect().top <= stickyTop + 0.5);
  }

  function priorityColor(priority) {
    return { 1: '#ef4444', 2: '#f59e0b', 3: '#10b981', 4: '#94a3b8' }[priority] || '#94a3b8';
  }

  function eventCountInRange(events, start, endExclusive) {
    return events.filter(event => event.start >= start && event.start < endExclusive).length;
  }

  function renderPeriodHeader(title, count) {
    return `<div class="calendar-period-header">
      <div class="calendar-period-title">${escapeHtml(title)}</div>
      <span class="badge calendar-period-count">${count}</span>
    </div>`;
  }

  function renderEmptyState(scope = 'range') {
    return `<section class="calendar-empty-state" aria-label="${escapeHtmlAttr(t('calendar.empty.title'))}">
      <span class="calendar-empty-icon" aria-hidden="true">${iconSvg('calendar-days')}</span>
      <div>
        <strong>${escapeHtml(t('calendar.empty.title'))}</strong>
        <p>${escapeHtml(t(`calendar.empty.${scope}`))}</p>
      </div>
    </section>`;
  }

  function renderEvent(event, compact = false) {
    const projectMarker = event.project ? markerHtml(event.project) : `<span class="project-dot" style="background:${escapeHtmlAttr(event.color)}"></span>`;
    const time = event.allDay ? '' : `<span class="calendar-event-time">${escapeHtml(formatTime(event.start))}</span>`;
    const statusClass = event.status === 'done' ? 'done' : event.status === 'in_progress' ? 'in-progress' : '';
    const priority = Math.min(4, Math.max(1, Number(event.priority || 3)));
    return `
      <div class="calendar-event ${statusClass} ${compact ? 'compact' : ''} status-${escapeHtmlAttr(event.status)}" data-status="${escapeHtmlAttr(event.status)}" data-calendar-todo-id="${escapeHtmlAttr(event.todoId)}" draggable="false" style="--calendar-event-color:${escapeHtmlAttr(event.color)};--calendar-priority-color:${escapeHtmlAttr(priorityColor(priority))}">
        ${projectMarker}
        ${time}
        <span class="calendar-event-title-row">
          <span class="calendar-event-priority" title="${escapeHtmlAttr(t('todo.priority'))}"><span class="calendar-event-priority-dot" style="background:${escapeHtmlAttr(priorityColor(priority))}"></span></span>
          <span class="calendar-event-title">${escapeHtml(event.title)}</span>
        </span>
      </div>`;
  }

  function renderMonth(events) {
    const monthStart = startOfMonth(anchorDate);
    const monthEnd = addMonths(monthStart, 1);
    const start = startOfMonthGrid(anchorDate);
    const byDay = eventsByDay(events);
    const weekdays = Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(new Date()), index));
    let html = renderPeriodHeader(formatMonthTitle(anchorDate), eventCountInRange(events, monthStart, monthEnd));
    html += `<div class="calendar-weekdays">${weekdays.map(day => `<div>${escapeHtml(new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(day))}</div>`).join('')}</div>`;
    html += '<div class="calendar-month-grid">';
    for (let index = 0; index < 42; index += 1) {
      const day = addDays(start, index);
      const key = dateKey(day);
      const dayEvents = byDay.get(key) || [];
      const visibleEvents = dayEvents.slice(0, 2);
      const selected = isSameDay(day, anchorDate);
      html += `
        <section class="calendar-day-cell ${day.getMonth() !== anchorDate.getMonth() ? 'outside-month' : ''} ${isToday(day) ? 'today' : ''} ${selected ? 'selected' : ''}" data-calendar-day="${escapeHtmlAttr(key)}" data-calendar-action="select-day" data-calendar-date="${escapeHtmlAttr(key)}">
          <button type="button" class="calendar-day-number" data-calendar-action="select-day" data-calendar-date="${escapeHtmlAttr(key)}" aria-pressed="${selected ? 'true' : 'false'}">${day.getDate()}</button>
          <div class="calendar-day-events">
            ${visibleEvents.map(event => renderEvent(event, true)).join('')}
            ${dayEvents.length > visibleEvents.length ? `<button type="button" class="calendar-more-btn" data-calendar-action="select-day" data-calendar-date="${escapeHtmlAttr(key)}">+${dayEvents.length - visibleEvents.length} ${escapeHtml(t('calendar.more'))}</button>` : ''}
          </div>
        </section>`;
    }
    const selectedEvents = byDay.get(dateKey(anchorDate)) || [];
    html += '</div>';
    html += `<section class="calendar-month-selected-day" aria-label="${escapeHtmlAttr(formatDayTitle(anchorDate))}">
      <div class="calendar-month-selected-header">
        <strong>${escapeHtml(formatDayTitle(anchorDate))}</strong>
        <span>${selectedEvents.length}</span>
      </div>
      <div class="calendar-month-selected-events">
        ${selectedEvents.length ? selectedEvents.map(event => renderEvent(event, false)).join('') : `<p>${escapeHtml(t('calendar.emptyMini'))}</p>`}
      </div>
    </section>`;
    if (!eventCountInRange(events, monthStart, monthEnd)) html += renderEmptyState('month');
    return html;
  }

  function renderWeek(events) {
    const start = startOfWeek(anchorDate);
    const end = addDays(start, 7);
    const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
    const byDay = eventsByDay(events);
    const dayEvents = days.map(day => byDay.get(dateKey(day)) || []);
    const dayAllDayEvents = dayEvents.map(items => items.filter(event => event.allDay));
    const dayTimedEvents = dayEvents.map(items => items.filter(event => !event.allDay));
    const hasAllDayEvents = dayAllDayEvents.some(items => items.length > 0);

    const desktopTimeline = `<div class="calendar-week-timeline" aria-label="${escapeHtmlAttr(t('calendar.weekTimeline'))}">
      <div class="calendar-week-timeline-header">
        <div class="calendar-week-timezone" aria-hidden="true"></div>
        ${days.map((day, index) => `<button type="button" class="calendar-week-timeline-day ${isToday(day) ? 'today' : ''}" data-calendar-action="open-day" data-calendar-date="${escapeHtmlAttr(dateKey(day))}">
          <span>${escapeHtml(new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(day))}</span>
          <strong>${escapeHtml(new Intl.DateTimeFormat(locale(), { day: '2-digit' }).format(day))}</strong>
          <em>${dayEvents[index].length}</em>
        </button>`).join('')}
      </div>
      ${hasAllDayEvents ? `<div class="calendar-week-all-day-row">
        <div class="calendar-hour-label">${escapeHtml(t('calendar.allDay'))}</div>
        ${dayAllDayEvents.map(items => `<div class="calendar-week-day-column calendar-event-list">${items.map(event => renderEvent(event, true)).join('')}</div>`).join('')}
      </div>` : ''}
      <div class="calendar-week-timeline-body">
        ${Array.from({ length: 24 }, (_, hour) => `<div class="calendar-week-hour-row">
          <div class="calendar-hour-label">${String(hour).padStart(2, '0')}:00</div>
          ${dayTimedEvents.map(items => {
            const slotEvents = items.filter(event => event.start.getHours() === hour);
            return `<div class="calendar-week-hour-cell ${slotEvents.length ? 'has-events' : ''}">
              ${slotEvents.length ? slotEvents.map(event => renderEvent(event, true)).join('') : ''}
            </div>`;
          }).join('')}
        </div>`).join('')}
      </div>
    </div>`;

    const count = eventCountInRange(events, start, end);
    return `${renderPeriodHeader(formatRangeTitle(start, addDays(end, -1)), count)}${count ? '' : renderEmptyState('week')}${desktopTimeline}`;
  }

  function renderDay(events) {
    const dayEvents = events.filter(event => isSameDay(event.start, anchorDate));
    const allDayEvents = dayEvents.filter(event => event.allDay);
    const timedEvents = dayEvents.filter(event => !event.allDay);
    const eventsByHour = new Map();
    for (const event of timedEvents) {
      const hour = event.start.getHours();
      if (!eventsByHour.has(hour)) eventsByHour.set(hour, []);
      eventsByHour.get(hour).push(event);
    }

    return `<section class="calendar-day-view">
      ${renderPeriodHeader(formatDayTitle(anchorDate), dayEvents.length)}
      ${dayEvents.length ? '' : renderEmptyState('day')}
      ${allDayEvents.length ? `<div class="calendar-all-day-row">
        <div class="calendar-hour-label">${escapeHtml(t('calendar.allDay'))}</div>
        <div class="calendar-event-list calendar-all-day-events">${allDayEvents.map(event => renderEvent(event)).join('')}</div>
      </div>` : ''}
      <div class="calendar-day-timeline" aria-label="${escapeHtmlAttr(t('calendar.dayTimeline'))}">
        ${Array.from({ length: 24 }, (_, hour) => {
          const slotEvents = eventsByHour.get(hour) || [];
          return `<div class="calendar-hour-slot ${slotEvents.length ? 'has-events' : ''}">
            <div class="calendar-hour-label">${String(hour).padStart(2, '0')}:00</div>
            <div class="calendar-hour-body">
              ${slotEvents.length ? slotEvents.map(event => renderEvent(event)).join('') : '<div class="calendar-hour-line" aria-hidden="true"></div>'}
            </div>
          </div>`;
        }).join('')}
      </div>
    </section>`;
  }


  function shiftAnchor(direction) {
    if (mode === 'month') anchorDate = addMonths(anchorDate, direction);
    else if (mode === 'week') anchorDate = addDays(anchorDate, direction * 7);
    else anchorDate = addDays(anchorDate, direction);
    persistAnchor();
  }

  function calendarDateAfterShift(date, direction) {
    if (mode === 'month') return addMonths(date, direction);
    if (mode === 'week') return addDays(date, direction * 7);
    return addDays(date, direction);
  }

  function renderCalendarBodyFor(date, events = lastCalendarEvents) {
    const previousAnchor = anchorDate;
    anchorDate = date;
    const body = mode === 'month'
      ? renderMonth(events)
      : mode === 'week'
        ? renderWeek(events)
        : renderDay(events);
    anchorDate = previousAnchor;
    return body;
  }

  async function navigateCalendarView(direction, { animated = false } = {}) {
    if (!direction || calendarViewAnimating) return;
    const shouldAnimate = animated
      && window.matchMedia('(max-width: 900px)').matches
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!shouldAnimate) {
      shiftAnchor(direction);
      renderTodos?.();
      return;
    }

    const surface = document.querySelector('.calendar-view .calendar-motion-surface');
    calendarViewAnimating = true;
    surface?.classList.add(direction > 0 ? 'is-exiting-next' : 'is-exiting-prev');
    await wait(150);
    calendarViewTransitionDirection = direction;
    shiftAnchor(direction);
    renderTodos?.();
    window.setTimeout(() => {
      calendarViewAnimating = false;
    }, 220);
  }

  function persistAnchor() {
    localStorage.setItem(ANCHOR_KEY, dateKey(anchorDate));
  }


  function wait(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  function setCalendarSwipeVisual(item, visualDx, rawDx, actionThreshold) {
    const progress = Math.min(1, Math.abs(rawDx) / Math.max(1, actionThreshold));
    item.style.setProperty('--swipe-x', `${visualDx}px`);
    item.style.setProperty('--swipe-progress', progress.toFixed(3));
    item.classList.toggle('swipe-right', visualDx > 0);
    item.classList.toggle('swipe-left', visualDx < 0);
    item.classList.toggle('swipe-ready', progress >= 1);
  }

  function cleanupCalendarSwipeVisual(item) {
    item.classList.remove('swiping', 'swipe-right', 'swipe-left', 'swipe-ready', 'swipe-settling', 'swipe-committing');
    item.style.removeProperty('--swipe-x');
    item.style.removeProperty('--swipe-progress');
    item.removeAttribute('data-swipe-right-label');
    item.removeAttribute('data-swipe-left-label');
  }

  function setCalendarViewSwipeVisual(surface, visualDx, rawDx, actionThreshold) {
    const progress = Math.min(1, Math.abs(rawDx) / Math.max(1, actionThreshold));
    surface.style.setProperty('--calendar-view-swipe-x', `${visualDx}px`);
    surface.style.setProperty('--calendar-view-swipe-progress', progress.toFixed(3));
  }

  function cleanupCalendarViewSwipeVisual(surface) {
    surface.classList.remove('is-dragging', 'is-settling', 'is-committing', 'is-exiting-next', 'is-exiting-prev', 'is-entering-next', 'is-entering-prev');
    surface.style.removeProperty('--calendar-view-swipe-x');
    surface.style.removeProperty('--calendar-view-swipe-progress');
  }

  function cleanupCalendarViewPreview(surface) {
    surface.querySelectorAll('.calendar-motion-preview').forEach(item => item.remove());
  }

  function ensureCalendarViewPreview(active) {
    const direction = active.dx < 0 ? 1 : -1;
    if (active.previewDirection === direction) return;
    cleanupCalendarViewPreview(active.surface);
    const preview = document.createElement('div');
    preview.className = `calendar-motion-preview ${direction > 0 ? 'is-next' : 'is-prev'}`;
    preview.setAttribute('aria-hidden', 'true');
    preview.innerHTML = renderCalendarBodyFor(calendarDateAfterShift(anchorDate, direction));
    active.surface.append(preview);
    active.previewDirection = direction;
  }

  function bindCalendarSwipeGestures() {
    if (calendarSwipeBound) return;
    calendarSwipeBound = true;
    const thresholdPx = 80;
    const thresholdRatio = 0.35;
    const lockThreshold = 10;

    document.addEventListener('click', (event) => {
      if (Date.now() > suppressCalendarClickUntil) return;
      if (!event.target?.closest?.('.calendar-event[data-calendar-todo-id]')) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    }, true);

    document.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || (event.pointerType && event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
      const item = event.target?.closest?.('.calendar-event[data-calendar-todo-id]');
      if (!item || !item.closest('.calendar-view')) return;
      if (window.matchMedia('(max-width: 900px)').matches && item.closest('.calendar-month-grid')) return;
      calendarSwipeActive = {
        item,
        id: item.dataset.calendarTodoId,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        dx: 0,
        dy: 0,
        locked: null,
        swiped: false,
      };
    }, { passive: true });

    document.addEventListener('pointermove', (event) => {
      const active = calendarSwipeActive;
      if (!active || event.pointerId !== active.pointerId) return;
      active.dx = event.clientX - active.startX;
      active.dy = event.clientY - active.startY;
      if (!active.locked) {
        const absX = Math.abs(active.dx);
        const absY = Math.abs(active.dy);
        if (absX < lockThreshold && absY < lockThreshold) return;
        active.locked = absX > absY * 1.25 ? 'horizontal' : 'vertical';
        if (active.locked === 'vertical') return;
        active.item.setAttribute('data-swipe-right-label', `↗ ${t('todo.status.inProgress')}`);
        active.item.setAttribute('data-swipe-left-label', `✓ ${t('todo.status.done')}`);
        active.item.classList.add('swiping');
      }
      if (active.locked !== 'horizontal') return;
      event.preventDefault();
      const actionThreshold = Math.max(thresholdPx, active.item.clientWidth * thresholdRatio);
      const maxDx = active.item.clientWidth || Math.abs(active.dx);
      const visualDx = Math.max(-maxDx, Math.min(maxDx, active.dx));
      setCalendarSwipeVisual(active.item, visualDx, active.dx, actionThreshold);
      active.swiped = true;
    }, { passive: false });

    const finish = async (event) => {
      const active = calendarSwipeActive;
      if (!active || event.pointerId !== active.pointerId) return;
      calendarSwipeActive = null;
      const item = active.item;
      const actionThreshold = Math.max(thresholdPx, item.clientWidth * thresholdRatio);
      const shouldAct = active.locked === 'horizontal' && Math.abs(active.dx) >= actionThreshold;
      if (active.swiped || shouldAct) suppressCalendarClickUntil = Date.now() + 450;
      if (active.locked === 'horizontal') event.preventDefault();
      if (!shouldAct) {
        if (active.swiped) {
          item.classList.add('swipe-settling');
          window.requestAnimationFrame(() => setCalendarSwipeVisual(item, 0, 0, actionThreshold));
          await wait(180);
        }
        cleanupCalendarSwipeVisual(item);
        return;
      }
      item.classList.add('swipe-committing');
      setCalendarSwipeVisual(item, active.dx < 0 ? -item.clientWidth : item.clientWidth, active.dx, actionThreshold);
      await wait(130);
      cleanupCalendarSwipeVisual(item);
      await setTodoStatus?.(active.id, active.dx < 0 ? 'done' : 'in_progress');
    };

    document.addEventListener('pointerup', finish, { passive: false });
    document.addEventListener('pointercancel', finish, { passive: false });
  }

  function canStartCalendarViewSwipe(target) {
    const calendarView = target?.closest?.('.calendar-view');
    if (!calendarView || !window.matchMedia('(max-width: 900px)').matches) return null;
    if (target.closest('.calendar-toolbar')) return null;
    if (target.closest('.calendar-event[data-calendar-todo-id]')) return null;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return null;
    return calendarView;
  }

  function bindCalendarViewSwipeNavigation() {
    if (calendarViewSwipeBound) return;
    calendarViewSwipeBound = true;
    const actionThreshold = 36;
    const lockThreshold = 8;

    document.addEventListener('click', (event) => {
      if (Date.now() > suppressCalendarViewClickUntil) return;
      if (!event.target?.closest?.('.calendar-view')) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    }, true);

    document.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || (event.pointerType && event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
      if (!canStartCalendarViewSwipe(event.target)) return;
      const surface = document.querySelector('.calendar-view .calendar-motion-surface');
      if (!surface || calendarViewAnimating) return;
      cleanupCalendarViewSwipeVisual(surface);
      cleanupCalendarViewPreview(surface);
      try {
        surface.setPointerCapture?.(event.pointerId);
      } catch (_error) {
        // Pointer capture is best-effort; swipe still works without it.
      }
      calendarViewSwipeActive = {
        surface,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        dx: 0,
        dy: 0,
        locked: null,
        swiped: false,
      };
    }, { passive: true });

    document.addEventListener('pointermove', (event) => {
      const active = calendarViewSwipeActive;
      if (!active || event.pointerId !== active.pointerId) return;
      active.dx = event.clientX - active.startX;
      active.dy = event.clientY - active.startY;
      if (!active.locked) {
        const absX = Math.abs(active.dx);
        const absY = Math.abs(active.dy);
        if (absX < lockThreshold && absY < lockThreshold) return;
        active.locked = absX > absY * 1.1 ? 'horizontal' : 'vertical';
        if (active.locked !== 'horizontal') return;
        active.surface.classList.add('is-dragging');
      }
      if (active.locked !== 'horizontal') return;
      event.preventDefault();
      ensureCalendarViewPreview(active);
      const maxDx = active.surface.clientWidth || Math.abs(active.dx);
      const visualDx = Math.max(-maxDx, Math.min(maxDx, active.dx));
      setCalendarViewSwipeVisual(active.surface, visualDx, active.dx, actionThreshold);
      active.swiped = true;
    }, { passive: false });

    const finish = async (event) => {
      const active = calendarViewSwipeActive;
      if (!active || event.pointerId !== active.pointerId) return;
      calendarViewSwipeActive = null;
      try {
        active.surface.releasePointerCapture?.(event.pointerId);
      } catch (_error) {
        // Pointer capture may already be released after cancel/end.
      }
      const distanceThreshold = Math.min(actionThreshold, (active.surface.clientWidth || actionThreshold) * 0.12);
      const shouldNavigate = active.locked === 'horizontal'
        && Math.abs(active.dx) >= distanceThreshold;
      if (active.swiped || shouldNavigate) suppressCalendarViewClickUntil = Date.now() + 450;
      if (active.locked === 'horizontal') event.preventDefault();
      if (active.locked !== 'horizontal') return;
      if (!shouldNavigate) {
        active.surface.classList.add('is-settling');
        setCalendarViewSwipeVisual(active.surface, 0, 0, actionThreshold);
        await wait(180);
        cleanupCalendarViewPreview(active.surface);
        cleanupCalendarViewSwipeVisual(active.surface);
        return;
      }

      const direction = active.dx < 0 ? 1 : -1;
      const width = active.surface.clientWidth || Math.abs(active.dx);
      calendarViewAnimating = true;
      active.surface.classList.add('is-committing');
      setCalendarViewSwipeVisual(active.surface, direction > 0 ? -width : width, active.dx, actionThreshold);
      await wait(160);
      cleanupCalendarViewPreview(active.surface);
      cleanupCalendarViewSwipeVisual(active.surface);
      calendarViewTransitionDirection = 0;
      shiftAnchor(direction);
      renderTodos?.();
      window.setTimeout(() => {
        calendarViewAnimating = false;
      }, 220);
    };

    document.addEventListener('pointerup', finish, { passive: false });
    document.addEventListener('pointercancel', finish, { passive: false });
  }

  function bindActions() {
    if (actionsBound) return;
    actionsBound = true;
    document.addEventListener('click', (event) => {
      const calendarView = event.target?.closest?.('.calendar-view');
      if (!calendarView) return;

      const isMobileCalendar = window.matchMedia('(max-width: 900px)').matches;
      const calendarTodo = event.target?.closest?.('[data-calendar-todo-id]');
      if (calendarTodo && !(isMobileCalendar && calendarTodo.closest('.calendar-month-grid'))) {
        event.preventDefault();
        event.stopImmediatePropagation?.();
        openTodo?.(calendarTodo.dataset.calendarTodoId);
        return;
      }

      const modeButton = event.target?.closest?.('[data-calendar-mode]');
      if (modeButton) {
        event.preventDefault();
        mode = normalizeMode(modeButton.dataset.calendarMode);
        localStorage.setItem(MODE_KEY, mode);
        renderTodos?.();
        return;
      }

      const actionButton = event.target?.closest?.('[data-calendar-action]');
      if (!actionButton) return;
      const action = actionButton.dataset.calendarAction;
      event.preventDefault();
      if (action === 'prev' || action === 'next') {
        void navigateCalendarView(action === 'next' ? 1 : -1, { animated: isMobileCalendar });
        return;
      }
      if (action === 'today') {
        anchorDate = startOfDay(new Date());
        persistAnchor();
      }
      if (action === 'toggle-controls') {
        controlsOpen = !controlsOpen;
        localStorage.setItem(CONTROLS_KEY, controlsOpen ? 'true' : 'false');
      }
      if (action === 'select-day') {
        const date = parseStoredDate(actionButton.dataset.calendarDate);
        if (date) {
          anchorDate = date;
          if (!isMobileCalendar && actionButton.closest('.calendar-month-grid')) {
            mode = 'day';
            localStorage.setItem(MODE_KEY, mode);
          }
          persistAnchor();
        }
      }
      if (action === 'open-day') {
        const date = parseStoredDate(actionButton.dataset.calendarDate);
        if (date) {
          anchorDate = date;
          mode = 'day';
          localStorage.setItem(MODE_KEY, mode);
          persistAnchor();
        }
      }
      renderTodos?.();
    });
  }

  function cleanupCalendarView() {
    toolbarResizeObserver?.disconnect();
    if (stickyWeekHeaderFrame) {
      window.cancelAnimationFrame(stickyWeekHeaderFrame);
      stickyWeekHeaderFrame = 0;
    }
    if (stickyWeekHeaderBound) {
      document.removeEventListener('scroll', queueStickyWeekHeaderStateUpdate, true);
      document.removeEventListener('wheel', queueStickyWeekHeaderStateUpdate);
      document.removeEventListener('touchmove', queueStickyWeekHeaderStateUpdate);
      window.removeEventListener('resize', queueStickyWeekHeaderStateUpdate);
      stickyWeekHeaderBound = false;
    }
    document.querySelectorAll('.calendar-week-timeline-header.is-stuck').forEach(item => item.classList.remove('is-stuck'));
  }

  function renderCalendarView({ todos, projects, hideDone }) {
    bindActions();
    bindCalendarSwipeGestures();
    bindCalendarViewSwipeNavigation();
    scheduleToolbarLayout();
    scheduleStickyWeekHeaderState();
    const events = normalizeEvents(todos, projects, hideDone);
    lastCalendarEvents = events;
    const body = renderCalendarBodyFor(anchorDate, events);
    const transitionDirection = calendarViewTransitionDirection;
    calendarViewTransitionDirection = 0;
    const transitionClass = transitionDirection > 0
      ? 'is-entering-next'
      : transitionDirection < 0
        ? 'is-entering-prev'
        : '';

    return `<section class="calendar-view" aria-label="${escapeHtmlAttr(t('calendar.title'))}">
      ${renderToolbar()}
      <div class="calendar-motion-surface ${transitionClass}">${body}</div>
    </section>`;
  }

  return { renderCalendarView, cleanupCalendarView };
}

# Calendar View Plan

Branch: `feature/calendar-view`
Base: `nia-todo-next`

## Goal

Add a global calendar view to the sidebar so todos with `due_date` are visible in a familiar calendar layout. The first implementation should be todo-first, offline-capable, and prepared for later external calendar display/import without forcing that integration into the initial UI architecture.

## Product Shape

### Sidebar entry

Add a new global view in the existing `Ansicht` sidebar group:

- Dashboard
- Filter
- **Kalender**
- In progress
- Erledigt

Suggested filter key: `calendar`.

The calendar view should respect the active workspace like the dashboard/focus views do. Project-specific navigation remains separate.

### Calendar modes

MVP should support:

1. **Month view**
   - Default on desktop.
   - Good overview of due dates.
   - Day cells show compact todo chips/events.
   - Overflow becomes `+N` and opens/scrolls a day agenda.

2. **Week view**
   - Useful for planning the current week.
   - Shows day columns with ordered todo events.
   - On mobile, this can become a horizontal day strip plus agenda list.

3. **Day view**
   - Focused view for one selected day.
   - Shows all due todos for that date, including time labels when available.
   - Opens from month/week day clicks and via the mode switch.

4. **Agenda view**
   - Mobile-friendly default or fallback.
   - Group due todos by day.
   - Handles dense calendars better than squeezing a full month grid.

I would not start with a full hourly day planner unless we decide that `due_date` with time should behave like real appointment blocks. The MVP day view should be a clean day agenda first.

### Controls

Top controls for the calendar surface:

- Previous / Today / Next
- View switch: Month / Week / Agenda
- Optional filter chips:
  - Hide done
  - Project
  - Priority
  - External calendars later

Persist the chosen calendar mode in localStorage, e.g. `nia-calendar-view-mode`.

## Todo Event Mapping

Todos already have `due_date`, `status`, `priority`, `project_id`, `section_id`, `is_pinned`, and project metadata. That is enough for the first calendar view.

Mapping rules:

- Only todos with `due_date` appear.
- Completed todos follow the existing hide-done preference.
- Date-only due dates render as all-day style chips.
- Date-time due dates render with a time label.
- Overdue todos should remain visible in the calendar at their due date, but the agenda can also show an `Überfällig` group before today.
- Recurring todos should initially show only the concrete stored due date. Future generated occurrences need a separate expansion layer.

Suggested visual encoding:

- Project color/icon as leading marker.
- Status affects tone:
  - pending: normal
  - in_progress: accented/flame indicator
  - done: muted/checked if visible
- Priority can be a small `P1/P2/P3` pill or subtle border.

Clicking/tapping an event should open the existing todo detail/edit modal via the current todo feature instead of creating a separate calendar-specific editor.

## Frontend Architecture

Keep this as a dedicated frontend feature instead of bloating `app-rendering.js` further.

Suggested files:

- `web/static/js/features/calendar-view.js`
  - date math helpers
  - event normalization from todos/projects
  - render month/week/agenda HTML
  - calendar action binding
- `web/static/css/13-calendar-view.css`
  - calendar-specific layout only
  - reuse `.btn`, `.ui-nav-pill`, `.ui-section-*`, badges/chips, icon primitives
- i18n keys in:
  - `web/static/i18n/de.json`
  - `web/static/i18n/en.json`

Integration points:

- Add `calendar` to `baseFilters` in `navigation.js` and `app-lifecycle.js` restore logic.
- Add sidebar button in `web/index.html` with `data-filter="calendar"` and a `calendar-days` icon.
- Extend stats/nav active handling in `app-rendering.js` or move global nav state into a helper.
- In `renderTodos()`, when `currentFilter === 'calendar'`, render the calendar surface instead of the normal todo list.
- Pass `showTodoModal`/`editTodo` or an equivalent open-detail callback into the calendar feature so event clicks reuse existing todo behavior.

Important: The calendar should be a view over existing local state, not a new backend dependency. It must work from IndexedDB during offline/cold-start just like the list views.

## Layout Proposal

### Desktop month

- Header: title (`Juli 2026`), prev/today/next, mode switch.
- 7-column grid.
- Fixed weekday header.
- Each day cell:
  - date number
  - up to 3 visible todo chips
  - `+N weitere` overflow button if needed
- Optional right-side or bottom agenda panel for selected day.

### Desktop week

- 7 day columns.
- Each column shows due todos sorted by time, priority, status.
- Date-time todos grouped before date-only todos if there is a time.

### Mobile

- Avoid a squeezed desktop month grid as the primary interaction.
- Use:
  - compact month strip / week strip for navigation
  - agenda list below
- Month grid can still exist, but should degrade into tappable day dots/counts.
- No horizontal body overflow.

## External Calendar Preparation

Tobi mentioned Apple/Google/other calendars. I would split this into a clean second layer instead of mixing it into todo rendering.

### Concept

Create an internal normalized calendar event model:

```js
{
  id: 'todo:123' | 'external:<source>:<eventId>',
  source: 'todo' | 'google' | 'apple' | 'ics' | 'caldav',
  calendarId: string,
  title: string,
  start: string,
  end: string | null,
  allDay: boolean,
  color: string | null,
  status: string | null,
  readonly: boolean,
  rawRef: object | null
}
```

Todos become one source adapter: `todoCalendarSource`.
External calendars become separate source adapters later.
The view renders normalized events and only special-cases actions, e.g. todo click opens todo modal, external click opens read-only event detail.

### Recommended external integration path

1. **ICS URL subscriptions** (lowest friction)
   - Read-only calendar feeds.
   - Server fetches/caches events.
   - Good for Apple shared/public calendar URLs and many generic calendars.

2. **CalDAV subscriptions/accounts**
   - Supports many providers, including iCloud with app password.
   - More work: credentials, refresh sync, recurring event expansion.
   - Should be read-only first.

3. **Google Calendar OAuth**
   - Best UX for Google.
   - Requires OAuth app config, scopes, token storage, refresh handling.
   - Read-only first; write/sync later only if we really want it.

I would avoid importing external events as todos. Better: display external events next to todos. Import can be a deliberate action later (`Als Todo übernehmen`) to avoid polluting tasks and creating sync confusion.

### Backend preparation for external calendars

Not needed for MVP. For the next step, likely tables:

- `calendar_accounts`
  - user_id, provider, display_name, auth metadata/token refs
- `calendar_sources`
  - account_id/user_id, name, color, enabled, readonly, sync_url/provider_calendar_id
- `calendar_events_cache`
  - source_id, external_id, title, start_at, end_at, all_day, location, description, updated_at, raw_json

Security note: OAuth tokens/app passwords must be encrypted or otherwise handled like existing secrets, not stored casually in plain app config.

## Implementation Phases

### Phase 1: Todo calendar MVP

- Add `calendar` route/filter and sidebar nav.
- Add calendar feature module.
- Render month/week/agenda from existing todos.
- Persist calendar mode and anchor date.
- Event click opens existing todo modal.
- Add CSS module and service-worker precache entry.
- Add i18n keys.

No backend migration required.

### Phase 2: UX hardening

- Dense-day overflow handling.
- Selected-day agenda.
- Mobile layout polish.
- Empty states:
  - no due todos
  - no due todos in current range
- Keyboard/focus handling for calendar navigation.

### Phase 3: External calendar read-only foundation

- Introduce normalized calendar event source layer.
- Keep todo source local/offline.
- Add backend cache endpoints for external events only when a provider/source exists.
- Add source visibility toggles in the calendar toolbar.

### Phase 4: Provider integrations

Order recommendation:

1. ICS subscriptions
2. CalDAV/iCloud
3. Google OAuth

All read-only first. Write-back or two-way sync should be a separate decision, because it has much sharper edge cases.

## Open Questions

1. Should the calendar default to month view on mobile too, or agenda/week on small screens?
2. Should done todos appear when `Erledigte anzeigen` is enabled, or should calendar have its own done toggle?
3. Should date-only due dates be displayed before or after timed todos in week/agenda?
4. For external calendars: display-only first is my recommendation. Do we want any `Als Todo übernehmen` action in the first external phase?

## Risks / Edge Cases

- Timezone handling: due dates may be ISO strings or date-like strings. Normalize carefully and avoid shifting date-only todos across days.
- Recurrence: current recurring todos should not fake future occurrences until there is a robust expansion rule.
- Mobile density: month grids get cramped fast; agenda-first mobile is safer.
- `app-rendering.js` is already large. Calendar code should be isolated.
- Service worker precache must include new CSS/JS modules or native/offline launches can break after release.

## Recommended First Commit Scope

For the actual implementation, start with Phase 1 plus enough Phase 2 to feel usable:

- Branch: `feature/calendar-view`
- Global nav entry
- Month/week/day/agenda renderer
- LocalStorage mode persistence
- Todo event click -> existing modal
- Responsive CSS
- i18n
- Syntax-only checks first; broader test/build only when Tobi explicitly asks.

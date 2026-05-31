# Design Concept

This document is the UI design reference for nia-todo. New UI work should follow it before adding new patterns.

Goals:

- calm, focused, task-first interface
- consistent controls across web, PWA, Windows, and Android wrappers
- mobile-first behavior without making desktop feel sparse
- accessible sizing, clear hierarchy, and predictable actions

## Principles

1. **One primary action per surface**
   - Each modal/card should have one obvious primary action.
   - Secondary and destructive actions must be visually distinct.

2. **Cards instead of raw form stacks**
   - Prefer titled cards/sections over long groups separated only by `<hr>`.
   - A card should explain what it controls and contain related actions only.

3. **Mobile is not a squeezed desktop**
   - Mobile modals are fullscreen.
   - Actions stack vertically and use full width.
   - Navigation may become horizontally scrollable chips when many sections exist.

4. **No ad-hoc inline styling**
   - Avoid `style="..."` for new UI except unavoidable dynamic show/hide states.
   - Add reusable classes in `web/static/style.css`.

5. **Existing IDs are contracts**
   - Existing JS-bound element IDs should not be renamed casually.
   - If markup is redesigned, keep IDs stable unless the JS is changed in the same commit.

## Layout

### Desktop

Use desktop space for overview and grouping:

- Modals with complex settings may use a wider layout: `min(960px, 96vw)`.
- Complex settings should use a 2-column structure:
  - left: section navigation
  - right: scrollable content sections
- Content cards should use `16-22px` internal padding depending on density.
- Section gaps should usually be `12-18px`.

### Mobile

Mobile behavior:

- Standard modals become fullscreen.
- Content scrolls inside the modal body, not behind it.
- Section navigation with many entries should be a one-line horizontal chip row:
  - `overflow-x: auto`
  - `flex-wrap: nowrap`
  - touch scrolling enabled
- Avoid horizontal page overflow; verify `body.scrollWidth === window.innerWidth`.

## Cards and Sections

Use generic UI composition primitives for new card-based areas:

```html
<section class="ui-section-card">
  <div class="ui-section-heading">
    <div class="ui-section-icon" data-icon="shield"></div>
    <div>
      <h4>Section title</h4>
      <p>Short explanation of what this section controls.</p>
    </div>
  </div>
  <!-- controls -->
</section>
```

Settings currently use compatible settings-specific aliases (`.settings-section-card`, `.settings-section-heading`, `.settings-section-icon`). Keep them visually aligned with the generic `.ui-section-*` primitives; do not create separate icon-tile sizing or centering rules unless the component genuinely needs a different size.

Guidelines:

- Heading: icon + title + short hint.
- Put `data-icon` directly on the icon tile (`.ui-section-icon` / `.settings-section-icon`) so the shared icon hydrator owns the SVG markup.
- Use only icon names available in `web/static/js/icons/lucide-icons.js`; unknown names intentionally fall back to a circle and should be treated as a bug in user-facing UI.
- Keep hints short; one sentence is enough.
- Use nested subcards for dense areas such as security, 2FA, or app integrations.
- Do not mix unrelated controls in the same card.

## Buttons

### Semantics

- `.btn-primary` — the main positive action.
- `.btn-secondary` — neutral action, navigation, retry, utility.
- `.btn-danger` — destructive or security-sensitive action.
- `.btn-small` — compact row-level action, not a primary modal action.

### Size

Desktop:

- Normal buttons: `38px` height.
- Small row actions: `34px` height.
- Button text should stay centered and readable.

Mobile:

- Buttons inside modals/cards should usually be full width.
- Normal mobile action height: `42px` minimum.
- Stack actions vertically with `8-10px` gap.

### Grouping

Desktop:

- Related action rows may use a responsive grid.
- Security/action clusters can use 2 columns when labels are long.
- Single actions should not stretch across the whole card unless that is intentional.

Mobile:

- Action rows become `1fr` stacked lists.
- Avoid two tiny buttons side by side unless they are very short and equally important.

### Ordering

Typical modal order:

1. neutral close/cancel
2. retry/back if relevant
3. primary action
4. destructive action only when context clearly requires it

For mobile, keep the most likely action easiest to hit. Destructive actions must not be visually ambiguous.

## Modals

### Standard Modal

Use for focused create/edit flows:

- max width around `520px`
- title in `<h3>`
- close X on mobile/fullscreen contexts
- footer actions in `.modal-actions`

### Complex Modal

Use for settings, multi-section configuration, or review flows:

- custom content class, e.g. `.settings-modal-content`
- sticky or clearly separated header
- scrollable body
- stable footer actions

### Mobile Modal

- fullscreen
- no background overlay needed
- header and footer fixed by flex layout
- body scrolls independently
- use safe-area padding at the bottom

## Forms

- Use `.form-group` for label + input/select/textarea.
- Inputs should be full-width inside their container.
- Use `.ui-field-grid` for grouped form fields; add `.two-columns` only when fields are logically parallel on desktop.
- On mobile, form grids collapse to one column.
- Help text should use muted color and `12px` size.
- Errors use `.settings-field-error` or equivalent danger style.
- Success messages use `.settings-field-success` or equivalent success style.

## Dropdowns, Selects, and Menus

Dropdowns are a first-class UI primitive in nia-todo. They must not look like browser-default controls on desktop. The implementation sequence and test gates are defined in [UI Dropdown Migration Plan](ui-dropdown-migration-plan.md).

### Non-negotiable Rule

User-facing dropdowns must use the shared custom dropdown/menu primitive.

Native `<select>` elements are allowed only as:

- a hidden source of truth for existing form integration
- a progressive-enhancement fallback when JavaScript fails
- a platform fallback when a custom menu would be less accessible or technically unsafe

If a native `<select>` remains visible in a redesigned user-facing surface, the UI is not finished.

### Primitive Names

Use one shared primitive family for all dropdown-like controls:

- `.ui-select` — field-sized single-value selector
- `.ui-select-trigger` — visible closed control
- `.ui-select-value` — selected label/content
- `.ui-select-chevron` — disclosure indicator
- `.ui-select-menu` — popup container
- `.ui-select-option` — selectable row
- `.ui-select-option.is-selected` — current selected option
- `.ui-select-option.is-highlighted` — keyboard/hover active option
- `.ui-select-option.is-disabled` — unavailable option
- `.ui-menu` — action menu variant for non-form actions
- `.ui-menu-item` — action row
- `.ui-menu-separator` — visual group separator

Do not add component-specific dropdown class families such as `.project-select-*`, `.settings-dropdown-*`, or `.todo-menu-*` unless they only add tiny layout hooks around the shared primitive. Visual styling belongs in the shared primitive.

### Visual Contract

Closed dropdown trigger:

- height: `40px` desktop, `42px` mobile minimum
- border radius: `12-13px`
- horizontal padding: `12px` left, `38-42px` right when a chevron is present
- background: same calm card/input language as other form fields
- border: subtle default border, accent border on hover/focus
- focus ring: visible accent ring, matching other inputs
- selected label: `13-14px`, `650-700` weight for short values
- icon/color chip, when present: left aligned, `16-20px`, never stretched
- chevron: right aligned, muted, rotates or changes opacity when open

Open menu:

- fixed-position or portal-style placement when inside modals to avoid clipping by scroll containers
- minimum width equal to the trigger width
- maximum width: `min(280px, calc(100vw - 24px))` unless the content requires more
- maximum height: `min(320px, calc(100vh - 24px))`, scroll internally
- border radius: `14px`
- padding: `6px`
- border and background must match modal/card elevation
- shadow must make it read as a floating layer without feeling heavy
- z-index must sit above the current modal body but below global critical overlays

Option rows:

- min height: `36px` desktop, `40px` mobile
- padding: `8px 10px`
- gap: `8px`
- label must never overlap icon, badge, checkmark, or chevron
- long labels truncate with ellipsis unless multiline is explicitly required
- selected option shows a checkmark or selected state, not only color
- destructive menu actions use danger color and must be separated from neutral actions
- disabled options remain visible only when that teaches the user why they cannot pick them; otherwise hide them

### Behavior Contract

All custom dropdowns/menus must support:

- click/tap trigger opens and closes the menu
- outside click closes the menu
- `Escape` closes the menu and returns focus to the trigger
- `Enter`/`Space` opens the menu from the trigger
- arrow keys move the highlighted option
- `Enter` selects the highlighted option
- `Tab` leaves the control without trapping focus
- opening one dropdown closes any other open dropdown
- selection updates the hidden native `<select>`/input and dispatches a `change` event when existing code expects one
- menu placement recalculates on open, scroll, resize, and orientation change
- scrollable modal bodies must not clip menus

### Accessibility Contract

For select-like controls:

- trigger uses `role="combobox"` or a button pattern with correct `aria-haspopup="listbox"`
- menu uses `role="listbox"`
- options use `role="option"`
- selected option uses `aria-selected="true"`
- disabled option uses `aria-disabled="true"`
- trigger exposes `aria-expanded`
- trigger references the menu with `aria-controls` when possible
- labels remain real `<label>` elements tied to the hidden native field or the visible trigger

For action menus:

- trigger uses `aria-haspopup="menu"`
- menu uses `role="menu"`
- items use `role="menuitem"` unless a stronger semantic element is needed

Keyboard behavior must be tested. A pretty dropdown that cannot be used without a mouse is a regression.

### Mobile Contract

Mobile dropdowns still use the shared visual language, but placement may adapt:

- short menus may open as anchored popovers
- long menus may use a bottom-sheet style variant of the same primitive
- touch targets are at least `40-42px` high
- menu width must not cause horizontal page overflow
- the page/body must not become horizontally scrollable
- dropdowns inside fullscreen modals must remain reachable above the fixed footer actions

Do not fall back to ugly native mobile selects just because implementation is inconvenient. Native fallback is allowed only when the custom version is measurably worse for accessibility or platform behavior.

### Searchable and Large Lists

For lists with more than roughly 12 options, consider a searchable variant:

- `.ui-select-search` at the top of the menu
- filtering keeps keyboard highlight predictable
- empty state row explains there are no matches
- search input must not break `Escape`, outside-click, or modal focus behavior

Use this for project/workspace/user lists if they become long. Do not invent a separate autocomplete visual style.

### Required Migration Targets

These surfaces must use the shared dropdown/menu primitive before the redesign is considered complete:

- Todo modal: priority, status, project, section
- Project modal: workspace display, parent project
- Workspace modal: any icon/color/category selector that behaves like a menu
- Settings modal: language, notification/native-app options, theme/accent choices where applicable
- Todo cards/list: status and snooze popovers should be migrated or aligned to the same `.ui-menu` option-row styling
- Project sharing/member actions if they expose row-level action menus
- Admin user/config screens if they are part of the same release scope

### Existing Native Select Handling

When replacing an existing `<select>`:

1. Keep the original element ID if JavaScript already depends on it.
2. Visually hide the native select with an accessible utility class, not `display:none`, if the label relationship depends on it.
3. Render the custom `.ui-select` next to it or hydrate it from JavaScript.
4. Keep the native select value synchronized both ways.
5. Dispatch `change` on the native select after custom selection.
6. Preserve disabled/read-only behavior.
7. Preserve form reset behavior.
8. Add tests for selection, keyboard behavior, outside click, and modal clipping.

### Done Criteria

A dropdown migration is done only when all of this is true:

- no visible browser-default select remains in the target surface on desktop
- desktop and mobile screenshots show the same design language
- keyboard behavior works
- outside-click and `Escape` close the menu
- menu is not clipped inside modals
- long labels do not overlap controls
- German and English labels both fit or truncate cleanly
- hidden native fields still update existing save logic
- Playwright coverage exists for at least one representative form dropdown and one action menu
- `git diff --check` passes

## Lists and Todo Cards

Todo cards in the main dashboard/list should follow the same calm card language as modals:

- No vertical divider beside grouped todos in the dashboard; project grouping should be expressed through spacing, group headers, and cards.
- Keep row actions available on mobile because native/gesture tests and wrapper flows rely on them.
- Use compact badges/chips for pinned, in-progress, due, overdue, and reminder metadata.
- Render reminder chips from both `todo.remind_at` and the first reminder in `todo.reminders` because API responses may carry reminders in the related collection.
- Todo-list descriptions are previews: normalize multiline text to a single-line ellipsis, but still render safe inline Markdown (`**bold**`, `*italic*`, code, safe links); full multiline text belongs in the edit/detail modal.
- Status and snooze popovers should use a vertical grid, adequate minimum width, and no text overlap.
- Preserve existing DOM classes, IDs, and JS handlers unless the JS is updated in the same commit.

## Navigation

### Sidebar / Section Navigation

Desktop:

- Vertical navigation is appropriate when there are 4+ settings sections.
- Each item should have icon + label.
- Hover states should be subtle, not noisy.

Mobile:

- For settings-like modals, prefer horizontal scrollable chips.
- Do not wrap many navigation chips into multiple rows unless the content is extremely short.
- Ensure the nav itself scrolls horizontally instead of widening the page.

## BrainDump UX

BrainDump should feel immediate and voice-first.

- Tapping the microphone FAB opens the modal and starts recording immediately.
- There must be no separate "start recording" step.
- During recording, show only the action to finish/process plus close/cancel.
- Closing during recording cancels the recording; it must not silently process.
- After results/errors, show retry as "speak again" and the accept action for selected candidates.

## Notifications and Native App Settings

- Browser-only sections must be hidden in native contexts if not applicable.
- Native-only app sections must be hidden in browser/PWA contexts.
- Empty cards are not allowed; hide the whole card and its nav entry.

## Responsiveness Checklist

Before considering UI work ready:

- Desktop viewport around `1280x900` works.
- Mobile viewport around `390x844` works.
- No horizontal body overflow on mobile.
- Buttons are not clipped and have consistent height.
- Hidden/inapplicable sections do not leave empty cards.
- The same flow works with German and English labels.

## Implementation Checklist

For every new UI change:

- Reuse existing `.btn`, `.form-group`, `.modal-*`, `.ui-section-*`, `.ui-field-grid`, `.ui-select`, `.ui-menu`, badge/chip, and card classes where possible.
- Prefer extending shared primitives over appending component-specific override blocks.
- If a visual fix applies to more than one component, move it into the shared primitive instead of patching only the current screen.
- Do not leave visible browser-default selects/dropdowns in redesigned user-facing surfaces.
- Add i18n keys for all persistent user-facing labels.
- Avoid inline styles for layout and spacing.
- Keep JS-bound IDs stable.
- Test at least one desktop and one mobile viewport with Playwright or a browser.
- For dropdown/menu work, test keyboard behavior, outside-click, `Escape`, hidden native value sync, and modal clipping.
- Run syntax/format checks matching the touched files.

## Current Reference Patterns

- User Settings modal: wide settings modal, section nav, section cards, consistent button groups.
- Project/Workspace modals: compact entity modal pattern using shared `.ui-section-*` cards, `.ui-field-grid`, and the same title/icon tile sizing as Todo Modal.
- BrainDump modal: voice-first immediate recording flow.
- Admin UI: card-based configuration sections and compact admin controls.

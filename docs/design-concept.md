# Design Concept

This document is the UI design reference for nia-todo. New UI work should follow these primitives before adding new patterns.

## Goals

- calm, focused, task-first interface
- consistent controls across web, PWA, Windows, and Android wrappers
- mobile-first behavior without making desktop feel sparse
- accessible sizing, clear hierarchy, and predictable actions
- fewer one-off visuals: shared primitives first, component CSS only for real layout/content behavior

## Core Principles

1. **One primary action per surface**
   - Each modal/card should have one obvious primary action.
   - Secondary and destructive actions must be visually distinct.
   - Destructive actions must never look like a neutral confirmation.

2. **Cards and sections over raw stacks**
   - Prefer titled cards/sections over long control groups separated only by `<hr>`.
   - A card should contain related controls only and explain what they affect.
   - Avoid nested box-in-box layouts unless the grouping adds real comprehension.

3. **Mobile is not a squeezed desktop**
   - Mobile modals are fullscreen.
   - Actions usually stack vertically and use full width.
   - Section navigation with many items becomes horizontally scrollable chips.
   - No horizontal body overflow.

4. **Shared primitives over local patches**
   - Reuse `.btn`, `.ui-field`, `.ui-select`, `.ui-menu`, `.ui-section-*`, `.ui-detail-*`, `.ui-nav-pill`, badges/chips, and card primitives.
   - Component classes own layout and content behavior, not duplicated button/dropdown/field visuals.
   - If a fix applies to multiple components, move it into the shared primitive.

5. **Existing IDs are contracts**
   - Existing JS-bound IDs should not be renamed casually.
   - If markup changes, update the JS in the same commit.
   - Keep hidden/native source-of-truth controls synchronized when a custom UI is layered on top.

## Layout

### Desktop

- Use available width for grouping and scannability, not for stretching every control.
- Complex settings/configuration surfaces may use a wider shell around `min(960px, 96vw)`.
- Two-column layouts are appropriate for settings-style surfaces:
  - left: section navigation
  - right: scrollable content sections
- Content cards typically use `16-22px` internal padding.
- Section gaps usually sit around `12-18px` depending on density.

### Mobile

- Standard modals become fullscreen.
- Content scrolls inside the modal body, not behind it.
- Header/close controls and footer actions must not create competing scroll containers.
- Section navigation with many entries uses one horizontal row:
  - `overflow-x: auto`
  - `flex-wrap: nowrap`
  - touch scrolling enabled
- Verify `body.scrollWidth === window.innerWidth` for mobile UI work.

## Cards and Sections

Generic section/card structure:

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

Guidelines:

- Heading = icon + title + short hint.
- Put `data-icon` directly on `.ui-section-icon` / `.settings-section-icon` so the shared icon hydrator owns SVG markup.
- Settings aliases (`.settings-section-card`, `.settings-section-heading`, `.settings-section-icon`) must stay visually aligned with `.ui-section-*`.
- Use only icon names available in `web/static/js/icons/lucide-icons.js`; unknown icons are user-facing bugs.
- Keep hints short; one sentence is enough.
- Use nested subcards only for dense areas such as security, 2FA, native app, or integrations.

## Buttons

### Semantics

- `.btn-primary` — main positive action.
- `.btn-secondary` — neutral action, navigation, retry, utility.
- `.btn-danger` — destructive or security-sensitive action.
- `.btn-small` — compact row-level or inline content action.
- `.btn-icon` — square icon-only action.
- `.ui-nav-pill` — navigation rows/chips such as sidebar filters and project rows; keep JS hooks like `.nav-btn` separate from the visual primitive.

### Visual Contract

The generic `.btn` primitive owns the default button look. Do not rely on modal/footer-specific CSS to make a normal button look correct.

Base `.btn` requirements:

- `inline-flex`
- centered icon/text (`align-items: center`, `justify-content: center`)
- `34px` minimum desktop height
- pill-shaped `999px` radius for normal buttons
- `14px` text
- default `400` weight; use stronger weight only when a component intentionally needs more emphasis
- shared icon sizing through `.btn .ui-icon` / `.btn-icon .ui-icon`
- no default shadow on `.btn-primary`; elevation is opt-in

Button classes own visuals and interaction: size, padding, radius, background, typography, icon sizing, disabled, hover, active, focus. Containers own placement only: grid/flex layout, gaps, alignment, wrapping, mobile stacking.

Semantic variants change color and meaning only. They should not redefine alignment, sizing, text weight, default elevation, or icon layout unless the component is intentionally non-standard.

### Size and Density

Desktop:

- Normal buttons: `34px` minimum height.
- Small row actions: `34px` minimum height via `.btn-small`.
- Icon-only row actions: `34px × 34px` via `.btn-icon`.
- Component-specific tiny icon actions may keep smaller visual sizes only when they explicitly override dimensions while still using `.btn-icon` semantics, e.g. invite actions or inline section actions.

Mobile:

- Buttons inside modals/cards usually become full width.
- Normal mobile action height: about `42px`.
- Stack action rows vertically with `8-10px` gap unless two tiny equally weighted icon buttons are clearly better.

### Ordering

Typical modal order:

1. neutral close/cancel
2. retry/back if relevant
3. primary action
4. destructive action only when context clearly requires it

On mobile, keep the most likely action easiest to hit. Destructive actions must not be visually ambiguous.

## Fields and Forms

- Use `.form-group` for label + field grouping.
- Use `.ui-field` on visible text, number, date/time inputs, textareas, and visible native fallback selects.
- `.ui-field` owns field visuals: width, height, padding, radius, background, border, typography, disabled, focus.
- `.form-group` and container classes own layout: labels, gaps, grids, help/error placement.
- Custom `.ui-select-trigger` controls are the dropdown equivalent of `.ui-field`.
- Use `.ui-field-grid` for grouped form fields; `.two-columns` only when fields are logically parallel on desktop.
- Mobile form grids collapse to one column.
- Help text uses muted color and about `12px` size.
- Empty inline error/success containers must not reserve layout space.
- Avoid inline `style="..."` for layout except unavoidable dynamic show/hide states.

## Dropdowns, Selects, and Menus

Dropdowns are first-class UI primitives. They must not look like browser-default controls on redesigned desktop surfaces.

### Non-negotiable Rule

User-facing dropdowns use the shared custom dropdown/menu primitive.

Native `<select>` elements are allowed only as:

- hidden source of truth for existing form integration
- progressive-enhancement fallback when JavaScript fails
- platform fallback when a custom menu would be measurably worse for accessibility or platform behavior

If a native `<select>` remains visibly browser-default in a redesigned user-facing surface, the UI is not finished.

### Primitive Names

Use one shared primitive family:

- `.ui-select` — field-sized single-value selector
- `.ui-select-trigger` — visible closed control
- `.ui-select-value` — selected label/content
- `.ui-select-chevron` — disclosure indicator
- `.ui-select-menu` — popup container
- `.ui-select-option` — selectable row
- `.ui-select-option.is-selected` — current selected option
- `.ui-select-option.is-highlighted` — keyboard/hover active option
- `.ui-select-option.is-disabled` — unavailable option
- `.ui-menu` — action menu container
- `.ui-menu-item` — action row
- `.ui-menu-separator` — visual group separator

Do not add component-specific dropdown visual systems. Component classes may add small layout hooks only.

### Visual Contract

Closed trigger:

- field-sized, aligned with sibling inputs
- standard field radius unless the entire component intentionally uses a larger radius
- `12px` left padding, enough right padding for chevron/check/action affordances
- same surface/depth language as sibling fields
- visible focus ring
- `13-14px` selected label, regular weight unless a compact menu intentionally needs emphasis
- icons/chips left aligned and never stretched
- chevron right aligned, muted, and visually reacts when open

Open menu:

- fixed/portal-style placement when inside modals to avoid clipping
- minimum width equal to trigger width
- maximum width usually `min(280px, calc(100vw - 24px))`
- maximum height usually `min(320px, calc(100vh - 24px))`
- internal scroll when needed
- `var(--dropdown-menu-radius)`
- `6px` padding
- borderless elevated neutral surface
- shadow reads as floating layer without becoming heavy

Option/action rows:

- `36px` desktop minimum, `40-44px` mobile touch target
- `8px 10px` padding
- `8px` gap
- pill-shaped row radius (`var(--dropdown-option-radius)` / `999px`)
- labels truncate cleanly and never overlap icon, badge, checkmark, or chevron
- selected rows use the shared Lucide `check` icon
- destructive actions use danger color and should be visually separated when mixed with neutral actions

Workspace menu, user menu, Todo status/snooze menus, select dropdowns, and admin/config dropdowns should all share this pill-row language.

### Behavior Contract

Custom dropdowns/menus must support:

- click/tap trigger opens and closes
- outside click closes
- `Escape` closes and returns focus when appropriate
- `Enter`/`Space` opens from trigger
- arrow keys move highlighted option for select-like controls
- `Enter` selects highlighted option
- `Tab` does not trap focus
- opening one dropdown closes other open dropdowns when they would conflict
- selection updates hidden native source-of-truth fields and dispatches `change` when existing code expects it
- placement recalculates on open, scroll, resize, and orientation change
- menus inside modals are not clipped

### Accessibility Contract

Select-like controls:

- trigger uses `role="combobox"` or a button/listbox pattern with correct ARIA
- menu uses `role="listbox"`
- options use `role="option"`
- selected option uses `aria-selected="true"`
- disabled option uses `aria-disabled="true"`
- labels remain real `<label>` elements tied to the native field or visible trigger

Action menus:

- trigger uses `aria-haspopup="menu"`
- menu uses `role="menu"`
- items use `role="menuitem"` unless a stronger semantic element is needed

Keyboard behavior is required, not decorative.

### Searchable and Large Lists

For more than roughly 12 options, consider a searchable variant:

- `.ui-select-search` at the top
- predictable keyboard highlight after filtering
- empty state row for no matches
- `Escape`, outside-click, and modal focus behavior remain intact

Project/workspace/user lists may use this when they become long. Do not invent a separate autocomplete visual style.

### Native Select Hydration Checklist

When replacing an existing `<select>`:

1. Keep the original ID if JS depends on it.
2. Visually hide the native select accessibly when needed.
3. Render/hydrate the custom `.ui-select` next to it.
4. Keep values synchronized both ways.
5. Dispatch `change` after custom selection.
6. Preserve disabled/read-only behavior.
7. Preserve form reset behavior.
8. Cover at least one representative form dropdown and one action menu in tests when tests are in scope.

## Modals

### Detail Modal Family

Use the shared `ui-detail-modal` primitive for Todo/Project/Workspace-style detail editors and future entity modals that belong to the same family.

Core classes:

- `.ui-detail-modal` on the root `.modal`
- `.ui-detail-view` for modals that always use detail treatment, e.g. Project and Workspace
- `.todo-detail-view` for existing-todo detail mode; new-todo composer may stay compact
- `.ui-detail-modal-content`, `.ui-detail-modal-header`, `.ui-detail-modal-body`
- `.ui-detail-shell`
- `.ui-detail-section`, `.ui-detail-section-heading`, `.ui-detail-section-icon`
- `.ui-detail-title-section`, `.ui-detail-title-group`, `.ui-detail-title-field`
- `.ui-detail-header-actions`, `.ui-detail-header-menu-toggle`, `.ui-detail-header-menu`
- `.ui-detail-action-row`

Rules:

- Hide primary save actions when the current form state is unchanged or not saveable; do not leave disabled muted controls in prominent header slots.
- Reusable surface/header/title/section/action styling belongs in `89-ui-detail-modal.css`.
- Feature-specific CSS is only for real content behavior such as sharing rows, comments, attachments, or picker placement.
- Header action/menu selectors must stay scoped under `.ui-detail-modal`.
- When adding a new CSS module to this family, update `web/static/style.css`, Service Worker precache/update asset lists, and hard-reload fallback lists.

Minimal structure:

```html
<div class="modal ui-detail-modal ui-detail-view" id="example-modal">
  <div class="modal-overlay" data-close-modal="example-modal"></div>
  <div class="modal-content ui-detail-modal-content">
    <div class="ui-detail-modal-header">
      <div class="ui-detail-title-icon" data-icon="folder"></div>
      <div>
        <h3>Title</h3>
        <p>Short context text.</p>
      </div>
      <div class="ui-detail-header-actions">
        <button class="btn btn-primary">Save</button>
      </div>
    </div>
    <button class="modal-close-x" data-close-modal="example-modal"><span data-icon="x"></span></button>
    <div class="modal-body ui-detail-modal-body">
      <form class="ui-detail-shell">
        <section class="ui-section-card ui-detail-section ui-detail-title-section">
          <div class="form-group ui-detail-title-group">
            <label>Name</label>
            <input class="ui-field ui-detail-title-field" type="text">
          </div>
        </section>
      </form>
    </div>
  </div>
</div>
```

### Standard Modal

Use for focused create/edit flows:

- max width around `520px`
- title in `<h3>`
- close X on mobile/fullscreen contexts
- footer actions in `.modal-actions`

### Complex Modal

Use for settings, multi-section configuration, app downloads, or review flows:

- custom content class is allowed for shell/layout
- sticky or clearly separated header
- scrollable body
- stable footer/header actions
- inner controls still use shared `.btn`, `.ui-field`, `.ui-select`, `.ui-section-*` primitives

### Mobile Modal

- fullscreen
- no background overlay required
- header/footer fixed by flex layout
- body scrolls independently
- safe-area padding at the bottom

## Lists, Todo Cards, and Sections

Todo cards and grouped lists follow the calm card language:

- Project grouping is expressed through spacing, group headers, and cards, not vertical dividers.
- Todo row actions stay available on mobile because native/gesture flows rely on them.
- Touch/tablet layouts may collapse noisy actions behind a reveal control.
- Use compact badges/chips for pinned, in-progress, due, overdue, reminders, subtasks, comments, and attachments.
- Render reminder chips from both `todo.remind_at` and the first active reminder in `todo.reminders`.
- Todo-list descriptions are previews: normalize multiline text to a single-line ellipsis while still rendering safe inline Markdown.
- Full multiline text belongs in the detail modal.
- Status and snooze popovers use `.ui-menu` language, adequate minimum width, and no text overlap.
- Section headers reserve consistent action-space rhythm: deletable sections and the unsorted/non-deletable section should keep count alignment visually stable.

## Navigation

### Sidebar

- Sidebar entries use `.ui-nav-pill` plus JS hooks such as `.nav-btn`.
- Each item has icon/marker + label.
- Badge/count alignment should stay visually stable across rows with or without secondary actions.
- Project edit buttons may remain separate controls when they preserve the main nav-row rhythm.
- Add-project uses the same project-row structure as project entries, with different behavior.
- Hover states are subtle; active states use a calm accent wash and left accent rhythm where appropriate.

### Settings / Section Navigation

Desktop:

- Vertical navigation is appropriate when there are 4+ sections.
- Keep icon + label alignment consistent.

Mobile:

- Prefer horizontal scrollable chips.
- Do not wrap many navigation chips into multiple rows unless content is extremely short.
- Nav itself scrolls horizontally instead of widening the page.

## BrainDump UX

BrainDump is voice-first and immediate:

- Tapping the microphone FAB opens the modal and starts recording immediately.
- There is no separate start-recording step.
- During recording, show only finish/process plus close/cancel.
- Closing during recording cancels recording and must not silently process.
- After results/errors, show retry as “speak again” and an accept action for selected candidates.
- Candidate edit controls use the same shared field/dropdown/menu/button language.

## Notifications and Native App Settings

- Browser-only sections are hidden in native contexts if not applicable.
- Native-only app sections are hidden in browser/PWA contexts.
- Empty cards are not allowed; hide the whole card and matching nav entry.
- Native app setting buttons and status rows use the same section/card/action primitives as browser settings.

## Current Reference Patterns

- **Todo detail modal:** shared detail shell, header rhythm, large title field, flat sections, header actions, mobile fullscreen.
- **Project/Workspace modals:** permanent detail-modal family; entity-specific CSS only for organization/sharing/member/picker behavior.
- **Settings modal:** wide settings shell, section nav, section cards, consistent button groups, no special profile-only visual system.
- **BrainDump modal:** voice-first detail-like shell with shared controls and candidate cards.
- **Workspace dropdown:** `.ui-menu` surface with pill-shaped active, hover, edit, and add actions.
- **Todo cards:** flat calm cards, compact chips, shared menu popovers, reveal behavior on touch/tablet.
- **Sidebar:** `.ui-nav-pill` navigation rows, stable badges, project-row add action, subtle hover/active surfaces.
- **Admin UI:** card-based configuration sections and compact shared controls; hydrated config selects must not show browser-default dropdowns.
- **App Downloads modal:** normal `.btn` actions and `.ui-section-*` cards; platform instruction visuals are illustrative, not a separate component system.

## Done Criteria for UI Work

Before UI work is considered ready:

- No visible browser-default select/dropdown remains in redesigned user-facing surfaces.
- Desktop around `1280x900` works.
- Mobile around `390x844` works.
- No horizontal body overflow on mobile.
- Buttons are not clipped and have consistent height.
- Hidden/inapplicable sections do not leave empty cards or nav entries.
- German and English labels fit or truncate cleanly.
- Menus are not clipped inside modals.
- Keyboard behavior works for custom dropdowns/menus when applicable.
- Hidden native fields still update existing save logic when used.
- JS-bound IDs/classes remain stable or JS is updated in the same commit.
- Relevant CSS/JS assets are added to app shell/service-worker lists when new files are introduced.
- Run checks matching the touched files, e.g. syntax checks, `git diff --check`, lint/build/tests when requested or in scope.

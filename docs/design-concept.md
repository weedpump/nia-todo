# Design Concept

This document is the UI design reference for nia-todo. New UI work should follow it before adding new patterns.

Goals:

- calm, focused, task-first interface
- consistent controls across web, PWA, Windows, and Android wrappers
- mobile-first behavior without making desktop feel sparse
- accessible sizing, clear hierarchy, and predictable actions
- reduce visual noise by preferring clean content sections, semantic chips, and shared action primitives over deeply nested component-specific containers

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
- `.btn-small` — compact row-level or inline content action, e.g. add subtask, add comment, choose/upload file, edit details.
- `.btn-icon` — square icon-only row action; combine with `.btn-small` for compact icon buttons.
- `.ui-nav-pill` — app navigation entries such as sidebar filters and project rows. Keep JS/context hooks such as `.nav-btn` separate from the visual primitive.

### Visual Contract

The generic `.btn` primitive owns the default button look. Do not rely on modal/footer-specific CSS to make a normal button look correct.

The Todo detail redesign introduced a calmer compact pill-button direction for inline content actions such as add/upload/edit-details. This direction is now the global `.btn` baseline, with `.btn-small` and semantic variants used when a row-level action needs the same compact density. Do not add page-specific action button classes for visuals; migrate app-wide buttons deliberately through shared primitives instead of one-off overrides.

Button classes own button visuals and interaction only: size, padding, radius, background, typography, icon sizing, disabled/hover/focus states. Container classes own placement only: grid/flex layout, gaps, alignment, wrapping, and mobile stacking. A container may place a button, but it must not restyle that button's typography, padding, background, border, radius, shadow, or icon size. If multiple buttons should look the same, they must share the same button classes and no component-specific selector may override their visual properties.

Base `.btn` requirements:

- inline-flex layout with icon/text vertically and horizontally centered (`align-items: center`, `justify-content: center`)
- `34px` minimum height on desktop
- pill-shaped `999px` border radius for normal buttons
- `14px` text, default `400` weight, centered label; use stronger weight only when a specific component intentionally needs more emphasis
- shared icon sizing via the global `.btn .ui-icon` / `.btn-icon .ui-icon` rules
- no default shadow on `.btn-primary`; elevation/shadows must be opt-in for a specific component and should not bleed into adjacent stacked buttons

Variants (`.btn-primary`, `.btn-secondary`, `.btn-danger`) change semantic color only; they should not redefine alignment, sizing, text weight, or default elevation unless the component is intentionally non-standard.

### Size

Desktop:

- Normal buttons: `34px` minimum height.
- Inline content actions: `34px` minimum height via normal `.btn` plus semantic variants; add `.btn-small` for compact row-level density when needed.
- Small row actions: `34px` minimum height via `.btn-small`.
- Icon-only row actions: `34px × 34px` via `.btn-icon`; they must remain square and should not inherit mobile full-height button rules.
- Button text should stay centered and readable.

Mobile:

- Buttons inside modals/cards should usually be full width.
- Normal mobile action height: `42px` minimum, especially inside card/action surfaces.
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

Modal redesign direction from the Todo detail work:

- Read/detail surfaces should feel like content views first, not dense forms.
- Create flows may remain form-first, but should share the same modal shell, header rhythm, mobile fullscreen behavior, and action primitives as related detail views.
- Avoid nested box-in-box layouts unless the grouping adds real comprehension. Prefer clean sections, subtle dividers, and semantic chips.
- On mobile, fullscreen modals should have one scroll container for the body; headers/close controls must not participate in a second outer scroll.

### Detail Modal Family

Use the shared `ui-detail-modal` primitive for Todo/Project/Workspace-style detail editors and for future entity modals that should visually belong to the same family.

Core classes:

- `.ui-detail-modal` on the root `.modal`.
- `.ui-detail-view` on modals that should always use the detail treatment, e.g. Project and Workspace. Todo uses `.todo-detail-view` only for existing-todo detail mode so the new-todo composer can remain compact.
- `.ui-detail-modal-content`, `.ui-detail-modal-header`, `.ui-detail-modal-body` for the shared shell.
- `.ui-detail-shell` for the centered content column.
- `.ui-detail-section`, `.ui-detail-section-heading`, `.ui-detail-section-icon` for flat drawer-style sections.
- `.ui-detail-title-section`, `.ui-detail-title-group`, `.ui-detail-title-field` for the large inline title/name field.
- `.ui-detail-header-actions`, `.ui-detail-header-menu-toggle`, `.ui-detail-header-menu` for save/menu actions in the header. Hide the primary save action when the current form state is unchanged or otherwise not saveable; do not leave it visible as a disabled/muted control.
- `.ui-detail-action-row` for right-aligned section actions that become full-width on mobile.

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
        <section class="ui-section-card ui-detail-section">
          <div class="ui-section-heading ui-detail-section-heading">
            <div class="ui-section-icon ui-detail-section-icon" data-icon="settings"></div>
            <div>
              <h4>Details</h4>
              <p>What this section controls.</p>
            </div>
          </div>
        </section>
      </form>
    </div>
  </div>
</div>
```

Rules:

- Put reusable surface/header/title/section/action styling into `89-ui-detail-modal.css`, not into feature-specific modal files.
- Keep feature-specific CSS only for real content behavior, e.g. Project sharing member rows or Todo comments/attachments.
- Keep header action/menu selectors scoped under `.ui-detail-modal` to avoid accidental global layout effects.
- When adding a new CSS module to this family, update `style.css`, the service worker precache, service-worker update asset lists, and the inline hard-reload fallback list.
- Do not create one-off modal wrappers just to copy the Todo/Project look. Adopt the detail classes first, then add only the missing entity-specific rules.

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

- Use `.form-group` for label + field grouping.
- Use `.ui-field` on visible text inputs, number/date/time inputs, textareas, and visible native fallback selects.
- `.ui-field` owns field visuals and interaction: width, height, padding, radius, background, border, typography, disabled, and focus states.
- `.form-group` and container classes own layout only: labels, gaps, grids, alignment, and help/error text placement.
- Custom `.ui-select-trigger` controls are the dropdown equivalent of `.ui-field` and share the same field shape/height tokens. Do not round fields via modal- or component-specific selectors.
- Use `.ui-field-grid` for grouped form fields; add `.two-columns` only when fields are logically parallel on desktop.
- On mobile, form grids collapse to one column.
- Help text should use muted color and `12px` size.
- Errors use `.settings-field-error` or equivalent danger style.
- Success messages use `.settings-field-success` or equivalent success style.
- Empty inline error/success containers must not reserve layout space; hide empty status rows globally instead of patching individual forms.

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

- fills its field container height (`height: 100%`) with `40px` desktop and `42px` mobile minimums
- border radius: use the standard field radius (`var(--radius)`) unless the surrounding component explicitly uses a larger field radius everywhere
- horizontal padding: `12px` left, `38-42px` right when a chevron is present
- background: same input field surface as sibling text fields (`var(--bg-primary)` by default)
- border: same subtle default field border, accent border on hover/focus
- focus ring: visible accent ring, matching other inputs
- selected label: `13-14px`, regular field weight unless a specific compact menu pattern requires emphasis
- icon/color chip, when present: left aligned, `16-20px`, never stretched
- chevron: right aligned, muted, rotates or changes opacity when open
- avoid component-specific trigger restyling; if dropdowns and inputs diverge visually, fix the shared primitive or the shared field primitive

Open menu:

- fixed-position or portal-style placement when inside modals to avoid clipping by scroll containers
- minimum width equal to the trigger width
- maximum width: `min(280px, calc(100vw - 24px))` unless the content requires more
- maximum height: `min(320px, calc(100vh - 24px))`, scroll internally
- border radius: use `var(--dropdown-menu-radius)` so the open menu follows the same shape language as field controls
- padding: `6px`
- border and background must match modal/card elevation
- shadow must make it read as a floating layer without feeling heavy
- z-index must sit above the current modal body but below global critical overlays

Option rows:

- min height: `36px` desktop, `44px` mobile
- padding: `8px 10px`
- gap: `8px`
- border radius: use `var(--dropdown-option-radius)`; option rows must not look sharper than the menu they live in
- label must never overlap icon, badge, checkmark, or chevron
- long labels truncate with ellipsis unless multiline is explicitly required
- selected option shows the shared Lucide `check` icon (`iconSvg('check')`) aligned like the workspace dropdown check, not a raw text glyph
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

When a custom select sits beside standard inputs, the visible trigger must match sibling field height, top/bottom alignment, radius, background, border, and empty-state spacing on both desktop and mobile. Do not solve these as screen-specific overrides.

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

- Reuse existing `.btn`, `.form-group`, `.modal-*`, `.ui-detail-*`, `.ui-section-*`, `.ui-field-grid`, `.ui-select`, `.ui-menu`, badge/chip, and card classes where possible.
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

- User Settings modal: wide settings modal, section nav, section cards, consistent button groups; profile content stays inside the standard section-card treatment and should be tidied through internal layout, not by adding a special profile header.
- Todo/Project detail modals: shared `ui-detail-modal` family using one detail shell, header rhythm, large inline title/name field, flat sections, header actions, and mobile fullscreen behavior. Project already uses this family permanently; Todo uses it in existing-todo detail mode while the new-todo composer stays compact.
- Workspace and future entity modals: adopt `ui-detail-modal` when they should align with Todo/Project detail surfaces; keep entity-specific rules limited to content behavior such as grids, picker placement, or sharing/member rows. Picker surfaces should use shared primitives: visible picker triggers use `.ui-field`, picker panels use `.ui-section-card`, picker actions/options use `.btn`/`.btn-secondary`/`.btn-icon`, and selected states use shared `.btn.is-selected` / `[aria-selected="true"]` styling.
- App Downloads modal: use normal `.btn` actions and `.ui-section-*` cards for install/download surfaces; keep platform instruction visuals illustrative, not a separate button/card system.
- BrainDump modal: voice-first immediate recording flow.
- Admin UI: card-based configuration sections and compact admin controls.

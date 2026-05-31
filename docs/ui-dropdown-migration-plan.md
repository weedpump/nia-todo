# UI Dropdown Migration Plan

This is the implementation plan for migrating nia-todo away from visible browser-default dropdowns/selects and toward the shared dropdown/menu system defined in [Design Concept](design-concept.md#dropdowns-selects-and-menus).

This document is intentionally prescriptive. A future implementation session should be able to start here, follow the phases in order, and verify the result without inventing local exceptions.

## Goal

All redesigned user-facing dropdowns and action menus must share one coherent visual and behavioral system:

- form-like single-value selectors use `.ui-select`
- action menus use `.ui-menu`
- visible browser-default `<select>` controls are not acceptable in redesigned surfaces
- existing native `<select>` elements may remain only as hidden source-of-truth/fallback controls
- desktop and mobile must look related, not like different apps

## Branch and Scope

- Working tree: `~/projects/nia-todo-dev`
- Branch: `fix/user-settings-ui-redesign`
- Source of truth: `docs/design-concept.md`
- Do not merge to `develop` without Tobi's explicit approval.
- Do not release from this branch.

## Current Status

Implemented:

- shared dropdown primitive in `web/static/js/ui/dropdowns.js`
- Todo modal selects: `#todo-priority`, `#todo-status`, `#todo-project`, `#todo-section`
- Settings language selector: `#settings-language`
- Project modal selectors: `#project-display-workspace-id`, `#project-parent-id`
- Todo card/list status and snooze action menus aligned to shared `.ui-menu` / `.ui-menu-item` styling
- Admin config/user selects: SMTP security, BrainDump provider/mode selects, and new-user language
- shared dropdown trigger aligned to the standard input field visual contract
- shared selected-option checkmark uses the same Lucide `check` icon treatment as the workspace dropdown

Intentional exceptions / inspected scope:

- Workspace menu and workspace icon picker keep their existing custom workspace patterns by product decision; they are not part of the shared dropdown migration scope.
- Project sharing/member management was inspected on 2026-05-31: it exposes inline invite/remove/leave actions, not dropdown-like member action menus, so no `.ui-menu` migration is needed there.

## Non-Negotiables

1. No visible browser-default select in a redesigned target surface.
2. No component-owned dropdown visual systems such as project-only, settings-only, or todo-only selects.
3. Native selects that existing JS depends on must keep their IDs and values synchronized.
4. One open dropdown/menu at a time.
5. Menus inside modals must not be clipped by modal scroll containers.
6. Keyboard operation is required, not optional.
7. Outside-click and `Escape` close behavior is required.
8. Desktop and mobile must both be checked.
9. German and English labels must both fit or truncate cleanly.
10. Tests must cover representative form-select and action-menu behavior.

## Target Files

Likely implementation files:

- `web/static/style.css`
  - shared `.ui-select` / `.ui-menu` styling
  - visually-hidden utility if missing
  - responsive/mobile placement variants
- `web/static/js/features/` or `web/static/js/ui/`
  - shared dropdown/select hydration module
  - shared menu positioning and close coordination
- `web/index.html`
  - mark target native selects for hydration where static markup is easiest
  - remove layout inline styles where touched
- Existing feature modules:
  - `web/static/js/features/todos.js`
  - `web/static/js/features/projects.js`
  - `web/static/js/features/project-sharing.js`
  - `web/static/js/features/user-settings.js`
  - `web/static/js/features/todo-rendering.js`
- Existing icon helpers:
  - `web/static/js/icons/lucide-icons.js`
- Tests:
  - `scripts/test_frontend_projects.mjs`
  - `scripts/test_frontend_sharing.mjs`
  - add a dedicated dropdown primitive test, e.g. `scripts/test_frontend_ui_dropdowns.mjs`
  - extend todo/settings frontend tests if the relevant surface already has coverage

Do not create a large framework. Keep it vanilla JS and consistent with the current frontend architecture.

## Phase 1: Build Shared Primitive

Create one shared module for dropdown/select/menu behavior.

Recommended file:

- `web/static/js/ui/dropdowns.js`

If there is no `ui/` folder yet, create it. If imports become awkward, place it under `web/static/js/features/` temporarily, but the module must still be generic and not project/todo/settings-specific.

### Required API

The module should expose a small API, for example:

```js
export function hydrateSelect(select, options = {}) {}
export function hydrateSelects(root = document) {}
export function closeOpenDropdown(reason = 'programmatic') {}
export function positionDropdown(trigger, menu, options = {}) {}
```

Expected options:

```js
{
  placeholder: string,
  searchable: boolean,
  renderOption: (option) => HTMLElement | string,
  renderValue: (option) => HTMLElement | string,
  className: string,
  menuClassName: string,
  strategy: 'popover' | 'bottom-sheet' | 'auto'
}
```

Keep the first implementation conservative. Add hooks only when a target surface genuinely needs them.

### Native Select Sync

For every hydrated native `<select>`:

- keep original `id`
- keep original `name` if present
- keep original `disabled` state
- hide the native select visually, not with `display:none`, unless there is a separate accessible label path
- render the `.ui-select` trigger next to it
- update native `select.value` on custom selection
- dispatch `new Event('change', { bubbles: true })` after selection
- reflect native value changes back into the custom trigger
- handle dynamic option list changes by providing an explicit refresh path

### Accessibility

For select-like controls, use either:

- button trigger + `aria-haspopup="listbox"`, or
- `role="combobox"` with correct `aria-expanded`, `aria-controls`, and active-descendant handling

The simple button/listbox pattern is preferred unless typeahead/search is implemented.

Required:

- menu: `role="listbox"`
- option: `role="option"`
- selected option: `aria-selected="true"`
- disabled option: `aria-disabled="true"`
- trigger: `aria-expanded`
- `Escape` closes and returns focus to trigger
- arrows move highlighted option
- `Enter` selects highlighted option
- `Tab` does not trap focus

### Positioning

Menus in modal bodies must use fixed-position or portal-style placement:

- append open menu to `document.body` or another global overlay root
- compute trigger `getBoundingClientRect()` on open
- clamp to viewport with `12px` minimum edge padding
- flip above trigger when there is not enough space below
- recompute on scroll/resize/orientation change
- close or reposition when the trigger disappears

Do not rely on `overflow: visible` inside modal scroll bodies. That is how clipping bugs breed. Tiny CSS goblins, very annoying.

### Styling

Add shared CSS only once:

- `.ui-select`
- `.ui-select-trigger`
- `.ui-select-value`
- `.ui-select-chevron`
- `.ui-select-menu`
- `.ui-select-option`
- `.ui-select-option.is-selected`
- `.ui-select-option.is-highlighted`
- `.ui-select-option.is-disabled`
- `.ui-menu`
- `.ui-menu-item`
- `.ui-menu-separator`
- `.visually-hidden` or equivalent accessible utility if not present

Keep visual values aligned with `docs/design-concept.md`. The closed `.ui-select-trigger` should inherit the standard field look globally (standard radius, `var(--bg-primary)`, normal weight, no component-specific trigger skin) and fill its container height so sibling inputs/selects align on desktop and mobile.

## Phase 2: Migrate Todo Modal Selects

Targets in `web/index.html`:

- `#todo-priority`
- `#todo-status`
- `#todo-project`
- `#todo-section`

Relevant JS:

- `web/static/js/features/todos.js`
- project/section population logic
- `onProjectChange()` behavior

Requirements:

- custom selects render after dynamic options are populated
- project changes still refresh section options
- disabled section select still looks disabled in custom UI
- form save logic receives the original native values
- form reset/edit existing todo updates custom UI correctly
- long project/section names truncate cleanly

Tests:

- open Todo modal on desktop viewport
- assert no visible native select inside Todo modal
- select priority/status/project/section via custom UI
- assert native hidden select values changed
- assert save payload or UI state uses selected values
- repeat at mobile viewport enough to verify no horizontal overflow/clipping

## Phase 3: Migrate Project Modal Selects

Targets:

- `#project-display-workspace-id`
- `#project-parent-id`

Relevant JS:

- `web/static/js/features/projects.js`
- `renderParentProjectSelect()`
- `renderProjectWorkspaceSelect()`
- project sharing read-only states in `web/static/js/features/project-sharing.js`

Requirements:

- changing workspace refreshes parent-project options and custom UI
- shared member/owner/read-only states stay correct
- inbox project restrictions stay correct
- parent hierarchy indentation remains readable
- menu is not clipped in project modal
- outside-click and `Escape` close the menu

Tests:

- extend `scripts/test_frontend_projects.mjs`
- verify workspace and parent project selection through `.ui-select`
- verify modal clipping by opening menu near lower modal area
- verify only one menu open at a time

## Phase 4: Migrate Settings Selects and Option Controls

Targets to inspect first:

- language selector
- notification/native app settings selectors
- theme/accent selectors if they behave like dropdowns
- any settings-specific menu/dropdown controls

Relevant JS:

- `web/static/js/features/user-settings.js`
- theme/native notification modules if applicable

Requirements:

- do not leave settings-specific visual dropdown styles
- hide irrelevant browser/native sections fully, including nav entries
- empty cards remain forbidden
- settings section nav remains usable on mobile

Tests:

- open Settings modal desktop/mobile
- verify migrated controls use `.ui-select` / `.ui-menu`
- verify hidden/inapplicable sections do not leave empty cards
- verify language change still works if migrated

## Phase 5: Align Todo Card/List Action Menus

Targets:

- status menu in todo rows/cards
- snooze menu in todo rows/cards

Relevant JS:

- `web/static/js/features/todo-rendering.js`
- todo status/snooze handlers

Requirements:

- action menus use `.ui-menu` / `.ui-menu-item` visual language
- option rows share sizing, hover, selected, danger/neutral treatment with `.ui-select-option`
- mobile row actions remain available for native/gesture tests
- swipe-to-complete behavior must not regress
- menus do not overlap labels or clip at viewport edge

Tests:

- open status menu and select status
- open snooze menu and select snooze option
- verify row action buttons still work on mobile
- verify swipe-related existing tests still pass

## Phase 6: Workspace, Sharing, and Admin Sweep

Inspect and migrate anything still visibly dropdown-like:

- workspace modal selectors
- icon/color pickers if they expose menu-like behavior
- project sharing/member action menus
- admin user/config dropdowns if included in the release scope

Requirements:

- no new local visual systems
- if something is not migrated, document why it is out of scope and confirm with Tobi before calling the redesign complete

## Phase 7: Cleanup

After target migrations:

- remove obsolete component-specific select CSS
- remove project-only/select-only hacks if replaced by shared primitive
- remove touched inline layout styles where easy
- ensure no duplicate dropdown positioning logic remains
- ensure `docs/design-concept.md` and this plan still match actual implementation

Useful scans:

```bash
grep -RIn "<select\|style=\"" web/index.html web/static/js | head -120
grep -RIn "project-select\|settings-dropdown\|todo-menu" web/static/style.css web/static/js | head -120
git diff --check
```

Visible `<select>` findings are not automatically bugs, but each one in a redesigned user-facing target must be intentionally handled.

## Required Verification Gates

Run the smallest relevant set after each phase, then the broader set before reporting ready.

Minimum per phase:

```bash
git diff --check
```

Dropdown primitive / project work:

```bash
node scripts/test_frontend_projects.mjs
node scripts/test_frontend_sharing.mjs
```

BrainDump should be checked if modal/global overlay behavior changed:

```bash
node scripts/test_frontend_braindump_capture.mjs
```

Add and run the new dropdown test:

```bash
node scripts/test_frontend_ui_dropdowns.mjs
```

If Todo row/card behavior changed, run the relevant existing todo/frontend tests. If unsure which tests cover it, inspect `scripts/test_frontend_*.mjs` before guessing.

## Visual Review Checklist

Capture or manually inspect both:

- desktop around `1280x900`
- mobile around `390x844`

Check:

- no browser-default select appearance
- trigger height and border radius match other inputs
- focus ring visible
- menu opens above modal body without clipping
- menu flips or clamps at viewport edges
- selected row is obvious
- icons/checkmarks do not collide with labels
- long German labels truncate cleanly
- only one dropdown open at once
- footer actions remain reachable in fullscreen mobile modals
- no horizontal body overflow on mobile

## Definition of Done

The dropdown migration is ready for review only when:

- all Phase 2-6 in-scope targets use `.ui-select` / `.ui-menu`
- visible native selects are gone from redesigned target surfaces
- at least one form-select and one action-menu flow are covered by Playwright
- project/todo/settings save logic still uses correct values
- desktop and mobile have been inspected
- `git diff --check` passes
- relevant frontend tests pass
- remaining out-of-scope dropdowns, if any, are listed explicitly with rationale
- a review subagent has passed before asking Tobi for merge approval

## Recommended First Implementation Slice

Start small but foundational:

1. Add `web/static/js/ui/dropdowns.js`.
2. Add shared `.ui-select` / `.ui-menu` CSS.
3. Hydrate only Todo modal `#todo-priority` and `#todo-status` first.
4. Add `scripts/test_frontend_ui_dropdowns.mjs` for:
   - open Todo modal
   - verify native selects are visually hidden
   - open custom select
   - keyboard select an option
   - outside-click close
   - `Escape` close
   - native select value sync
5. Then migrate Todo project/section, because dynamic option refresh is the harder case.

This avoids starting with the Project modal, where workspace/parent/shared state creates extra complexity before the primitive is proven.

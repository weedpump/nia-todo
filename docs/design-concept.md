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

- Reuse existing `.btn`, `.form-group`, `.modal-*`, `.ui-section-*`, `.ui-field-grid`, badge/chip, and card classes where possible.
- Prefer extending shared primitives over appending component-specific override blocks.
- If a visual fix applies to more than one component, move it into the shared primitive instead of patching only the current screen.
- Add i18n keys for all persistent user-facing labels.
- Avoid inline styles for layout and spacing.
- Keep JS-bound IDs stable.
- Test at least one desktop and one mobile viewport with Playwright or a browser.
- Run syntax/format checks matching the touched files.

## Current Reference Patterns

- User Settings modal: wide settings modal, section nav, section cards, consistent button groups.
- Project/Workspace modals: compact entity modal pattern using shared `.ui-section-*` cards, `.ui-field-grid`, and the same title/icon tile sizing as Todo Modal.
- BrainDump modal: voice-first immediate recording flow.
- Admin UI: card-based configuration sections and compact admin controls.

# Modal header unification analysis

Branch: `feature/unify-modal-headers`

## Scope

Compared the header structure and styling of these modals:

- Todo modal
- Settings modal
- Project modal
- Workspace modal

Goal shape Tobi described: title icon → title → save button when dirty → menu button for existing/editable entity → close button always visible.

## Current implementation matrix

| Modal | Header DOM | Save button | Menu button | Close button | Styling family |
| --- | --- | --- | --- | --- | --- |
| Todo | Static title/header in `web/index.html`; actions are injected at runtime by `ensureTodoDetailHeaderMenu()` in `web/static/js/features/todos.js` | Injected into `#todo-detail-header-actions`; hidden when unchanged | Injected; hidden for new todos | Static `.modal-close-x` | Mixed: `.todo-modal-*`, `.ui-detail-*`, plus todo-specific overrides in `94-todo-detail-header-actions.css` |
| Settings | Static `settings-modal-header` in `web/index.html` | None | None | Static `.modal-close-x` | Separate settings-specific shell in `71-settings.css` |
| Project | Static `ui-detail-header-actions` inside header in `web/index.html` | Static button; hidden when unchanged by JS | Static details menu; hidden when not deletable | Static `.modal-close-x` | Shared `.ui-detail-*` plus entity base in `82-entity-modals.css` |
| Workspace | Static `ui-detail-header-actions` inside header in `web/index.html` | Static button; hidden when unchanged by JS | Static details menu; hidden when not deletable | Static `.modal-close-x` | Shared `.ui-detail-*` plus entity base in `82-entity-modals.css` |

## Concrete differences found

### 1. Todo actions are created differently than Project/Workspace

Todo creates header actions dynamically in `web/static/js/features/todos.js` via `ensureTodoDetailHeaderMenu()` and appends them to `.todo-modal-header`.

Project and Workspace declare the same action block statically in `web/index.html`.

This means the intended shared header exists in two patterns:

- runtime-generated for Todo
- static DOM for Project/Workspace

That makes drift likely and makes a shared primitive harder to maintain.

### 2. Settings is not in the shared detail modal system

Settings uses:

- `#settings-modal .settings-modal-content`
- `.settings-modal-header`
- separate close button styling in `71-settings.css`

It visually imitates parts of the detail header, but does not use `.ui-detail-modal`, `.ui-detail-modal-header`, `.ui-detail-title-icon`, or `.ui-detail-header-actions`.

It also nests icon and title inside one `<h3>` instead of using the same sibling structure as Todo/Project/Workspace.

### 3. Header action placement depends on absolute positioning

Shared CSS in `89-ui-detail-modal.css` positions actions and close button absolutely:

- `.ui-detail-header-actions { position: absolute; top: 19px; right: ... }`
- `.modal-close-x { position: absolute; top: 19px; right: ... }`

The close button and menu button should align because both use the same top value and both are `40px` high. But because actions are logically inside the header while positioned relative to the modal content, any competing CSS or missing shared class can make this fragile.

### 4. There are duplicated Todo-specific overrides for header controls

`94-todo-detail-header-actions.css` repeats a lot of the rules already present in `89-ui-detail-modal.css`, especially close/menu dimensions, top/right, icon size, hover/focus behavior.

Todo currently looks good, but it is not a clean single source of truth.

### 5. Project/Workspace menu markup is slightly different from Todo menu markup

Todo menu summary uses generated SVG markup from `iconSvg('menu')`.

Project/Workspace use `<span data-icon="menu"></span>` and rely on icon hydration.

After hydration the result is likely visually equivalent, but it is still another implementation split.

### 6. Settings close button is separately positioned

Settings close button repeats the same idea as detail modals:

- desktop top/right in `71-settings.css`
- mobile top/right in `71-settings.css`

This is another parallel implementation that should probably be folded into a shared header/action primitive if Settings is meant to match the other modal headers.

## Likely cause of the visible Project X/menu misalignment

The Project modal has the intended shared class names, but its header action block is static and lives inside `.entity-modal-header`, while positioning comes from the shared absolute `.ui-detail-header-actions` rules. The close button is a sibling after the header.

So the visual alignment currently depends on two independently-positioned absolute elements rather than one shared header action row containing save/menu/close. If one selector is overridden or resolved differently, the buttons drift vertically. The Todo modal happens to have extra todo-specific overrides that may mask the issue.

## Recommended fix direction

Create one canonical modal header/action primitive and migrate all four modals to it.

Recommended DOM shape:

```html
<div class="ui-modal-header">
  <div class="ui-modal-title-icon" data-icon="..."></div>
  <div class="ui-modal-title-copy">
    <h3>...</h3>
    <p>...</p>
  </div>
  <div class="ui-modal-header-actions">
    <button class="btn btn-primary" hidden>Save</button>
    <details class="ui-modal-header-menu" hidden>...</details>
    <button class="modal-close-x">...</button>
  </div>
</div>
```

Key point: menu and X should be in the same flex row, not independently absolute-positioned siblings.

That gives one vertical alignment rule:

```css
.ui-modal-header-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.ui-modal-header-icon-button {
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
```

Suggested migration order:

1. Extract shared CSS for detail/modal header, action row, icon buttons, title icon.
2. Convert Project + Workspace first, because their save/menu buttons are already static and similar.
3. Convert Todo to static header actions or a shared JS helper, removing Todo-specific duplicate CSS.
4. Convert Settings to the same header skeleton with Save/Menu omitted.
5. Remove redundant CSS from `71-settings.css`, `82-entity-modals.css`, and `94-todo-detail-header-actions.css` once parity is verified.

## Files touched by the future implementation

Likely implementation files:

- `web/index.html`
- `web/static/css/71-settings.css`
- `web/static/css/80-form-todo-modal.css`
- `web/static/css/82-entity-modals.css`
- `web/static/css/89-ui-detail-modal.css`
- `web/static/css/94-todo-detail-header-actions.css`
- `web/static/js/features/todos.js`
- possibly `web/static/js/features/projects.js`
- possibly `web/static/js/features/workspaces.js`

## Analysis-only status

No functional implementation has been made yet. This branch currently only contains this analysis document.

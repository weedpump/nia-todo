import { updateTopbarToggle } from '../ui/topbar-toggle.js';

export function createCompletedVisibilityFeature({
  getHidden = () => true,
  setHidden = () => {},
  storage = globalThis.localStorage,
  root = globalThis.document,
  translate = key => key,
  renderTasks = () => {},
  renderShopping = () => {},
  storageKey = 'nia-hide-done',
} = {}) {
  let bound = false;

  function updateButtons() {
    const hidden = getHidden() !== false;
    for (const button of root?.querySelectorAll?.('[data-completed-visibility-toggle]') || []) {
      const label = translate(hidden ? button.dataset.completedShowKey : button.dataset.completedHideKey);
      updateTopbarToggle(button, {
        pressed: !hidden,
        label,
        title: label,
      });
    }
  }

  function toggle() {
    const next = !(getHidden() !== false);
    setHidden(next);
    storage?.setItem?.(storageKey, next ? 'true' : 'false');
    updateButtons();
    renderTasks();
    renderShopping();
    return next;
  }

  function bind() {
    if (bound) return;
    bound = true;
    root?.addEventListener?.('click', event => {
      if (!event.target?.closest?.('[data-completed-visibility-toggle]')) return;
      event.preventDefault?.();
      toggle();
    });
  }

  return { bind, toggle, updateButtons };
}

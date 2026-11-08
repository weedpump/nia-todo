import { t } from '../i18n/index.js';
import { escapeHtmlAttr } from '../core/utils.js';
import { iconSvg } from '../icons/lucide-icons.js';

export function renderImagePicker({ prefix, labelKey, chooseKey, removeKey, accept = 'image/jpeg,image/png,image/webp' }) {
  const id = suffix => escapeHtmlAttr(`${prefix}-${suffix}`);
  const text = key => `<span data-i18n-key="${escapeHtmlAttr(key)}">${escapeHtmlAttr(t(key))}</span>`;
  return `<details id="${id('picker')}" class="ui-image-picker" data-ui-editor-menu data-label-key="${escapeHtmlAttr(labelKey)}" data-has-image="false">
    <summary id="${id('trigger')}" class="ui-image-picker-trigger" aria-label="${escapeHtmlAttr(t(chooseKey))}" aria-expanded="false" aria-controls="${id('menu')}">
      <span id="${id('preview')}" class="ui-image-picker-preview" hidden><img id="${id('preview-img')}" alt=""></span>
      <span class="ui-image-picker-placeholder" aria-hidden="true">${iconSvg('image')}${text(chooseKey)}</span>
      <span class="ui-image-picker-overlay" aria-hidden="true" hidden>${iconSvg('pencil')}${text('common.edit')}</span>
    </summary>
    <input id="${id('file')}" type="file" hidden tabindex="-1" accept="${escapeHtmlAttr(accept)}" aria-label="${escapeHtmlAttr(t(chooseKey))}">
    <div id="${id('menu')}" class="ui-menu ui-image-picker-menu" role="menu" aria-label="${escapeHtmlAttr(t(labelKey))}" hidden>
      <button id="${id('choose')}" type="button" class="ui-menu-item" role="menuitem">${iconSvg('upload')}${text(chooseKey)}</button>
      <button id="${id('remove')}" type="button" class="ui-menu-item danger" role="menuitem" hidden>${iconSvg('trash-2')}${text(removeKey)}</button>
    </div>
  </details>`;
}

export function createImagePickerController({ prefix, root = globalThis.document, canEdit = () => true,
  getHasImage = () => false, onRemove = () => {}, } = {}) {
  let bound = false;
  const element = suffix => root.getElementById(`${prefix}-${suffix}`);
  const picker = () => element('picker');
  const editable = () => Boolean(canEdit());
  function close({ restoreFocus = false } = {}) {
    const details = picker();
    if (!details) return;
    details.open = false;
    element('menu').hidden = true;
    element('trigger').setAttribute('aria-expanded', 'false');
    if (restoreFocus && editable() && element('trigger').isConnected) element('trigger').focus();
  }
  function closeOtherMenus() {
    root.querySelectorAll('details[data-ui-editor-menu][open]').forEach(other => {
      if (other === picker()) return;
      other.open = false;
      other.querySelector('summary')?.setAttribute('aria-expanded', 'false');
    });
  }
  function fitMenu() {
    const menu = element('menu');
    menu.style.transform = '';
    if (menu.hidden) return;
    const width = root.documentElement?.clientWidth || root.defaultView?.innerWidth || 0;
    if (!width) return;
    const bounds = menu.getBoundingClientRect();
    const offset = bounds.left < 8 ? 8 - bounds.left : bounds.right > width - 8 ? width - 8 - bounds.right : 0;
    if (offset) menu.style.transform = `translateX(${offset}px)`;
  }
  function refresh() {
    const details = picker();
    if (!details) return;
    const allowed = editable(), hasImage = Boolean(getHasImage());
    details.dataset.hasImage = String(hasImage);
    details.dataset.disabled = String(!allowed);
    if (!allowed || !hasImage) close();
    const trigger = element('trigger');
    trigger.tabIndex = allowed ? 0 : -1;
    trigger.setAttribute('aria-disabled', String(!allowed));
    trigger.setAttribute('aria-label', hasImage ? `${t('common.edit')}: ${t(labelKey())}` : t(chooseKey()));
    trigger.setAttribute('aria-expanded', String(details.open));
    if (hasImage) trigger.setAttribute('aria-haspopup', 'menu'); else trigger.removeAttribute('aria-haspopup');
    element('file').disabled = !allowed;
    element('file').setAttribute('aria-label', t(chooseKey()));
    element('choose').disabled = !allowed;
    element('remove').disabled = !allowed || !hasImage;
    element('remove').hidden = !hasImage;
    element('menu').hidden = !allowed || !details.open;
    element('menu').setAttribute('aria-label', t(labelKey()));
    details.querySelector('.ui-image-picker-placeholder').hidden = !element('preview').hidden;
    details.querySelector('.ui-image-picker-overlay').hidden = !hasImage;
    details.querySelectorAll('[data-i18n-key]').forEach(node => { node.textContent = t(node.dataset.i18nKey); });
    fitMenu();
  }
  // Translation keys stay with the renderer so callers supply them only once.
  const keyFor = suffix => element(suffix)?.querySelector('[data-i18n-key]')?.dataset.i18nKey;
  const chooseKey = () => keyFor('choose');
  const labelKey = () => picker()?.dataset.labelKey;
  function choose() {
    if (!editable()) { refresh(); return; }
    close({ restoreFocus: true });
    const input = element('file');
    input.value = '';
    input.click();
  }
  function bind() {
    if (bound || !picker()) return;
    bound = true;
    element('trigger').addEventListener('click', event => {
      event.preventDefault();
      if (!editable()) { refresh(); return; }
      if (!getHasImage()) { choose(); return; }
      closeOtherMenus();
      picker().open = !picker().open;
      refresh();
    });
    element('choose').addEventListener('click', event => { event.preventDefault(); choose(); });
    element('remove').addEventListener('click', event => {
      event.preventDefault();
      if (!editable() || !getHasImage()) { refresh(); return; }
      close();
      try { onRemove(); } finally { refresh(); close({ restoreFocus: true }); }
    });
    picker().addEventListener('toggle', () => {
      if (picker().open) closeOtherMenus();
      refresh();
    });
    picker().addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229
        || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      if (!editable() || !getHasImage()) return;
      const trigger = element('trigger'), menu = element('menu');
      if (event.target !== trigger && !menu.contains(event.target)) return;
      event.preventDefault();
      picker().open = true; closeOtherMenus(); refresh();
      const controls = Array.from(menu.querySelectorAll('button:not([disabled]):not([hidden])'));
      const index = controls.indexOf(root.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % controls.length
          : index < 0 ? controls.length - 1 : (index - 1 + controls.length) % controls.length;
      controls[next]?.focus();
    });
    root.addEventListener('click', event => { if (picker() && !picker().contains(event.target)) close(); });
    root.addEventListener('focusin', event => { if (picker() && !picker().contains(event.target)) close(); });
    root.addEventListener('toggle', event => {
      if (event.target !== picker() && event.target.matches?.('details[data-ui-editor-menu][open]')) close();
    }, true);
    root.defaultView?.addEventListener('resize', fitMenu);
    root.defaultView?.addEventListener('nia-language-change', refresh);
    refresh();
  }
  return { bind, refresh, close };
}

import { niaIconSvg } from '../icons/nia-product-icons.js';
import { t } from '../i18n/index.js';
import { getModule, isModuleId, MODULES, persistModule, readStoredModule } from '../modules/registry.js';

function currentModule(moduleId) {
  return getModule(moduleId);
}

export function createModuleSwitcher({ onModuleChange, getModules = () => MODULES } = {}) {
  let activeModuleId = readStoredModule();
  let bound = false;

  function close() {
    document.getElementById('module-switcher-menu')?.classList.remove('open');
    document.getElementById('module-switcher-button')?.setAttribute('aria-expanded', 'false');
  }

  function render() {
    const active = currentModule(activeModuleId);
    const modules = getModules();
    const switchingAvailable = modules.length > 1;
    const root = document.getElementById('module-switcher');
    const button = document.getElementById('module-switcher-button');
    const buttonIcon = document.getElementById('module-switcher-current-icon');
    const name = document.getElementById('module-switcher-current-name');
    const chevron = document.querySelector('.module-switcher-chevron');
    const menu = document.getElementById('module-switcher-menu');
    const app = document.getElementById('app');
    if (!root || !button || !buttonIcon || !name || !chevron || !menu || !app) return;

    app.dataset.activeModule = active.id;
    root.hidden = false;
    root.dataset.switchingAvailable = String(switchingAvailable);
    buttonIcon.innerHTML = niaIconSvg(active.icon);
    name.textContent = t(active.labelKey);
    button.disabled = !switchingAvailable;
    chevron.toggleAttribute('hidden', !switchingAvailable);
    menu.toggleAttribute('hidden', !switchingAvailable);
    menu.setAttribute('aria-label', t('moduleSwitcher.menuLabel'));
    if (!switchingAvailable) {
      button.removeAttribute('aria-haspopup');
      button.removeAttribute('aria-label');
      button.removeAttribute('data-i18n-aria-label-key');
      close();
      menu.innerHTML = '';
      return;
    }
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-label', t('moduleSwitcher.toggle'));
    button.setAttribute('data-i18n-aria-label-key', 'moduleSwitcher.toggle');
    menu.innerHTML = `
      <div class="module-switcher-menu-brand">
        <span class="nia-brand-icon" aria-hidden="true">${niaIconSvg('nia')}</span>
        <div><strong>Nia</strong><span>${t('moduleSwitcher.change')}</span></div>
      </div>
      <div class="module-switcher-options" role="none">
        ${modules.map(module => `
          <button type="button" class="module-switcher-option${module.id === active.id ? ' active' : ''}" data-module-action="select" data-module-id="${module.id}" role="menuitemradio" aria-checked="${module.id === active.id}">
            <span class="module-switcher-option-icon" aria-hidden="true">${niaIconSvg(module.icon)}</span>
            <span class="module-switcher-option-copy"><strong>${t(module.labelKey)}</strong><small>${t(module.descriptionKey)}</small></span>
            <span class="module-switcher-option-state" aria-hidden="true"></span>
          </button>
        `).join('')}
      </div>
    `;
  }

  function setActiveModule(moduleId) {
    if (!isModuleId(moduleId) || !getModules().some(module => module.id === moduleId)) return;
    activeModuleId = moduleId;
    persistModule(activeModuleId);
    onModuleChange?.(activeModuleId);
    document.getElementById('module-switcher-button')?.focus();
  }

  function syncActiveModule(moduleId) {
    if (!isModuleId(moduleId)) return;
    activeModuleId = moduleId;
    persistModule(activeModuleId);
    render();
    close();
  }

  function toggle(event) {
    event?.stopPropagation?.();
    const menu = document.getElementById('module-switcher-menu');
    const button = document.getElementById('module-switcher-button');
    if (!menu || !button || button.disabled) return;
    const open = !menu.classList.contains('open');
    menu.classList.toggle('open', open);
    button.setAttribute('aria-expanded', String(open));
  }

  function bind() {
    if (bound) return;
    bound = true;
    render();
    const root = document.getElementById('module-switcher');
    root?.addEventListener('click', event => {
      event.stopPropagation();
      const target = event.target?.closest?.('[data-module-action]');
      if (!target) return;
      event.preventDefault();
      const action = target.dataset.moduleAction;
      if (action === 'toggle') toggle(event);
      if (action === 'select') setActiveModule(target.dataset.moduleId);
    });
    document.addEventListener('click', close);
    window.addEventListener('nia-language-change', render);
  }

  return { bind, close, render, setActiveModule, syncActiveModule, getActiveModule: () => activeModuleId };
}

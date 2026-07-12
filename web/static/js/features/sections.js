import { escapeHtml, escapeHtmlAttr } from '../core/utils.js';
import { iconSvg } from '../icons/lucide-icons.js';
import { t } from '../i18n/index.js';

export function createSectionsFeature({ getTodos, getCurrentProjectId, getSections, renderTodos }) {
  function renderSectionHeader(section, visibleTodos = null) {
    const todos = visibleTodos || getTodos();
    const currentProjectId = getCurrentProjectId();

    if (section) {
      const count = todos.filter(t => t.section_id === section.id && t.project_id === currentProjectId).length;
      return `
        <div class="section-header" data-section-id="${escapeHtmlAttr(section.id)}" draggable="true">
          <span class="section-name" data-section-action="edit" data-section-id="${escapeHtmlAttr(section.id)}">${escapeHtml(section.name)}</span>
          <span class="section-count">${count}</span>
          <button class="section-delete" data-section-action="delete" data-section-id="${escapeHtmlAttr(section.id)}" title="${escapeHtmlAttr(t('section.delete'))}">${iconSvg('x')}</button>
        </div>
      `;
    }

    const unsortedCount = todos.filter(t => !t.section_id && t.project_id === currentProjectId).length;
    return `
      <div class="section-header section-unsorted" data-section-id="null">
        <span class="section-name">${escapeHtml(t('section.unsorted'))}</span>
        <span class="section-count">${unsortedCount}</span>
      </div>
    `;
  }

  function showAddSectionForm() {
    const el = document.querySelector('.add-section-row');
    if (!el) return;
    el.innerHTML = `
      <div class="inline-section-form">
        <input type="text" id="new-section-name" data-section-input="new" placeholder="${escapeHtmlAttr(t('section.namePlaceholder'))}" autocomplete="off">
        <button type="button" class="btn btn-secondary btn-icon" data-section-action="save-new" title="${escapeHtmlAttr(t('common.save'))}">${iconSvg('check')}</button>
        <button type="button" class="btn btn-secondary btn-icon" data-section-action="cancel" title="${escapeHtmlAttr(t('common.cancel'))}">${iconSvg('x')}</button>
      </div>
    `;
    document.getElementById('new-section-name')?.focus();
  }

  function editSectionInline(id) {
    const section = getSections().find(s => String(s.id) === String(id));
    if (!section) return;

    const header = document.querySelector(`.section-header[data-section-id="${escapeHtmlAttr(id)}"]`);
    if (!header) return;

    header.innerHTML = `
      <div class="inline-edit-form">
        <input type="text" id="edit-section-name-${escapeHtmlAttr(id)}" data-section-input="edit" data-section-id="${escapeHtmlAttr(id)}" value="${escapeHtmlAttr(section.name)}" autocomplete="off">
        <button type="button" class="btn btn-secondary btn-icon" data-section-action="save-edit" data-section-id="${escapeHtmlAttr(id)}" title="${escapeHtmlAttr(t('common.save'))}">${iconSvg('check')}</button>
        <button type="button" class="btn btn-secondary btn-icon" data-section-action="cancel" title="${escapeHtmlAttr(t('common.cancel'))}">${iconSvg('x')}</button>
      </div>
    `;
    document.getElementById(`edit-section-name-${id}`)?.focus();
  }

  return { renderSectionHeader, showAddSectionForm, editSectionInline };
}

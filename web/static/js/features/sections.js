import { escapeHtml, escapeHtmlAttr, jsArg } from '../core/utils.js';
import { iconSvg } from '../icons/lucide-icons.js';
import { t } from '../i18n/index.js';

export function createSectionsFeature({ getTodos, getCurrentProjectId, getSections, renderTodos }) {
  function renderSectionHeader(section, visibleTodos = null) {
    const todos = visibleTodos || getTodos();
    const currentProjectId = getCurrentProjectId();

    if (section) {
      const count = todos.filter(t => t.section_id === section.id && t.project_id === currentProjectId).length;
      return `
        <div class="section-header" data-section-id="${escapeHtmlAttr(section.id)}" draggable="true"
          ondragstart="handleSectionDragStart(event)" ondragend="handleSectionDragEnd(event)"
          ondragover="handleSectionDragOver(event)" ondrop="handleSectionDrop(event)">
          <span class="section-name" onclick="editSectionInline(${jsArg(section.id)})">${escapeHtml(section.name)}</span>
          <span class="section-count">${count}</span>
          <button class="section-delete" onclick="event.stopPropagation(); deleteSection(${jsArg(section.id)})" title="${escapeHtmlAttr(t('section.delete'))}">${iconSvg('x')}</button>
        </div>
      `;
    }

    const unsortedCount = todos.filter(t => !t.section_id && t.project_id === currentProjectId).length;
    return `
      <div class="section-header section-unsorted" data-section-id="null"
        ondragover="handleSectionDragOver(event)" ondrop="handleSectionDrop(event)">
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
        <input type="text" id="new-section-name" placeholder="${escapeHtmlAttr(t('section.namePlaceholder'))}" autocomplete="off"
          onkeydown="if(event.key==='Enter')saveNewSection();if(event.key==='Escape')renderTodos();">
        <button onclick="saveNewSection()" title="${escapeHtmlAttr(t('common.save'))}">${iconSvg('check')}</button>
        <button onclick="renderTodos()" title="${escapeHtmlAttr(t('common.cancel'))}">${iconSvg('x')}</button>
      </div>
    `;
    document.getElementById('new-section-name')?.focus();
  }

  function editSectionInline(id) {
    const section = getSections().find(s => s.id === id);
    if (!section) return;

    const header = document.querySelector(`.section-header[data-section-id="${escapeHtmlAttr(id)}"]`);
    if (!header) return;

    header.innerHTML = `
      <div class="inline-edit-form" style="flex:1;gap:6px;">
        <input type="text" id="edit-section-name-${escapeHtmlAttr(id)}" value="${escapeHtmlAttr(section.name)}" autocomplete="off" style="flex:1;"
          onkeydown="if(event.key==='Enter')saveSectionEdit(${jsArg(id)});if(event.key==='Escape')renderTodos();">
        <button onclick="saveSectionEdit(${jsArg(id)})" title="${escapeHtmlAttr(t('common.save'))}">${iconSvg('check')}</button>
        <button onclick="renderTodos()" title="${escapeHtmlAttr(t('common.cancel'))}">${iconSvg('x')}</button>
      </div>
    `;
    document.getElementById(`edit-section-name-${id}`)?.focus();
  }

  return { renderSectionHeader, showAddSectionForm, editSectionInline };
}

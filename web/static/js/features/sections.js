import { renderSectionHeader as renderSharedSectionHeader } from './section-ui.js';
import { t } from '../i18n/index.js';

export function createSectionsFeature({ getTodos, getCurrentProjectId }) {
  function renderSectionHeader(section, visibleTodos = null) {
    const todos = visibleTodos || getTodos();
    const currentProjectId = getCurrentProjectId();
    const count = section
      ? todos.filter(todo => String(todo.section_id) === String(section.id) && String(todo.project_id) === String(currentProjectId)).length
      : todos.filter(todo => !todo.section_id && String(todo.project_id) === String(currentProjectId)).length;
    return renderSharedSectionHeader({
      section,
      count,
      canManage: Boolean(section),
      unsortedLabel: t('section.unsorted'),
      deleteLabel: t('section.delete'),
    });
  }

  return { renderSectionHeader };
}

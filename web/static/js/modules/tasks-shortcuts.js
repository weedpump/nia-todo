export const TASK_SHORTCUTS_HTML = `
<section class="ui-section-card ui-detail-section ui-section-divider shortcuts-section" aria-labelledby="shortcuts-tasks-title">
  <div class="ui-section-heading ui-detail-section-heading is-title-only">
    <div class="ui-section-icon ui-detail-section-icon" data-icon="check-circle"></div>
    <div><h4 id="shortcuts-tasks-title" data-i18n-key="module.tasks.label">Aufgaben</h4></div>
  </div>
  <div class="shortcuts-list">
    <div class="shortcuts-row"><span class="shortcuts-label" data-i18n-key="shortcuts.newTodo">Neues Todo erstellen</span><span class="shortcuts-keys"><kbd>N</kbd></span></div>
    <div class="shortcuts-row"><span class="shortcuts-label" data-i18n-key="shortcuts.todayView">Heute-Ansicht umschalten</span><span class="shortcuts-keys"><kbd>T</kbd></span></div>
    <div class="shortcuts-row"><span class="shortcuts-label" data-i18n-key="shortcuts.calmView">Ruhige Ansicht umschalten</span><span class="shortcuts-keys"><kbd>C</kbd></span></div>
  </div>
</section>
<section class="ui-section-card ui-detail-section ui-section-divider shortcuts-section" aria-labelledby="shortcuts-todo-list-title">
              <div class="ui-section-heading ui-detail-section-heading is-title-only">
                <div class="ui-section-icon ui-detail-section-icon" data-icon="list-todo"></div>
                <div><h4 id="shortcuts-todo-list-title" data-i18n-key="shortcuts.section.todoList">Todo-Liste</h4></div>
              </div>
              <div class="shortcuts-list">
                <div class="shortcuts-row"><span class="shortcuts-label" data-i18n-key="shortcuts.cycleStatus">Status des fokussierten Todos weiterschalten</span><span class="shortcuts-keys"><kbd>Space</kbd></span></div>
                <div class="shortcuts-row"><span class="shortcuts-label" data-i18n-key="shortcuts.deleteTodo">Fokussiertes Todo löschen</span><span class="shortcuts-keys"><kbd>Delete</kbd></span></div>
              </div>
            </section>
            <section class="ui-section-card ui-detail-section ui-section-divider shortcuts-section" aria-labelledby="shortcuts-editor-title">
              <div class="ui-section-heading ui-detail-section-heading is-title-only">
                <div class="ui-section-icon ui-detail-section-icon" data-icon="pencil"></div>
                <div><h4 id="shortcuts-editor-title" data-i18n-key="shortcuts.section.editor">Todo-Editor</h4></div>
              </div>
              <div class="shortcuts-list">
                <div class="shortcuts-row"><span class="shortcuts-label" data-i18n-key="shortcuts.saveTodo">Todo aus dem Titelfeld speichern</span><span class="shortcuts-keys"><kbd>Ctrl</kbd><span>+</span><kbd>Enter</kbd><span class="shortcuts-key-alternative" aria-hidden="true">/</span><span class="visually-hidden" data-i18n-key="shortcuts.or">oder</span><kbd>⌘</kbd><span>+</span><kbd>Enter</kbd></span></div>
                <div class="shortcuts-row"><span class="shortcuts-label" data-i18n-key="shortcuts.multiAddNext">Mehrfachanlage: neue Zeile</span><span class="shortcuts-keys"><kbd>Enter</kbd></span></div>
                <div class="shortcuts-row"><span class="shortcuts-label" data-i18n-key="shortcuts.multiAddRemove">Mehrfachanlage: leere Zeile entfernen</span><span class="shortcuts-keys"><kbd>Backspace</kbd></span></div>
                <div class="shortcuts-row"><span class="shortcuts-label" data-i18n-key="shortcuts.multiAddSave">Mehrfachanlage speichern</span><span class="shortcuts-keys"><kbd>Ctrl</kbd><span>+</span><kbd>Enter</kbd><span class="shortcuts-key-alternative" aria-hidden="true">/</span><span class="visually-hidden" data-i18n-key="shortcuts.or">oder</span><kbd>⌘</kbd><span>+</span><kbd>Enter</kbd></span></div>
              </div>
            </section>
`;

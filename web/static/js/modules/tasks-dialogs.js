import { escapeHtmlAttr } from '../core/utils.js';
import { renderEntityAppearanceFields } from '../features/entity-appearance.js';
import { renderEntityDetailHeader } from '../features/entity-detail-header.js';
import { t } from '../i18n/index.js';

// Task-owned dialogs are mounted with the tasks module.
export const TASK_DIALOGS_HTML = `
  <!-- Dashboard Preferences Modal -->
  <div class="modal ui-detail-modal ui-detail-view dashboard-preferences-modal" id="dashboard-preferences-modal" aria-hidden="true" role="dialog" aria-modal="true" aria-labelledby="dashboard-preferences-modal-title">
    <div class="modal-overlay" data-dashboard-preferences-action="cancel"></div>
    <div class="modal-content entity-modal-content ui-detail-modal-content dashboard-preferences-modal-content">
      <div class="entity-modal-header dashboard-preferences-modal-header ui-detail-modal-header">
        <div class="entity-modal-title-icon ui-detail-title-icon" data-icon="sliders-horizontal"></div>
        <div>
          <h3 id="dashboard-preferences-modal-title" data-i18n-key="dashboard.preferences.title">Dashboard anpassen</h3>
          <p data-i18n-key="dashboard.preferences.subtitle">Blende Unwichtiges aus und richte das Dashboard auf deinen Alltag aus.</p>
        </div>
        <div class="ui-detail-header-actions">
          <button type="submit" form="dashboard-preferences-form" class="btn btn-primary" id="dashboard-preferences-save" aria-label="Speichern" data-i18n-aria-label-key="common.save"><span class="dashboard-preferences-save-icon" data-icon="check" aria-hidden="true"></span><span class="dashboard-preferences-save-label" data-i18n-key="common.save">Speichern</span></button>
          <button type="button" class="btn btn-secondary btn-icon" id="dashboard-preferences-reset" data-dashboard-preferences-action="reset" title="Zurücksetzen" aria-label="Zurücksetzen" data-i18n-title-key="focus.reset" data-i18n-aria-label-key="focus.reset"><span data-icon="rotate-ccw"></span></button>
          <button type="button" class="modal-close-x" data-dashboard-preferences-action="cancel" aria-label="Dashboard-Anpassung schließen" data-i18n-aria-label-key="dashboard.preferences.close"><span data-icon="x"></span></button>
        </div>
      </div>
      <div class="modal-body entity-modal-body ui-detail-modal-body">
        <form id="dashboard-preferences-form" class="entity-modal-form dashboard-preferences-shell ui-detail-shell">
          <section class="ui-section-card ui-detail-section ui-section-divider dashboard-preferences-sync-section">
            <div class="ui-section-heading ui-detail-section-heading dashboard-preferences-sync-heading">
              <div class="ui-section-icon ui-detail-section-icon" data-icon="cloud"></div>
              <div>
                <h4 id="dashboard-preferences-sync-label" data-i18n-key="dashboard.preferences.sync.label">Über meinen Account synchronisieren</h4>
                <p data-i18n-key="dashboard.preferences.sync.hint">Gleicht diese Einstellungen zwischen allen angemeldeten Apps und Browsern ab.</p>
              </div>
              <label class="dashboard-preferences-switch-control" for="dashboard-preferences-sync-enabled">
                <input type="checkbox" id="dashboard-preferences-sync-enabled" role="switch" aria-labelledby="dashboard-preferences-sync-label">
                <span class="dashboard-preferences-switch-track" aria-hidden="true"><span></span></span>
              </label>
            </div>
          </section>

          <section class="ui-section-card ui-detail-section ui-section-divider dashboard-preferences-workspace-section">
            <div class="ui-section-heading ui-detail-section-heading">
              <div class="ui-section-icon ui-detail-section-icon" data-icon="briefcase"></div>
              <div>
                <h4 data-i18n-key="dashboard.preferences.workspace.label">Workspace</h4>
                <p data-i18n-key="dashboard.preferences.workspace.hint">Jeder Workspace verwendet seine eigene Dashboard-Konfiguration.</p>
              </div>
            </div>
            <div class="form-group dashboard-preferences-workspace-field">
              <label for="dashboard-preferences-workspace" data-i18n-key="dashboard.preferences.workspace.select">Workspace auswählen</label>
              <select class="ui-field" id="dashboard-preferences-workspace" data-ui-select></select>
            </div>
          </section>

          <section class="ui-section-card ui-detail-section ui-section-divider">
            <div class="ui-section-heading ui-detail-section-heading">
              <div class="ui-section-icon ui-detail-section-icon" data-icon="layout-dashboard"></div>
              <div>
                <h4 data-i18n-key="dashboard.preferences.layout.title">Darstellung</h4>
                <p data-i18n-key="dashboard.preferences.layout.hint">Bestimme, wie ausführlich dein Dashboard sein soll.</p>
              </div>
            </div>
            <div class="dashboard-preferences-layout-controls">
              <div class="dashboard-preferences-toggle-list" aria-label="Dashboard-Inhalte" data-i18n-aria-label-key="dashboard.preferences.content.title">
                <label class="dashboard-preferences-toggle">
                  <span data-i18n-key="dashboard.preferences.layout.compact">Kompakte Darstellung</span>
                  <span class="ui-checkbox-label"><input type="checkbox" id="dashboard-preferences-compact-display"><span class="ui-checkbox-box" aria-hidden="true"><span data-icon="check"></span></span></span>
                </label>
                <label class="dashboard-preferences-toggle">
                  <span data-i18n-key="dashboard.preferences.layout.groupByStatus">Nach Status gruppieren</span>
                  <span class="ui-checkbox-label"><input type="checkbox" id="dashboard-preferences-group-by-status"><span class="ui-checkbox-box" aria-hidden="true"><span data-icon="check"></span></span></span>
                </label>
                <label class="dashboard-preferences-toggle">
                  <span data-i18n-key="dashboard.preferences.content.focus">„Jetzt relevant“ anzeigen</span>
                  <span class="ui-checkbox-label"><input type="checkbox" id="dashboard-preferences-show-focus"><span class="ui-checkbox-box" aria-hidden="true"><span data-icon="check"></span></span></span>
                </label>
                <label class="dashboard-preferences-toggle">
                  <span data-i18n-key="dashboard.preferences.content.projects">Aktive Projekte anzeigen</span>
                  <span class="ui-checkbox-label"><input type="checkbox" id="dashboard-preferences-show-active-projects"><span class="ui-checkbox-box" aria-hidden="true"><span data-icon="check"></span></span></span>
                </label>
                <label class="dashboard-preferences-toggle">
                  <span data-i18n-key="dashboard.preferences.content.projectWidgets">Projekt-Widgets anzeigen</span>
                  <span class="ui-checkbox-label"><input type="checkbox" id="dashboard-preferences-show-project-widgets"><span class="ui-checkbox-box" aria-hidden="true"><span data-icon="check"></span></span></span>
                </label>
              </div>
            </div>
          </section>

          <section class="ui-section-card ui-detail-section ui-section-divider">
            <div class="ui-section-heading ui-detail-section-heading">
              <div class="ui-section-icon ui-detail-section-icon" data-icon="folder-tree"></div>
              <div>
                <h4 data-i18n-key="dashboard.preferences.projects.title">Berücksichtigte Projekte</h4>
                <p data-i18n-key="dashboard.preferences.projects.hint">Diese Auswahl gilt nur für das Dashboard.</p>
              </div>
            </div>
            <div class="dashboard-preferences-project-controls">
              <div class="form-group">
                <label for="dashboard-preferences-project-scope" data-i18n-key="dashboard.preferences.projects.mode">Auswahl</label>
                <select class="ui-field" id="dashboard-preferences-project-scope" data-ui-select>
                  <option value="all" data-i18n-key="dashboard.preferences.projects.all">Alle Projekte</option>
                  <option value="include" data-i18n-key="dashboard.preferences.projects.include">Nur ausgewählte Projekte</option>
                  <option value="exclude" data-i18n-key="dashboard.preferences.projects.exclude">Ausgewählte Projekte ausschließen</option>
                </select>
              </div>
              <div class="form-group">
                <span class="form-label" id="dashboard-preferences-projects-label" data-i18n-key="focus.projects">Projekte</span>
                <div class="dashboard-preferences-projects" id="dashboard-preferences-projects" aria-labelledby="dashboard-preferences-projects-label"></div>
              </div>
            </div>
          </section>

          <section class="ui-section-card ui-detail-section ui-section-divider">
            <div class="ui-section-heading ui-detail-section-heading">
              <div class="ui-section-icon ui-detail-section-icon" data-icon="chart-no-axes-column"></div>
              <div>
                <h4 data-i18n-key="dashboard.preferences.stats.title">Kennzahlen</h4>
                <p data-i18n-key="dashboard.preferences.stats.hint">Wähle vier unterschiedliche Kacheln und ihre Reihenfolge.</p>
              </div>
            </div>
            <div class="dashboard-preferences-stat-grid" id="dashboard-preferences-stats">
              <div class="form-group"><label for="dashboard-preferences-stat-1" data-i18n-key="dashboard.preferences.stats.slot1">Kachel 1</label><select class="ui-field" id="dashboard-preferences-stat-1" data-ui-select data-dashboard-stat-slot="0"></select></div>
              <div class="form-group"><label for="dashboard-preferences-stat-2" data-i18n-key="dashboard.preferences.stats.slot2">Kachel 2</label><select class="ui-field" id="dashboard-preferences-stat-2" data-ui-select data-dashboard-stat-slot="1"></select></div>
              <div class="form-group"><label for="dashboard-preferences-stat-3" data-i18n-key="dashboard.preferences.stats.slot3">Kachel 3</label><select class="ui-field" id="dashboard-preferences-stat-3" data-ui-select data-dashboard-stat-slot="2"></select></div>
              <div class="form-group"><label for="dashboard-preferences-stat-4" data-i18n-key="dashboard.preferences.stats.slot4">Kachel 4</label><select class="ui-field" id="dashboard-preferences-stat-4" data-ui-select data-dashboard-stat-slot="3"></select></div>
            </div>
            <div class="settings-field-error" id="dashboard-preferences-error" role="alert"></div>
          </section>

          <section class="ui-section-card ui-detail-section ui-section-divider">
            <div class="ui-section-heading ui-detail-section-heading">
              <div class="ui-section-icon ui-detail-section-icon" data-icon="target"></div>
              <div>
                <h4 data-i18n-key="dashboard.preferences.focus.title">Jetzt relevant</h4>
                <p data-i18n-key="dashboard.preferences.focus.hint">Lege fest, welche handlungsrelevanten Gruppen erscheinen.</p>
              </div>
            </div>
            <div class="dashboard-preferences-choice-grid" id="dashboard-preferences-focus-items">
              <label class="dashboard-preferences-choice"><span class="ui-checkbox-label"><input type="checkbox" value="overdue" data-dashboard-focus-item><span class="ui-checkbox-box" aria-hidden="true"><span data-icon="check"></span></span></span><span data-i18n-key="dashboard.preferences.focus.overdue">Überfällig</span></label>
              <label class="dashboard-preferences-choice"><span class="ui-checkbox-label"><input type="checkbox" value="due_today" data-dashboard-focus-item><span class="ui-checkbox-box" aria-hidden="true"><span data-icon="check"></span></span></span><span data-i18n-key="dashboard.preferences.focus.today">Heute fällig</span></label>
              <label class="dashboard-preferences-choice"><span class="ui-checkbox-label"><input type="checkbox" value="due_week" data-dashboard-focus-item><span class="ui-checkbox-box" aria-hidden="true"><span data-icon="check"></span></span></span><span data-i18n-key="dashboard.preferences.focus.week">Nächste 7 Tage</span></label>
              <label class="dashboard-preferences-choice"><span class="ui-checkbox-label"><input type="checkbox" value="high_priority" data-dashboard-focus-item><span class="ui-checkbox-box" aria-hidden="true"><span data-icon="check"></span></span></span><span data-i18n-key="dashboard.preferences.focus.priority">Hohe Priorität</span></label>
            </div>
            <label class="dashboard-preferences-toggle dashboard-preferences-empty-focus">
              <span data-i18n-key="dashboard.preferences.focus.hideEmpty">Leere Gruppen ausblenden</span>
              <span class="ui-checkbox-label"><input type="checkbox" id="dashboard-preferences-hide-empty-focus"><span class="ui-checkbox-box" aria-hidden="true"><span data-icon="check"></span></span></span>
            </label>
          </section>

          <section class="ui-section-card ui-detail-section ui-section-divider">
            <div class="ui-section-heading ui-detail-section-heading">
              <div class="ui-section-icon ui-detail-section-icon" data-icon="folders"></div>
              <div>
                <h4 data-i18n-key="dashboard.preferences.activeProjects.title">Aktive Projekte</h4>
                <p data-i18n-key="dashboard.preferences.activeProjects.hint">Bestimme Anzahl und Sortierung der Projektliste.</p>
              </div>
            </div>
            <div class="ui-field-grid two-columns dashboard-preferences-grid">
              <div class="form-group">
                <label for="dashboard-preferences-project-limit" data-i18n-key="dashboard.preferences.activeProjects.limit">Anzahl</label>
                <select class="ui-field" id="dashboard-preferences-project-limit" data-ui-select><option value="2">2</option><option value="4">4</option><option value="6">6</option></select>
              </div>
              <div class="form-group">
                <label for="dashboard-preferences-project-sort" data-i18n-key="dashboard.preferences.activeProjects.sort">Sortierung</label>
                <select class="ui-field" id="dashboard-preferences-project-sort" data-ui-select>
                  <option value="recent" data-i18n-key="dashboard.preferences.activeProjects.recent">Zuletzt verwendet</option>
                  <option value="alphabetical" data-i18n-key="dashboard.preferences.activeProjects.alphabetical">Alphabetisch</option>
                  <option value="open_count" data-i18n-key="dashboard.preferences.activeProjects.openCount">Meiste offene Todos</option>
                </select>
              </div>
            </div>
          </section>
        </form>
      </div>
    </div>
  </div>

  <!-- Todo Modal -->
  <div class="modal ui-detail-modal" id="todo-modal">
    <div class="modal-overlay" data-close-modal="todo-modal"></div>
    <div class="modal-content todo-modal-content ui-detail-modal-content">
      <div class="todo-modal-header ui-detail-modal-header">
        <div class="todo-modal-title-icon ui-detail-title-icon" data-icon="check-circle"></div>
        <div>
          <h3 id="todo-modal-title" data-i18n-key="todo.new">New todo</h3>
          <p id="todo-modal-subtitle" data-i18n-key="todo.modal.subtitle">Capture the task, then add planning details only if needed.</p>
        </div>
        <div class="todo-detail-header-actions ui-detail-header-actions" id="todo-detail-header-actions">
          <button type="submit" form="todo-form" class="btn btn-primary" id="todo-save-btn" data-i18n-key="common.save">Save</button>
          <details class="todo-detail-header-menu-toggle ui-detail-header-menu-toggle">
            <summary aria-label="More actions" data-i18n-aria-label-key="common.more"><span data-icon="menu"></span></summary>
            <div class="todo-detail-header-menu ui-detail-header-menu ui-menu" role="menu">
              <button type="button" class="ui-menu-item" id="todo-detail-duplicate-action" role="menuitem"><span data-icon="copy"></span><span data-i18n-key="todo.duplicate">Duplicate</span></button>
              <button type="button" class="ui-menu-item danger" id="todo-detail-delete-action" role="menuitem"><span data-icon="trash-2"></span><span data-i18n-key="todo.delete">Delete</span></button>
            </div>
          </details>
          <button class="modal-close-x" data-close-modal="todo-modal"><span data-icon="x"></span></button>
        </div>
      </div>
      <div class="modal-body todo-modal-body ui-detail-modal-body">
      <form id="todo-form" class="todo-modal-form todo-editor-shell ui-detail-shell">
        <input type="hidden" id="todo-id">
        <div class="todo-create-mode-switch" id="todo-create-mode-switch" role="group" aria-label="Capture mode" data-i18n-aria-label-key="todo.multiAdd.modeLabel" hidden>
          <button type="button" class="todo-create-mode-btn active" data-todo-create-mode="single" aria-pressed="true" data-i18n-key="todo.multiAdd.modeSingle">One todo</button>
          <button type="button" class="todo-create-mode-btn" data-todo-create-mode="multi" aria-pressed="false" data-i18n-key="todo.multiAdd.modeMultiple">Multiple todos</button>
        </div>
        <section class="todo-multi-add-panel" id="todo-multi-add-panel" hidden>
          <div class="todo-multi-add-intro">
            <div class="todo-multi-add-intro-heading ui-section-heading ui-detail-section-heading">
              <div class="todo-multi-add-intro-icon ui-section-icon ui-detail-section-icon" data-icon="lightbulb" aria-hidden="true"></div>
              <div>
                <h4 data-i18n-key="todo.multiAdd.introTitle">Capture thoughts quickly</h4>
                <p data-i18n-key="todo.multiAdd.introDescription">Press Enter to start the next todo. Pasted bullet lists are split automatically.</p>
              </div>
            </div>
            <div class="todo-multi-add-counter" aria-live="polite">
              <strong id="todo-multi-add-count">0 todos</strong>
              <span id="todo-multi-add-limit">50 lines available</span>
            </div>
          </div>
          <div class="todo-multi-add-editor">
            <div class="todo-multi-add-rows" id="todo-multi-add-rows"></div>
            <div class="todo-multi-add-toolbar">
              <span class="todo-multi-add-toolbar-hint" data-i18n-key="todo.multiAdd.quickAddHint">Quick Add works per line: tomorrow, #Project, /Section, !high …</span>
              <button type="button" class="btn btn-secondary" id="todo-multi-add-more"><span data-icon="plus"></span> <span data-i18n-key="todo.multiAdd.addRow">Add another line</span></button>
            </div>
          </div>
          <section class="todo-multi-add-defaults ui-section-divider">
            <div class="todo-multi-add-defaults-head ui-section-heading ui-detail-section-heading">
              <div class="todo-multi-add-defaults-icon ui-section-icon ui-detail-section-icon" data-icon="sliders-horizontal"></div>
              <div>
                <h4 data-i18n-key="todo.multiAdd.defaultsTitle">Apply to all todos</h4>
                <p data-i18n-key="todo.multiAdd.defaultsDescription">Values entered directly in a line override these defaults.</p>
              </div>
            </div>
            <div class="todo-multi-add-defaults-grid">
              <div class="form-group">
                <label for="todo-multi-project" data-i18n-key="todo.project">Project</label>
                <select class="ui-field" id="todo-multi-project"></select>
              </div>
              <div class="form-group">
                <label for="todo-multi-section" data-i18n-key="todo.section">Section</label>
                <select class="ui-field" id="todo-multi-section" disabled>
                  <option value="" data-i18n-key="todo.section.none">No section (unsorted)</option>
                </select>
              </div>
              <div class="form-group">
                <label for="todo-multi-priority" data-i18n-key="todo.priority">Priority</label>
                <select class="ui-field" id="todo-multi-priority">
                  <option value="1" data-option-color="#ef4444" data-i18n-key="todo.priority.veryHigh">Very high</option>
                  <option value="2" data-option-color="#f59e0b" data-i18n-key="todo.priority.high">High</option>
                  <option value="3" data-option-color="#10b981" selected data-i18n-key="todo.priority.medium">Medium</option>
                  <option value="4" data-option-color="#94a3b8" data-i18n-key="todo.priority.low">Low</option>
                </select>
              </div>
            </div>
          </section>
        </section>
        <section class="ui-section-card ui-detail-section ui-section-divider ui-detail-title-section todo-section-card todo-editor-section todo-editor-main todo-main-section">
          <div class="ui-section-heading ui-detail-section-heading">
            <div class="ui-section-icon ui-detail-section-icon" data-icon="file-text"></div>
            <div>
              <h4 data-i18n-key="todo.section.content">Inhalt</h4>
              <p data-i18n-key="todo.section.contentHint">Titel und optionale Beschreibung.</p>
            </div>
          </div>
          <div class="form-group todo-title-group ui-detail-title-group">
            <label data-i18n-key="todo.title">Titel</label>
            <textarea class="ui-field ui-detail-title-field" id="todo-title" rows="1" required placeholder="Was ist zu tun?" data-i18n-placeholder-key="todo.titlePlaceholder"></textarea>
            <div class="quick-add-hint" data-i18n-key="quickAdd.hint">Tipp: „Milch morgen 18:00 erinnerung:17:30 wiederholung:wöchentlich ort:Zuhause #Einkauf /Kühlung !hoch“ erkennt Deadline, Erinnerung, Wiederholung, Ort, Projekt, Abschnitt und Priorität.</div>
            <div class="quick-add-preview" id="quick-add-preview" aria-live="polite" hidden></div>
          </div>
          <div class="form-group">
            <label data-i18n-key="todo.description">Beschreibung</label>
            <textarea class="ui-field" id="todo-desc" rows="3" placeholder="Details... Markdown: **fett**, *kursiv*, \`code\`, - Liste, [Link](url)" data-i18n-placeholder-key="todo.descriptionPlaceholder"></textarea>
            <div id="todo-desc-preview" class="ui-field desc-live-preview"></div>
          </div>
        </section>

        <section class="ui-section-card ui-detail-section ui-section-divider todo-section-card todo-editor-section todo-subtasks-card" id="todo-subtasks-panel">
          <div class="ui-section-heading ui-detail-section-heading">
            <div class="ui-section-icon ui-detail-section-icon" data-icon="list-todo"></div>
            <div>
              <h4 data-i18n-key="todo.subtasks">Subtasks</h4>
              <p data-i18n-key="todo.subtasks.hint">Add checklist items for this todo.</p>
            </div>
            <span class="todo-section-heading-spacer"></span>
            <span id="todo-subtasks-count" class="todo-meta-chip ui-badge todo-subtasks-progress" aria-live="polite">0/0</span>
          </div>
          <div class="todo-subtasks-editor">
            <div id="todo-subtasks-list" class="todo-subtasks-list"></div>
            <div class="form-group todo-subtasks-add-group">
              <label for="todo-subtask-new-title" data-i18n-key="todo.subtasks.newLabel">New subtask</label>
              <div class="todo-subtasks-add-row todo-detail-action-row">
                <input class="ui-field" type="text" id="todo-subtask-new-title" maxlength="500" placeholder="Nächster Schritt…" data-i18n-placeholder-key="todo.subtasks.placeholder">
                <button type="button" id="todo-subtask-add-btn" class="btn btn-secondary todo-detail-action-btn" data-todo-action="add-subtask"><span data-icon="plus"></span> <span data-i18n-key="common.add">Add</span></button>
              </div>
            </div>
          </div>
        </section>


        <section class="ui-section-card ui-detail-section ui-section-divider todo-section-card todo-editor-section todo-comments-card" id="todo-comments-panel">
          <div class="ui-section-heading ui-detail-section-heading">
            <div class="ui-section-icon ui-detail-section-icon" data-icon="notebook-pen"></div>
            <div>
              <h4 data-i18n-key="todo.comments">Comments</h4>
              <p data-i18n-key="todo.comments.hint">Add comments to this todo.</p>
            </div>
            <span class="todo-section-heading-spacer"></span>
            <span id="todo-comments-count" class="todo-meta-chip ui-badge todo-comments-progress" aria-live="polite">0</span>
          </div>
          <div class="todo-comments-editor">
            <div id="todo-comments-list" class="todo-comments-list"></div>
            <p id="todo-comments-empty" class="todo-comments-empty" data-i18n-key="todo.comments.empty">No comments yet.</p>
            <div class="form-group todo-comments-add-group">
              <label for="todo-comment-new-editor" data-i18n-key="todo.comments.newLabel">New comment</label>
              <div class="todo-comment-rich-wrap">
                <div class="todo-desc-rich-toolbar todo-comment-rich-toolbar" data-i18n-aria-label-key="todo.comments.formatToolbar"></div>
                <div id="todo-comment-new-editor" class="ui-field todo-comment-rich-editor" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder=""></div>
              </div>
              <button type="button" id="todo-comment-add-btn" class="btn btn-secondary todo-detail-action-btn" data-todo-action="add-comment"><span data-icon="plus"></span> <span data-i18n-key="todo.comments.add">Add</span></button>
            </div>
          </div>
        </section>

        <section class="ui-section-card ui-detail-section ui-section-divider todo-section-card todo-editor-section todo-attachments-card" id="todo-attachments-panel">
          <div class="ui-section-heading ui-detail-section-heading">
            <div class="ui-section-icon ui-detail-section-icon" data-icon="paperclip"></div>
            <div>
              <h4 data-i18n-key="todo.attachments">Attachments</h4>
              <p data-i18n-key="todo.attachments.hint">Attach files or photos to this todo.</p>
            </div>
            <span class="todo-section-heading-spacer"></span>
            <span id="todo-attachments-count" class="todo-meta-chip ui-badge todo-attachments-progress" aria-live="polite">0</span>
          </div>
          <div class="todo-attachments-editor">
            <div id="todo-attachments-list" class="todo-attachments-list"></div>
            <p id="todo-attachments-empty" class="todo-attachments-empty" data-i18n-key="todo.attachments.empty">No attachments yet.</p>
            <div class="form-group todo-attachments-add-group">
              <label for="todo-attachment-file" data-i18n-key="todo.attachments.newLabel">Add attachment</label>
              <div class="todo-attachments-add-row todo-detail-action-row has-drop-hint">
                <input type="file" id="todo-attachment-file" class="visually-hidden" multiple>
                <button type="button" class="todo-attachment-picker btn btn-secondary todo-detail-action-btn" data-todo-action="choose-attachment"><span data-icon="paperclip"></span> <span id="todo-attachment-file-name" data-i18n-key="todo.attachments.chooseFile">Datei auswählen</span></button>
                <button type="button" id="todo-attachment-upload-btn" class="btn btn-secondary todo-detail-action-btn" data-todo-action="upload-attachment"><span data-icon="upload"></span> <span data-i18n-key="todo.attachments.upload">Upload</span></button>
              </div>
            </div>
          </div>
        </section>


        <section class="ui-section-card ui-detail-section ui-section-divider todo-section-card todo-editor-section todo-editor-meta-panel" id="todo-organize-panel">
          <div class="ui-section-heading ui-detail-section-heading">
            <div class="ui-section-icon ui-detail-section-icon" data-icon="settings"></div>
            <div>
              <h4 data-i18n-key="todo.section.organize">Einordnen</h4>
              <p data-i18n-key="todo.section.organizeHint">Priorität, Status, Projekt und Section.</p>
            </div>
          </div>
          <div class="ui-field-grid two-columns">
            <div class="form-group">
              <label data-i18n-key="todo.priority">Priority</label>
              <select class="ui-field" id="todo-priority">
                <option value="1" data-option-color="#ef4444" data-i18n-key="todo.priority.veryHigh">Sehr hoch</option>
                <option value="2" data-option-color="#f59e0b" data-i18n-key="todo.priority.high">Hoch</option>
                <option value="3" data-option-color="#10b981" selected data-i18n-key="todo.priority.medium">Mittel</option>
                <option value="4" data-option-color="#94a3b8" data-i18n-key="todo.priority.low">Niedrig</option>
              </select>
            </div>
            <div class="form-group">
              <label data-i18n-key="todo.status">Status</label>
              <select class="ui-field" id="todo-status">
                <option value="pending" data-option-icon="clock" data-i18n-key="todo.status.pending">Offen</option>
                <option value="in_progress" data-option-icon="flame" data-i18n-key="todo.status.inProgress">In progress</option>
                <option value="done" data-option-icon="check-circle" data-i18n-key="todo.status.done">Erledigt</option>
              </select>
            </div>
            <div class="form-group">
              <label data-i18n-key="todo.project">Project</label>
              <select class="ui-field" id="todo-project"></select>
            </div>
            <div class="form-group">
              <label data-i18n-key="todo.section">Section</label>
              <select class="ui-field" id="todo-section" disabled>
                <option value="" data-i18n-key="todo.section.none">No section (unsorted)</option>
              </select>
            </div>
          </div>
          <div class="form-group checkbox-row pin-checkbox-row todo-pin-row">
            <label class="pin-checkbox-heading" for="todo-pinned" data-i18n-key="todo.pin">Anpinnen</label>
            <label class="pin-checkbox-label">
              <input type="checkbox" id="todo-pinned">
              <span class="pin-checkbox-box" aria-hidden="true"></span>
              <span data-i18n-key="todo.pinned">Oben anpinnen</span>
            </label>
          </div>
        </section>

        <section class="ui-section-card ui-detail-section ui-section-divider todo-section-card todo-editor-section todo-editor-meta-panel" id="todo-schedule-panel">
          <div class="ui-section-heading ui-detail-section-heading">
            <div class="ui-section-icon ui-detail-section-icon" data-icon="calendar-days"></div>
            <div>
              <h4 data-i18n-key="todo.section.schedule">Planung</h4>
              <p data-i18n-key="todo.section.scheduleHint">Deadline und Erinnerung, falls diese Aufgabe zeitkritisch ist.</p>
            </div>
          </div>
          <div class="ui-field-grid two-columns">
            <div class="form-group">
              <label for="todo-due-picker" data-i18n-key="todo.deadline">Deadline</label>
              <div class="datetime-input-wrap">
                <input class="datetime-picker-native-value" type="datetime-local" id="todo-due" min="1900-01-01T00:00" max="9999-12-31T23:59" step="60" tabindex="-1" aria-hidden="true">
                <button type="button" class="ui-field datetime-picker-trigger" id="todo-due-picker" data-datetime-picker-for="todo-due" aria-haspopup="dialog" aria-controls="date-time-picker-modal">
                  <span data-datetime-picker-display></span>
                  <span class="datetime-input-icon" data-icon="calendar-days" aria-hidden="true"></span>
                </button>
              </div>
              <div id="todo-due-error" class="form-error compact"></div>
            </div>
            <div class="form-group">
              <label for="todo-remind-picker" data-i18n-key="todo.reminder">Erinnerung</label>
              <div class="datetime-input-wrap">
                <input class="datetime-picker-native-value" type="datetime-local" id="todo-remind" min="1900-01-01T00:00" max="9999-12-31T23:59" step="60" tabindex="-1" aria-hidden="true">
                <button type="button" class="ui-field datetime-picker-trigger" id="todo-remind-picker" data-datetime-picker-for="todo-remind" aria-haspopup="dialog" aria-controls="date-time-picker-modal">
                  <span data-datetime-picker-display></span>
                  <span class="datetime-input-icon" data-icon="calendar-days" aria-hidden="true"></span>
                </button>
              </div>
              <div id="todo-remind-error" class="form-error compact"></div>
            </div>
          </div>
        </section>

        <section class="ui-section-card ui-detail-section ui-section-divider todo-section-card todo-editor-section todo-editor-meta-panel" id="todo-recurring-panel">
            <div class="ui-section-heading ui-detail-section-heading">
              <div class="ui-section-icon ui-detail-section-icon" data-icon="repeat"></div>
              <div>
                <h4 data-i18n-key="todo.recurring">Wiederholung</h4>
                <p id="todo-recurring-hint" data-i18n-key="todo.recurring.hint">Optional regelmäßig neu erstellen.</p>
              </div>
            </div>
            <div class="ui-field-grid two-columns">
              <div class="form-group">
                <label data-i18n-key="todo.recurring.frequency">Wiederholung</label>
                <select class="ui-field" id="todo-recurring-frequency">
                  <option value="none" selected data-option-icon="ban" data-i18n-key="todo.recurring.none">Keine Wiederholung</option>
                  <option value="daily" data-option-icon="repeat" data-i18n-key="todo.recurring.daily">Täglich</option>
                  <option value="weekly" data-option-icon="repeat" data-i18n-key="todo.recurring.weekly">Wöchentlich</option>
                  <option value="monthly" data-option-icon="repeat" data-i18n-key="todo.recurring.monthly">Monatlich</option>
                  <option value="yearly" data-option-icon="repeat" data-i18n-key="todo.recurring.yearly">Jährlich</option>
                </select>
              </div>
              <div class="form-group" id="todo-recurring-interval-group">
                <label data-i18n-key="todo.recurring.interval">Intervall</label>
                <input class="ui-field" type="number" id="todo-recurring-interval" min="1" max="999" step="1" value="1" inputmode="numeric">
              </div>
            </div>
        </section>

        <section class="ui-section-card ui-detail-section ui-section-divider todo-section-card todo-editor-section todo-editor-meta-panel todo-location-subsection" id="todo-location-reminder-panel">
            <div class="ui-section-heading ui-detail-section-heading">
              <div class="ui-section-icon ui-detail-section-icon" data-icon="map-pin"></div>
              <div>
                <h4 data-i18n-key="todo.location.title">Location reminder</h4>
                <p data-i18n-key="todo.location.hint">Funktioniert nur in der Android-App. Web/PWA kann ortsbezogene Erinnerungen nur anlegen und verwalten.</p>
              </div>
            </div>
            <div id="todo-location-fields" class="ui-field-grid two-columns todo-location-fields is-disabled">
              <div class="form-group">
                <label for="todo-location-trigger" data-i18n-key="todo.location.trigger">Trigger</label>
                <select class="ui-field" id="todo-location-trigger">
                  <option value="arrival" data-i18n-key="todo.location.arrival">When arriving</option>
                  <option value="departure" data-i18n-key="todo.location.departure">When leaving</option>
                </select>
              </div>
              <div class="form-group">
                <label for="todo-location-place" data-i18n-key="todo.location.savedPlace">Saved place</label>
                <select class="ui-field" id="todo-location-place">
                  <option value="" data-i18n-key="todo.location.manualAddress">Enter address manually</option>
                </select>
              </div>
              <div class="form-group" id="todo-location-address-group">
                <label for="todo-location-address" data-i18n-key="todo.location.address">Address</label>
                <input class="ui-field" type="text" id="todo-location-address" maxlength="500" placeholder="Street, city" data-i18n-placeholder-key="todo.location.addressPlaceholder">
              </div>
            </div>
            <div id="todo-location-error" class="form-error compact"></div>
        </section>
      </form>
      </div>
    </div>
  </div>

  <div class="modal ui-detail-modal ui-detail-view" id="project-modal" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="project-modal-title">
    <div class="modal-overlay" data-close-modal="project-modal"></div>
    <div class="modal-content entity-modal-content project-modal-content ui-detail-modal-content">
      ${renderEntityDetailHeader({
        headerClassNames: ['project-modal-header'],
        icon: 'folder',
        title: { id: 'project-modal-title', key: 'project.new' },
        subtitle: { key: 'project.modalHint' },
        actionsHtml: `
          <button type="submit" form="project-form" class="btn btn-primary" id="project-save-btn" data-i18n-key="common.save">${escapeHtmlAttr(t('common.save'))}</button>
          <details class="ui-detail-header-menu-toggle" id="project-detail-header-menu" hidden>
            <summary aria-label="${escapeHtmlAttr(t('common.more'))}" data-i18n-aria-label-key="common.more"><span data-icon="menu"></span></summary>
            <div class="ui-detail-header-menu ui-menu" role="menu">
              <button type="button" class="ui-menu-item danger" id="project-delete-btn" data-project-action="delete-from-modal" style="display:none;" role="menuitem"><span data-icon="trash-2"></span> <span data-i18n-key="project.delete">${escapeHtmlAttr(t('project.delete'))}</span></button>
            </div>
          </details>
          <button type="button" class="modal-close-x" data-close-modal="project-modal" aria-label="${escapeHtmlAttr(t('common.close'))}" data-i18n-aria-label-key="common.close"><span data-icon="x"></span></button>
        `,
      })}
      <div class="modal-body entity-modal-body ui-detail-modal-body">
        <form id="project-form" class="entity-modal-form ui-detail-shell">
          <input type="hidden" id="project-id">
          ${renderEntityAppearanceFields({ prefix: 'project' })}
          <section class="ui-section-card ui-detail-section ui-section-divider">
            <div class="ui-section-heading ui-detail-section-heading">
              <div class="ui-section-icon ui-detail-section-icon" data-icon="layout-dashboard"></div>
              <div>
                <h4 data-i18n-key="project.organization">Einordnung</h4>
                <p data-i18n-key="project.organizationHint">Workspace und Parent-Projekt bestimmen, wo das Projekt erscheint.</p>
              </div>
            </div>
            <div class="ui-field-grid two-columns project-organization-grid">
              <div class="form-group" id="project-household-group" style="display:none;">
                <label for="project-household-id" data-i18n-key="project.for">Projekt für</label>
                <select class="ui-field" id="project-household-id"></select>
                <div id="project-household-readonly" class="settings-readonly-value" hidden></div>
              </div>
              <div class="form-group" id="project-display-workspace-group" style="display:none;">
                <label data-i18n-key="project.displayWorkspace">Anzeigen in Workspace</label>
                <select class="ui-field" id="project-display-workspace-id"></select>
              </div>
              <div class="form-group">
                <label data-i18n-key="project.parent">Parent project (optional)</label>
                <select class="ui-field" id="project-parent-id">
                  <option value="" data-i18n-key="project.noParent">-- No parent project --</option>
                </select>
              </div>
            </div>
          </section>
        </form>

        <section id="project-sharing-section" class="ui-section-card ui-detail-section ui-section-divider project-sharing-card ui-detail-shell" style="display:none;">
          <div class="ui-section-heading ui-detail-section-heading">
            <div class="ui-section-icon ui-detail-section-icon" data-icon="share-2"></div>
            <div>
              <h4 data-i18n-key="project.share.sharedWith">Geteilt mit</h4>
              <p data-i18n-key="project.share.hint">Lade andere Nutzer zu diesem Projekt ein oder verwalte bestehende Mitglieder.</p>
            </div>
          </div>
          <div id="project-owner-info" class="project-owner-info" style="display:none;"><span class="project-owner-label" data-i18n-key="project.share.ownerLabel">Geteilt von</span><span class="project-owner-name"></span></div>
          <div id="project-sharing-content">
            <div id="project-members-list"></div>
            <div id="project-share-row" class="form-group project-share-row">
              <label data-i18n-key="project.share.inviteUser">Invite user</label>
              <div class="project-share-inline">
                <input id="project-share-username" type="text" class="ui-field" placeholder="Username or email" data-i18n-placeholder-key="project.share.usernamePlaceholder">
                <button type="button" class="btn btn-primary" data-project-sharing-action="invite" data-i18n-key="project.share.invite">Einladen</button>
              </div>
              <div id="project-share-error" class="form-error"></div>
            </div>
          </div>
          <div id="project-share-start-row" class="project-share-start-row ui-detail-action-row">
            <button type="button" class="btn btn-secondary" data-project-sharing-action="show-share-input"><span data-icon="share-2"></span> <span data-i18n-key="project.share.start">Teilen</span></button>
          </div>
          <div class="project-share-start-row ui-detail-action-row" id="project-leave-row" style="display:none;">
            <button type="button" class="btn btn-secondary" id="project-leave-btn" data-project-sharing-action="leave" data-i18n-key="project.share.leave">Leave project</button>
          </div>
        </section>
      </div>
    </div>
  </div>

  <div class="modal" id="attachment-preview-modal">
    <div class="modal-overlay" data-todo-action="close-attachment-preview"></div>
    <div class="modal-content attachment-preview-modal-content">
      <button class="modal-close-x" data-todo-action="close-attachment-preview"><span data-icon="x"></span></button>
      <div class="modal-header">
        <h3 id="attachment-preview-title" data-i18n-key="todo.attachments.preview">Vorschau</h3>
      </div>
      <div class="modal-body attachment-preview-body" id="attachment-preview-body"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-todo-action="close-attachment-preview" data-i18n-key="common.close">Schließen</button>
        <button type="button" class="btn btn-primary" id="attachment-preview-download-btn" data-todo-action="download-preview-attachment"><span data-icon="download"></span> <span data-i18n-key="todo.attachments.download">Download</span></button>
      </div>
    </div>
  </div>

    <div class="modal web-update-modal" id="android-location-permission-modal" aria-hidden="true" role="dialog" aria-modal="true" aria-labelledby="android-location-permission-title">
      <div class="modal-overlay web-update-backdrop"></div>
      <div class="modal-content web-update-content">
        <div class="web-update-icon" aria-hidden="true" data-icon="map-pin"></div>
        <h3 id="android-location-permission-title" data-i18n-key="todo.location.permission.title">Standortzugriff einrichten</h3>
        <p id="android-location-permission-message" data-i18n-key="todo.location.permission.body">Damit ortsbezogene Erinnerungen auch bei geschlossener App funktionieren, benötigt Nia dauerhaften Standortzugriff. Erlaube zuerst den genauen Standort. Wähle anschließend in den Android-App-Einstellungen „Immer zulassen“ und kehre zu Nia zurück.</p>
        <div class="web-update-actions">
          <button type="button" class="btn btn-secondary" id="android-location-permission-decline" data-i18n-key="todo.location.permission.decline">Nicht verwenden</button>
          <button type="button" class="btn btn-primary" id="android-location-permission-continue" data-i18n-key="todo.location.permission.continue">Berechtigungen einrichten</button>
        </div>
      </div>
    </div>
`;

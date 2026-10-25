export const TASK_SETTINGS_NAV_HTML = `
<button type="button" data-settings-section="settings-section-default-reminder"><span data-icon="bell"></span><span data-i18n-key="settings.defaultReminder.title">Default reminder</span></button>
<button type="button" data-settings-section="settings-section-attachments"><span data-icon="paperclip"></span><span data-i18n-key="settings.attachments.title">Anhänge</span></button>
<button type="button" data-settings-section="settings-section-places"><span data-icon="map-pin"></span><span data-i18n-key="settings.places.title">Places</span></button>
<button type="button" data-settings-section="settings-section-braindump" id="settings-nav-braindump"><span data-icon="sparkles"></span><span data-i18n-key="settings.braindump.title">BrainDump</span></button>
`;

export const TASK_SETTINGS_HTML = `
<section class="settings-section-card" id="settings-section-default-reminder">
            <div class="settings-section-heading">
              <div class="settings-section-icon" data-icon="bell"></div>
              <div>
                <h4 data-i18n-key="settings.defaultReminder.title">Default reminder</h4>
                <p data-i18n-key="settings.defaultReminder.hint">Automatically create a reminder when a todo gets a deadline and no explicit reminder is set.</p>
              </div>
            </div>
            <div class="settings-subcard">
              <label for="settings-default-reminder" data-i18n-key="settings.defaultReminder.label">Automatic reminder for deadlines</label>
              <select class="ui-field" id="settings-default-reminder" data-user-settings-input="default-reminder">
                <option value="off" data-i18n-key="settings.defaultReminder.off">Off</option>
                <option value="0" data-i18n-key="settings.defaultReminder.atDeadline">At deadline</option>
                <option value="15" data-i18n-key="settings.defaultReminder.before15m">15 minutes before</option>
                <option value="60" data-i18n-key="settings.defaultReminder.before1h">1 hour before</option>
                <option value="1440" data-i18n-key="settings.defaultReminder.before1d">1 day before</option>
                <option value="custom" data-i18n-key="settings.defaultReminder.custom">Custom...</option>
              </select>
              <div id="settings-default-reminder-custom-row" class="settings-default-reminder-custom-row" hidden>
                <div class="form-group settings-default-reminder-custom-field">
                  <label for="settings-default-reminder-custom" data-i18n-key="settings.defaultReminder.customAmountLabel">Amount</label>
                  <input class="ui-field" type="number" id="settings-default-reminder-custom" min="1" max="8760" step="1" inputmode="numeric" placeholder="Amount" data-i18n-placeholder-key="settings.defaultReminder.customPlaceholder">
                </div>
                <div class="form-group settings-default-reminder-custom-field">
                  <label for="settings-default-reminder-custom-unit" data-i18n-key="settings.defaultReminder.customUnitLabel">Unit</label>
                  <select class="ui-field" id="settings-default-reminder-custom-unit" data-i18n-aria-label-key="settings.defaultReminder.customUnitLabel">
                    <option value="hours" data-i18n-key="settings.defaultReminder.customHours">Hours before</option>
                    <option value="days" data-i18n-key="settings.defaultReminder.customDays">Days before</option>
                  </select>
                </div>
                <button type="button" class="btn btn-secondary" data-user-settings-action="save-custom-default-reminder" data-i18n-key="common.save">Save</button>
              </div>
              <div class="settings-help-text" data-i18n-key="settings.defaultReminder.help">Explicit reminders are kept and never overwritten.</div>
              <div id="settings-default-reminder-error" class="settings-field-error"></div>
              <div id="settings-default-reminder-success" class="settings-field-success"></div>
            </div>
          </section>

          <section class="settings-section-card" id="settings-section-attachments">
            <div class="settings-section-heading">
              <div class="settings-section-icon" data-icon="paperclip"></div>
              <div>
                <h4 data-i18n-key="settings.attachments.title">Anhänge</h4>
                <p data-i18n-key="settings.attachments.hint">Speichernutzung deiner Todo-Anhänge.</p>
              </div>
            </div>
            <div class="settings-subcard settings-attachments-usage-card">
              <div class="settings-field-row">
                <div class="settings-field-label" data-i18n-key="settings.attachments.status">Status</div>
                <div id="settings-attachments-status" class="settings-readonly-value">–</div>
              </div>
              <div class="settings-field-row">
                <div class="settings-field-label" data-i18n-key="settings.attachments.usage">Belegt</div>
                <div id="settings-attachments-usage" class="settings-readonly-value">–</div>
              </div>
              <div class="settings-attachments-meter"><span id="settings-attachments-meter-fill"></span></div>
              <div class="settings-help-text" id="settings-attachments-remaining">–</div>
            </div>
          </section>

          <section class="settings-section-card" id="settings-section-places">
            <div class="settings-section-heading">
              <div class="settings-section-icon" data-icon="map-pin"></div>
              <div>
                <h4 data-i18n-key="settings.places.title">Saved places</h4>
                <p data-i18n-key="settings.places.hint">Save labels like Home or Work with an address. BrainDump and location reminders use these places.</p>
              </div>
            </div>
            <div class="settings-place-form settings-place-add-row">
              <div class="form-group settings-place-name-group">
                <label for="settings-place-name" data-i18n-key="settings.places.nameLabel">Label</label>
                <input class="ui-field" type="text" id="settings-place-name" maxlength="120" placeholder="e.g. Home" data-i18n-placeholder-key="settings.places.namePlaceholder">
              </div>
              <div class="form-group settings-place-address-group">
                <label for="settings-place-address" data-i18n-key="settings.places.addressLabel">Address</label>
                <input class="ui-field" type="text" id="settings-place-address" maxlength="500" placeholder="Street, city" data-i18n-placeholder-key="settings.places.addressPlaceholder">
              </div>
              <button type="button" class="btn btn-secondary settings-place-save-btn" data-user-settings-action="save-place" disabled><span data-icon="plus" id="settings-place-save-icon"></span> <span id="settings-place-save-label" data-i18n-key="settings.places.save">Save place</span></button>
              <button type="button" class="btn btn-secondary settings-place-cancel-btn" id="settings-place-cancel-edit" data-user-settings-action="cancel-place-edit" hidden data-i18n-key="common.cancel">Cancel</button>
            </div>
            <div id="settings-places-error" class="settings-field-error"></div>
            <div id="settings-places-success" class="settings-field-success"></div>
            <div id="settings-places-list" class="settings-device-list"></div>
          </section>

          <section class="settings-section-card" id="settings-section-braindump">
            <div class="settings-section-heading">
              <div class="settings-section-icon" data-icon="sparkles"></div>
              <div>
                <h4 data-i18n-key="settings.braindump.title">BrainDump</h4>
                <p data-i18n-key="settings.braindump.hint">Lokale Lernfunktion für Projekt- und Section-Zuordnungen.</p>
              </div>
            </div>
            <div class="settings-subcard">
              <label class="settings-toggle-row settings-toggle-feature settings-switch-row">
                <span data-i18n-key="settings.braindump.learning.label">BrainDump merkt sich passende Listen</span>
                <input type="checkbox" class="settings-switch" id="settings-braindump-learning" data-user-settings-input="braindump-learning">
              </label>
              <div class="settings-help-text" data-i18n-key="settings.braindump.learning.help">
                Wenn du Aufgaben in eine andere Liste oder Section verschiebst, merkt sich BrainDump diese Entscheidung für dein Konto und schlägt sie beim nächsten Mal eher vor. Audio und gesprochener Text werden dafür nicht gespeichert.
              </div>
              <div class="settings-help-text" id="settings-braindump-learning-count"></div>
              <div class="settings-card-actions">
                <button type="button" class="btn btn-secondary" data-user-settings-action="reset-braindump-learning" data-i18n-key="settings.braindump.learning.reset">Gelernte Zuordnungen zurücksetzen</button>
              </div>
              <div id="settings-braindump-error" class="settings-field-error"></div>
              <div id="settings-braindump-success" class="settings-field-success"></div>
            </div>
          </section>
`;

export const TASK_DESKTOP_HOTKEYS_HTML = `
<div class="form-group">
                    <label data-i18n-key="settings.desktop.hotkeys.newTodo">Open a new todo directly</label>
                    <input class="hotkey-capture-input" type="text" id="desktop-hotkey-new-todo" inputmode="none" autocomplete="off" aria-label="Hotkey for new todo" data-i18n-aria-label-key="settings.desktop.hotkeys.newTodoAria">
                  </div>
<div class="form-group">
                    <label data-i18n-key="settings.desktop.hotkeys.search">Suche fokussieren</label>
                    <input class="hotkey-capture-input" type="text" id="desktop-hotkey-search" inputmode="none" autocomplete="off" aria-label="Hotkey for search" data-i18n-aria-label-key="settings.desktop.hotkeys.searchAria">
                  </div>
`;

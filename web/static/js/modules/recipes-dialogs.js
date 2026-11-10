import { t } from '../i18n/index.js';
import { escapeHtmlAttr } from '../core/utils.js';
import { renderEntityEditorModal } from '../features/entity-editor-modal.js';
import { renderEntityOwnershipField } from '../features/entity-ownership-field.js';
import { renderEntityDirectSharingSection } from '../features/entity-direct-sharing.js';
import { renderRecipeImportModal } from '../features/recipe-import.js';
import { renderRecipeEditorModal } from '../features/recipe-editor.js';
import { renderRecipeShoppingTransferModal } from '../features/recipe-shopping-transfer.js';

export const RECIPES_DIALOGS_HTML = renderEntityEditorModal({
  prefix: 'cookbook', icon: 'book-open',
  createTitleKey: 'cookbook.modal.createTitle', subtitleKey: 'cookbook.modal.subtitle', deleteKey: 'common.delete',
  formContentHtml: `
    <section class="ui-section-card ui-detail-section ui-section-divider">
      <div class="form-group">
        <label for="cookbook-description" data-i18n-key="entity.description">${escapeHtmlAttr(t('entity.description'))}</label>
        <textarea id="cookbook-description" class="ui-field" rows="3" maxlength="4000"></textarea>
      </div>
      ${renderEntityOwnershipField({ prefix: 'cookbook', labelKey: 'entity.ownership.for' })}
    </section>
    <div id="cookbook-error" class="settings-field-error" role="alert"></div>`,
  sharingHtml: renderEntityDirectSharingSection({ prefix: 'cookbook', leaveKey: 'entity.share.leave' }),
}) + renderRecipeEditorModal() + renderRecipeShoppingTransferModal() + renderRecipeImportModal();

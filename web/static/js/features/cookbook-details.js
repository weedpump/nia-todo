import { t } from '../i18n/index.js';
import { createEntityAppearanceController } from './entity-appearance.js';
import { createEntityOwnershipField, isHouseholdOwnedEntity } from './entity-ownership-field.js';
import { createEntityDirectSharingFeature } from './entity-direct-sharing.js';
import { createEntityEditorModalController } from './entity-editor-modal.js';
import { closeUiLayerNow } from './ui-history.js';
import { sameEntityId } from './entity-metadata.js';
import { cookbookMetadata } from './cookbooks.js';

export const canManageCookbook = book => book?.can_manage === true || book?.can_manage === 1;

/** Cookbook fields and domain operations; the window, save state and sharing are shared. */
export function createCookbookDetailsFeature({
  document: doc = globalThis.document, getCookbooks = () => [], cookbookController, cookbookApi,
  getSessionIdentity = () => null, getAccessSnapshot = () => globalThis.window?.niaAccessSnapshot || null,
  isOnlineForSync = () => false, syncWithServer = async () => {},
  confirmDanger = async () => false, selectCookbook = () => false,
  normalizeActiveCookbookNavigation = () => {}, focusActiveCookbookAction = () => {},
  refreshCookbooks = async () => {}, removeCookbookAccess = async () => {},
  getPendingMutations = async () => [],
  enqueueCookbookMutation = (_identity, task) => task(), onError = console.error,
} = {}) {
  let bound = false, generation = 0, busy = null, modalSession, renderedMetadata;
  const metadata = book => JSON.stringify([book?.name, book?.description, book?.color, book?.icon, book?.can_manage, book?.owner_household_id, book?.household_name, book?.owner_username, book?.owner_display_name]);
  const el = suffix => doc.getElementById(`cookbook-${suffix}`);
  const current = () => getCookbooks().find(book => sameEntityId(book.id, el('id')?.value));
  const present = () => el('modal')?.classList.contains('active');
  const inSession = () => getSessionIdentity() === modalSession;
  const error = key => { if (el('error')) el('error').textContent = key ? t(key) : ''; };
  const report = err => { if (err?.name !== 'AbortError') onError(err); };
  let modal;
  const appearance = createEntityAppearanceController({ prefix: 'cookbook', document: doc, defaultIcon: 'book-open',
    onChange: () => modal?.refreshSaveState() });
  const ownership = createEntityOwnershipField({ prefix: 'cookbook', document: doc,
    getHousehold: () => getAccessSnapshot()?.household || null,
    onChange: () => {
      const book = current();
      const transfer = Boolean(book && !isHouseholdOwnedEntity(book) && ownership.value());
      if (transfer) {
        appearance.setValues(book, { editable: false });
        el('description').value = book.description || '';
      } else appearance.setEditable(!book || canManageCookbook(book));
      el('description').disabled = Boolean(book && (!canManageCookbook(book) || transfer));
      modal?.refreshSaveState();
    },
  });
  async function sharingCall(method, ...args) {
    if ((method !== 'listMembers' && !present()) || !inSession() || !isOnlineForSync() || !current()) throw new Error(t('cookbook.error.onlineOnly'));
    return cookbookApi[method](...args);
  }
  const sharing = createEntityDirectSharingFeature({ prefix: 'cookbook', document: doc, confirmDanger,
    listMembers: id => sharingCall('listMembers', id),
    grantMember: (id, identifier) => sharingCall('shareCookbook', id, { identifier }),
    revokeMember: (id, memberId) => sharingCall('revokeMember', id, memberId),
    leaveEntity: id => sharingCall('leaveCookbook', id),
    onLeft: book => {
      if (!inSession()) return;
      const session = getSessionIdentity();
      const isCurrent = () => getSessionIdentity() === session;
      deactivate();
      Promise.resolve(removeCookbookAccess(book.id, { isCurrent })).then(() => {
        if (isCurrent()) return refreshCookbooks();
      }).then(() => {
        if (!isCurrent()) return;
        normalizeActiveCookbookNavigation(); focusActiveCookbookAction();
      }).catch(report);
    }, onError: report,
  });
  const sharingEntity = book => book && !String(book.id).startsWith('temp-') && isOnlineForSync() ? book : null;
  const readState = () => ({ ...appearance.readState(), description: String(el('description')?.value || '').trim(), household_id: ownership.value() });
  modal = createEntityEditorModalController({ prefix: 'cookbook', document: doc, appearanceController: appearance,
    ownershipController: ownership, sharingController: { setEntity: book => sharing.setEntity(sharingEntity(book)) },
    readState, isValid: state => Boolean(state.name) && state.name.length <= 200 && state.description.length <= 4000,
    canSubmit: () => !busy && inSession() && (!el('id')?.value || canManageCookbook(current())),
    resolveView: ({ entity: book }) => {
      const editable = !book || canManageCookbook(book);
      return { mode: book ? 'edit' : 'create', titleKey: book ? 'cookbook.modal.editTitle' : 'cookbook.modal.createTitle',
        appearance: book || { name: '', color: '#6366f1', icon: 'book-open' }, appearanceEditable: editable,
        ownershipCanManage: editable, canDelete: Boolean(book && editable), readOnly: !editable,
        restoreFocus: () => Array.from(doc.querySelectorAll('[data-entity-sidebar-action][data-entity-type="cookbook"]'))
          .find(button => book ? button.dataset.entitySidebarAction === 'detail' && sameEntityId(button.dataset.entityId, el('id')?.value || book.id)
            : button.dataset.entitySidebarAction === 'add'),
      };
    },
    renderDomain: ({ entity }) => { el('description').value = entity?.description || ''; },
    applyDomainPermissions: ({ view }) => {
      el('description').disabled = !view.appearanceEditable;
      el('description').setAttribute('aria-readonly', view.appearanceEditable ? 'false' : 'true');
    }, clearError: () => error(''), onSubmit: save, onDelete: remove, onError: report,
  });
  function deactivate() {
    generation++; busy = null;
    sharing.setEntity(null);
    if (!closeUiLayerNow('cookbook-modal', { reason: 'module-deactivate' })) modal.close({ fromHistory: true });
  }
  function showCookbookModal(book = null) {
    if (book && !getCookbooks().some(candidate => sameEntityId(candidate.id, book.id))) return false;
    generation++; busy = null; modalSession = getSessionIdentity(); renderedMetadata = metadata(book);
    return modal.open(book);
  }
  function reconcileCookbooksChanged() {
    if (!present() || !el('id')?.value) return false;
    const latest = current();
    if (!latest) { deactivate(); return true; }
    if (!canManageCookbook(latest) && (modal.getCurrentView()?.readOnly !== true || renderedMetadata !== metadata(latest))) {
      renderedMetadata = metadata(latest);
      modal.reconcile(latest); modal.resetSaveState();
      el('modal').querySelector('.modal-close-x')?.focus();
    }
    return false;
  }
  function remapCookbookId(from, to) {
    if (!sameEntityId(el('id')?.value, from)) return false;
    el('id').value = String(to);
    const latest = current();
    if (latest) Promise.resolve(sharing.setEntity(sharingEntity(latest))).catch(report);
    modal.refreshSaveState();
    return true;
  }
  async function transfer(book, state, isCurrent) {
    const household = getAccessSnapshot()?.household;
    if (!household || !sameEntityId(household.id, state.household_id)) return null;
    if (!isOnlineForSync() || String(book.id).startsWith('temp-')) { error('cookbook.error.onlineOnly'); return null; }
    const yes = await confirmDanger({ title: t('cookbook.transfer.title'),
      message: t('cookbook.transfer.message', { name: book.name, household: household.name }),
      confirmText: t('cookbook.transfer.confirm'), returnFocus: () => doc.querySelector('[data-select-id="cookbook-household-id"] .ui-select-trigger') });
    if (!isCurrent()) return null;
    if (!yes) { ownership.render(book, { canManage: canManageCookbook(book) }); modal.resetSaveState(); return null; }
    const latest = current();
    if (!latest || !canManageCookbook(latest) || !sameEntityId(getAccessSnapshot()?.household?.id, household.id)) return null;
    return enqueueCookbookMutation(cookbookController.resolveIdentity(latest.id), async () => {
      await syncWithServer();
      const pending = await getPendingMutations();
      let target = current();
      if (!isCurrent() || !canManageCookbook(target) || !sameEntityId(getAccessSnapshot()?.household?.id, household.id)) return null;
      if (pending.some(entry => [target.id, target.client_mutation_id, book.id].some(id => id != null && cookbookMetadata.references(entry, id)))) {
        error('cookbook.error.onlineOnly'); return null;
      }
      const result = await cookbookApi.transferToHousehold(target.id, household.id);
      if (!isCurrent()) return null;
      await refreshCookbooks();
      return result;
    });
  }
  async function save(event) {
    event?.preventDefault?.();
    if (busy || !present() || !inSession() || !modal.canSave()) return;
    const book = current(), id = el('id').value, state = readState();
    if (id && !canManageCookbook(book)) { reconcileCookbooksChanged(); return; }
    const requestedGeneration = generation, session = getSessionIdentity(), token = {};
    const isCurrent = () => requestedGeneration === generation && present() && getSessionIdentity() === session;
    busy = token; modal.refreshSaveState();
    try {
      const saved = book && !isHouseholdOwnedEntity(book) && state.household_id
        ? await transfer(book, state, isCurrent)
        : book ? await cookbookController.update(book.id, { name: state.name, description: state.description, color: state.color, icon: state.icon }, { isCurrent })
          : await cookbookController.create({ ...state, household_id: state.household_id || null }, { isCurrent });
      if (!isCurrent()) return;
      if (!saved) { reconcileCookbooksChanged(); return; }
      generation++;
      modal.close({ afterClose: () => { if (!book) selectCookbook(saved.id); focusActiveCookbookAction(); } });
      if (isOnlineForSync()) Promise.resolve(syncWithServer()).catch(report);
    } catch (err) { if (isCurrent()) { error('cookbook.error.saveFailed'); report(err); } }
    finally { if (busy === token) { busy = null; if (requestedGeneration === generation) modal.refreshSaveState(); } }
  }
  async function remove() {
    const book = current();
    if (busy || !inSession() || !canManageCookbook(book)) return;
    const requestedGeneration = generation, session = getSessionIdentity(), token = {};
    const isCurrent = () => requestedGeneration === generation && present() && getSessionIdentity() === session;
    busy = token; modal.refreshSaveState();
    try {
      const yes = await confirmDanger({ title: t('cookbook.delete.title'), message: t('cookbook.delete.message', { name: book.name }),
        confirmText: t('common.delete'), returnFocus: () => el('detail-header-menu-trigger') });
      if (!yes || !isCurrent()) return;
      const deleted = await cookbookController.remove(book.id, { isCurrent });
      if (!isCurrent()) {
        if (deleted && getSessionIdentity() === session && !present()) {
          normalizeActiveCookbookNavigation(); focusActiveCookbookAction();
        }
        return;
      }
      if (!deleted) { reconcileCookbooksChanged(); return; }
      generation++;
      modal.close({ afterClose: () => { normalizeActiveCookbookNavigation(); focusActiveCookbookAction(); } });
      if (isOnlineForSync()) Promise.resolve(syncWithServer()).catch(report);
    } catch (err) { if (isCurrent()) { error('cookbook.error.deleteFailed'); report(err); } }
    finally { if (busy === token) { busy = null; if (requestedGeneration === generation) modal.refreshSaveState(); } }
  }
  return { bind: () => { if (bound) return; bound = true; modal.bind(); sharing.bind(); },
    showCookbookModal, reconcileCookbooksChanged, reconcile: reconcileCookbooksChanged, remapCookbookId,
    closeModal: () => { generation++; return modal.close(); }, deactivate, save, deleteCurrentCookbook: remove };
}

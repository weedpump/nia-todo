import { openUiLayer, registerUiLayer, requestCloseUiLayer } from './ui-history.js';
import { attachmentCache as defaultAttachmentCache } from '../storage/attachment-cache.js';

export function getAttachmentAvailability(attachment = {}) {
  if (attachment.failed_permanent) {
    return {
      key: 'todo.attachments.statusPermanentFailure',
      error: String(attachment.sync_error?.message || '').trim(),
      failed: true,
    };
  }
  return {
    key: attachment.is_pending ? 'todo.attachments.statusPending' : 'todo.attachments.statusOnlineOnly',
    error: '',
    failed: false,
  };
}

export function createTodoAttachmentsFeature({
  getTodos,
  setTodos,
  getProjects,
  getCurrentUser,
  setCurrentUser,
  getAppInitialized,
  getDb,
  dbPut,
  dbPutStrict = dbPut,
  dbGetAll = async () => [],
  dbGetAllStrict = dbGetAll,
  deleteFromDB = async () => {},
  deleteFromDBStrict = deleteFromDB,
  dbTransactionStrict = null,
  runSyncQueueMutation = async operation => operation(async () => {}),
  isOnlineForSync,
  syncWithServer = async () => {},
  todosApi,
  attachmentCache = defaultAttachmentCache,
  renderStats,
  renderTodos,
  closeModal,
  confirmDanger,
  showToast,
  t,
  iconSvg,
  escapeHtmlAttr,
  setTodoCollapsibleOpen,
  refreshTodoActionButtonState,
  refreshTodoSaveButtonState,
  nativeBridge = null,
}) {
  let attachmentPreviewObjectUrl = '';
  let attachmentPreviewDownload = null;
  let attachmentPreviewGeneration = 0;
  let attachmentThumbnailObserver = null;
  let attachmentThumbnailRenderId = 0;
  const attachmentThumbnailObjectUrls = new Set();

  function applyAttachmentUsage(usage) {
    const currentUser = getCurrentUser?.();
    if (!usage || !currentUser) return;
    const next = { ...currentUser };
    const fields = {
      enabled: 'attachments_enabled',
      used_bytes: 'attachment_usage_bytes',
      quota_bytes: 'attachment_quota_bytes',
      remaining_bytes: 'attachment_remaining_bytes',
      allowed_types: 'attachments_allowed_types',
      max_upload_bytes: 'attachment_max_upload_bytes',
    };
    for (const [source, target] of Object.entries(fields)) {
      if (Object.prototype.hasOwnProperty.call(usage, source)) next[target] = usage[source];
    }
    setCurrentUser?.(next);
  }

  function formatAttachmentSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
    return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function attachmentIconName(attachment = {}) {
    const type = String(attachment.content_type || '').toLowerCase();
    const name = String(attachment.original_filename || '').toLowerCase();
    if (type.startsWith('image/')) return 'file-image';
    if (type === 'application/pdf' || name.endsWith('.pdf')) return 'file-type';
    return 'file';
  }

  function attachmentIsImagePreview(attachment = {}, blob = null) {
    const type = String(attachment.content_type || blob?.type || '').toLowerCase();
    const name = String(attachment.original_filename || '').toLowerCase();
    return type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(name);
  }

  function attachmentIsPdfPreview(attachment = {}, blob = null) {
    const type = String(attachment.content_type || blob?.type || '').toLowerCase();
    const name = String(attachment.original_filename || '').toLowerCase();
    return type === 'application/pdf' || name.endsWith('.pdf');
  }

  function attachmentCanPreview(attachment = {}) {
    return attachmentIsImagePreview(attachment) || attachmentIsPdfPreview(attachment);
  }

  function releaseAttachmentThumbnailObjectUrl(thumbnail) {
    const objectUrl = thumbnail?.dataset?.objectUrl;
    if (!objectUrl) return;
    URL.revokeObjectURL(objectUrl);
    attachmentThumbnailObjectUrls.delete(objectUrl);
    delete thumbnail.dataset.objectUrl;
  }

  function showAttachmentThumbnailFallback(thumbnail, fallback) {
    releaseAttachmentThumbnailObjectUrl(thumbnail);
    thumbnail?.removeAttribute('src');
    thumbnail?.classList.remove('is-loaded');
    fallback?.classList.remove('is-hidden');
  }

  function resetAttachmentThumbnails() {
    attachmentThumbnailRenderId += 1;
    attachmentThumbnailObserver?.disconnect();
    attachmentThumbnailObserver = null;
    for (const objectUrl of attachmentThumbnailObjectUrls) URL.revokeObjectURL(objectUrl);
    attachmentThumbnailObjectUrls.clear();
  }

  function observeAttachmentThumbnail(thumbnail, loadThumbnail) {
    thumbnail.loadAttachmentThumbnail = loadThumbnail;
    if (typeof globalThis.IntersectionObserver !== 'function') {
      void loadThumbnail();
      return;
    }
    if (!attachmentThumbnailObserver) {
      attachmentThumbnailObserver = new globalThis.IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          attachmentThumbnailObserver?.unobserve(entry.target);
          void entry.target.loadAttachmentThumbnail?.();
        }
      }, { rootMargin: '160px' });
    }
    attachmentThumbnailObserver.observe(thumbnail);
  }

  function createAttachmentThumbnail(todoId, attachment, fallback) {
    const thumbnail = document.createElement('img');
    thumbnail.className = 'todo-attachment-thumbnail';
    thumbnail.alt = '';
    thumbnail.loading = 'lazy';
    thumbnail.decoding = 'async';
    const renderId = attachmentThumbnailRenderId;
    thumbnail.addEventListener('load', () => {
      if (renderId !== attachmentThumbnailRenderId) return;
      thumbnail.classList.add('is-loaded');
      fallback.classList.add('is-hidden');
    });
    thumbnail.addEventListener('error', () => {
      showAttachmentThumbnailFallback(thumbnail, fallback);
    });
    observeAttachmentThumbnail(thumbnail, async () => {
      if (thumbnail.dataset.thumbnailState) return;
      thumbnail.dataset.thumbnailState = 'loading';
      try {
        const blob = await loadAttachmentBlob(todoId, attachment);
        if (renderId !== attachmentThumbnailRenderId) return;
        if (!attachmentIsImagePreview(attachment, blob)) throw new Error('Attachment is not a supported image');
        const objectUrl = URL.createObjectURL(blob);
        attachmentThumbnailObjectUrls.add(objectUrl);
        thumbnail.dataset.objectUrl = objectUrl;
        thumbnail.src = objectUrl;
      } catch (error) {
        if (renderId !== attachmentThumbnailRenderId) return;
        thumbnail.dataset.thumbnailState = 'failed';
        showAttachmentThumbnailFallback(thumbnail, fallback);
      }
    });
    return thumbnail;
  }

  function attachmentAllowedByClient(file, user = getCurrentUser?.()) {
    const allowed = Array.isArray(user?.attachments_allowed_types) ? user.attachments_allowed_types : [];
    if (!allowed.length) return true;
    const name = String(file?.name || '').toLowerCase();
    const type = String(file?.type || '').split(';', 1)[0].toLowerCase();
    return allowed.some((entry) => {
      const item = String(entry || '').toLowerCase().trim();
      if (!item) return false;
      if (item.startsWith('.')) return name.endsWith(item);
      if (item.endsWith('/*')) return type.startsWith(item.slice(0, -1));
      return type === item;
    });
  }

  function newAttachmentMutationId() {
    if (globalThis.crypto?.randomUUID) return `attachment-${globalThis.crypto.randomUUID()}`;
    return `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function loadAttachmentBlob(todoId, attachment) {
    const cached = await attachmentCache.get(attachment?.id, { todoId });
    if (cached?.blob) return cached.blob;
    if (!isOnlineForSync()) throw new Error('Attachment is not available offline');
    const blob = await todosApi.getAttachmentBlob(todoId, attachment.id);
    await attachmentCache.put({
      id: attachment.id,
      todo_id: todoId,
      attachment_id: attachment.id,
      blob,
      size_bytes: attachment.size_bytes || blob.size,
      pending_upload: false,
      pinned: false,
      offline_explicit: false,
    }).catch(error => console.warn('Failed to cache attachment download', error));
    return blob;
  }

  async function makeAttachmentAvailableOffline(todoId, attachment) {
    try {
      const blob = await loadAttachmentBlob(todoId, attachment);
      const cached = await attachmentCache.get(attachment.id, { touch: false, todoId });
      if (!cached) {
        await attachmentCache.put({ id: attachment.id, todo_id: todoId, attachment_id: attachment.id, blob, size_bytes: attachment.size_bytes || blob.size, pinned: true, offline_explicit: true });
      } else {
        await attachmentCache.setPinned(attachment.id, true);
      }
      showToast(t('todo.attachments.availableOffline'));
      renderTodoAttachments(getTodos().find(todo => String(todo.id) === String(todoId))?.attachments || [], getTodos().find(todo => String(todo.id) === String(todoId)) || null);
      return true;
    } catch (error) {
      console.error('Failed to cache todo attachment', error);
      showToast(t('todo.attachments.cacheFailed'));
      return false;
    }
  }

  async function queueAttachmentFiles(todoId, files = [], { todo: suppliedTodo = null, queueEntries = [] } = {}) {
    const selected = Array.from(files || []);
    if (!todoId || selected.length === 0 || !getDb()) return selected.length === 0;
    const todo = suppliedTodo || getTodos().find(item => String(item.id) === String(todoId));
    if (!todo || !dbTransactionStrict) return false;
    const currentUser = getCurrentUser?.();
    if (currentUser?.attachments_enabled === false) {
      showToast(t('todo.attachments.disabled'));
      return false;
    }
    const existingCount = Array.isArray(todo.attachments) ? todo.attachments.length : 0;
    if (existingCount + selected.length > 20) {
      showToast(t('todo.attachments.tooMany'));
      return false;
    }
    const maxUploadBytes = Number(currentUser?.attachment_max_upload_bytes || (25 * 1024 * 1024));
    if (selected.some(file => Number(file.size || 0) > maxUploadBytes)) {
      showToast(t('todo.attachments.fileTooLarge', { max: formatAttachmentSize(maxUploadBytes) }));
      return false;
    }
    const remainingBytes = Number(currentUser?.attachment_remaining_bytes ?? currentUser?.attachment_quota_bytes ?? Number.MAX_SAFE_INTEGER);
    const totalBytes = selected.reduce((sum, file) => sum + Number(file.size || 0), 0);
    if (totalBytes > Math.max(remainingBytes, 0)) {
      showToast(t('todo.attachments.quotaExceeded'));
      return false;
    }
    if (selected.some(file => !attachmentAllowedByClient(file, currentUser))) {
      showToast(t('todo.attachments.typeNotAllowed'));
      return false;
    }

    const pending = selected.map(file => {
      const tempId = newAttachmentMutationId();
      return {
        file,
        tempId,
        attachment: {
          id: tempId,
          todo_id: todoId,
          user_id: currentUser?.id,
          original_filename: file.name || 'attachment',
          content_type: file.type || 'application/octet-stream',
          size_bytes: Number(file.size || 0),
          created_at: new Date().toISOString(),
          uploader_username: currentUser?.username,
          uploader_display_name: currentUser?.display_name || currentUser?.username,
          is_pending: true,
        },
      };
    });
    const updated = {
      ...todo,
      attachments: [...(todo.attachments || []), ...pending.map(item => item.attachment)],
      attachments_count: existingCount + pending.length,
      updated_at: new Date().toISOString(),
    };
    const queueRecord = (action, data) => ({ action, data, timestamp: Date.now(), localUpdatedAt: new Date().toISOString() });
    try {
      await attachmentCache.requestPersistentStorage?.();
      await runSyncQueueMutation(() => dbTransactionStrict(['todos', 'syncQueue', 'attachmentBlobs'], 'readwrite', async transaction => {
        await transaction.put('todos', updated);
        for (const entry of queueEntries) await transaction.put('syncQueue', queueRecord(entry.action, entry.data));
        for (const item of pending) {
          await transaction.put('attachmentBlobs', {
            id: String(item.tempId),
            todo_id: todoId,
            attachment_id: item.tempId,
            blob: item.file,
            size_bytes: Number(item.file.size || 0),
            pending_upload: true,
            pinned: true,
            offline_explicit: false,
            last_accessed: Date.now(),
          });
          await transaction.put('syncQueue', queueRecord('CREATE_ATTACHMENT', {
            todo_id: todoId,
            temp_id: item.tempId,
            blob_id: item.tempId,
            client_mutation_id: item.tempId,
            filename: item.attachment.original_filename,
            content_type: item.attachment.content_type,
            size_bytes: item.attachment.size_bytes,
            local_attachment: item.attachment,
          }));
        }
      }));
      const known = getTodos().some(item => String(item.id) === String(todoId));
      setTodos(known
        ? getTodos().map(item => String(item.id) === String(todoId) ? updated : item)
        : [...getTodos(), updated]);
      if (typeof document !== 'undefined') renderTodoAttachments(updated.attachments || [], updated);
      renderStats();
      renderTodos();
      if (isOnlineForSync()) await syncWithServer();
      return true;
    } catch (error) {
      console.error('Failed to queue todo attachment', error);
      showToast(error?.name === 'AttachmentStorageError' ? t('todo.attachments.localStorageFull') : t('todo.attachments.uploadFailed'));
      return false;
    }
  }

  function getSelectedAttachmentFiles() {
    return Array.from(document.getElementById('todo-attachment-file')?.files || []);
  }

  function setSelectedAttachmentFileName(files = []) {
    const label = document.getElementById('todo-attachment-file-name');
    const picker = label?.closest?.('.todo-attachment-picker');
    if (!label) return;
    const selected = Array.isArray(files) ? files : (files ? [files] : []);
    const hasFile = selected.length > 0;
    if (selected.length === 1) {
      label.textContent = t('todo.attachments.selectedFile', { filename: selected[0].name });
      label.title = selected[0].name;
    } else if (selected.length > 1) {
      label.textContent = t('todo.attachments.selectedFiles', { count: selected.length });
      label.title = selected.map(file => file.name).join('\n');
    } else {
      label.textContent = t('todo.attachments.chooseFile');
      label.title = '';
    }
    picker?.classList.toggle('has-file', hasFile);
  }

  function setAttachmentInputFiles(files = []) {
    const input = document.getElementById('todo-attachment-file');
    if (!input) return;
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    input.files = transfer.files;
    setSelectedAttachmentFileName(Array.from(input.files));
    refreshTodoSaveButtonState();
  }

  function renderTodoAttachments(attachments = [], todo = null) {
    const todoId = todo?.id || null;
    const list = document.getElementById('todo-attachments-list');
    const empty = document.getElementById('todo-attachments-empty');
    const input = document.getElementById('todo-attachment-file');
    const uploadButton = document.getElementById('todo-attachment-upload-btn');
    const count = document.getElementById('todo-attachments-count');
    if (!list) return;
    const normalized = Array.isArray(attachments) ? attachments : [];
    resetAttachmentThumbnails();
    list.innerHTML = '';
    if (count) count.textContent = String(normalized.length);
    setTodoCollapsibleOpen('todo-attachments-panel', Boolean(todoId));
    if (empty) {
      empty.textContent = todoId ? t('todo.attachments.empty') : t('todo.attachments.draftEmpty');
      empty.hidden = normalized.length > 0;
    }
    if (input) {
      input.value = '';
      input.disabled = false;
      setSelectedAttachmentFileName([]);
    }
    if (uploadButton) uploadButton.disabled = true;
    refreshTodoActionButtonState();
    for (const attachment of normalized) {
      const item = document.createElement('article');
      item.className = 'todo-attachment-item';
      item.dataset.attachmentId = attachment.id;

      const icon = document.createElement('button');
      icon.type = 'button';
      icon.className = 'todo-attachment-icon';
      icon.setAttribute('aria-label', t('todo.attachments.preview'));
      icon.setAttribute('title', t('todo.attachments.preview'));
      icon.addEventListener('click', () => previewTodoAttachment(todoId, attachment));
      if (attachmentIsImagePreview(attachment)) {
        icon.classList.add('todo-attachment-thumbnail-button');
        const fallback = document.createElement('span');
        fallback.className = 'todo-attachment-thumbnail-fallback';
        fallback.innerHTML = iconSvg(attachmentIconName(attachment));
        fallback.setAttribute('aria-hidden', 'true');
        const thumbnail = createAttachmentThumbnail(todoId, attachment, fallback);
        icon.append(thumbnail, fallback);
      } else {
        icon.innerHTML = iconSvg(attachmentIconName(attachment));
      }

      const body = document.createElement('div');
      body.className = 'todo-attachment-body';
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'todo-attachment-name';
      name.textContent = attachment.original_filename || t('todo.attachments.unnamed');
      name.addEventListener('click', () => previewTodoAttachment(todoId, attachment));
      const meta = document.createElement('div');
      meta.className = 'todo-attachment-meta';
      const details = document.createElement('span');
      details.textContent = `${formatAttachmentSize(attachment.size_bytes)} · ${attachment.uploader_display_name || attachment.uploader_username || t('todo.attachments.unknownUploader')}`;
      const availability = document.createElement('span');
      availability.className = 'todo-attachment-availability';
      const availabilityState = getAttachmentAvailability(attachment);
      availability.textContent = availabilityState.error
        ? `${t(availabilityState.key)}: ${availabilityState.error}`
        : t(availabilityState.key);
      if (availabilityState.failed) availability.classList.add('is-failed');
      meta.append(details, availability);
      if (!attachment.is_pending) {
        void attachmentCache.get(attachment.id, { touch: false, todoId }).then((cached) => {
          if (!cached) return;
          availability.textContent = t('todo.attachments.statusCached');
          availability.classList.add('is-cached');
        });
      }
      body.append(name, meta);

      const actions = document.createElement('div');
      actions.className = 'todo-attachment-actions';
      const download = document.createElement('button');
      download.type = 'button';
      download.className = 'btn btn-secondary btn-small btn-icon';
      download.innerHTML = iconSvg('download');
      download.setAttribute('aria-label', t('todo.attachments.download'));
      download.setAttribute('title', t('todo.attachments.download'));
      download.addEventListener('click', () => downloadTodoAttachment(todoId, attachment.id, attachment.original_filename));
      actions.appendChild(download);
      if (!attachment.is_pending) {
        const offline = document.createElement('button');
        offline.type = 'button';
        offline.className = 'btn btn-secondary btn-small btn-icon';
        offline.innerHTML = iconSvg('download');
        offline.setAttribute('aria-label', t('todo.attachments.makeAvailableOffline'));
        offline.setAttribute('title', t('todo.attachments.makeAvailableOffline'));
        offline.addEventListener('click', () => makeAttachmentAvailableOffline(todoId, attachment));
        actions.appendChild(offline);
      }
      const currentUserId = getCurrentUser?.()?.id;
      const project = (getProjects?.() || []).find((item) => String(item.id) === String(todo?.project_id));
      const canDelete = String(attachment.user_id) === String(currentUserId)
        || String(todo?.user_id) === String(currentUserId)
        || project?.is_owner === true
        || project?.is_shared === true;
      if (canDelete) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-secondary btn-small btn-icon';
        remove.innerHTML = iconSvg('trash-2');
        remove.setAttribute('aria-label', t('todo.attachments.delete'));
        remove.setAttribute('title', t('todo.attachments.delete'));
        remove.addEventListener('click', () => deleteTodoAttachment(todoId, attachment.id));
        actions.appendChild(remove);
      }

      item.append(icon, body, actions);
      list.appendChild(item);
    }
  }

  async function applyAttachmentTodoResponse(response) {
    const updatedTodo = response?.todo;
    applyAttachmentUsage(response?.usage);
    if (!updatedTodo) return;
    await dbPutStrict('todos', updatedTodo);
    setTodos(getTodos().map(todo => String(todo.id) === String(updatedTodo.id) ? updatedTodo : todo));
    renderTodoAttachments(updatedTodo.attachments || [], updatedTodo);
    renderStats();
    renderTodos();
  }

  async function uploadTodoAttachmentFromInput() {
    if (!getAppInitialized() || !getDb()) return false;
    const id = document.getElementById('todo-id')?.value;
    const input = document.getElementById('todo-attachment-file');
    const files = getSelectedAttachmentFiles();
    if (!id) {
      showToast(t('todo.attachments.saveFirst'));
      return false;
    }
    if (files.length === 0) {
      input?.focus();
      return true;
    }
    const uploadButton = document.getElementById('todo-attachment-upload-btn');
    if (uploadButton) uploadButton.disabled = true;
    try {
      const queued = await queueAttachmentFiles(id, files);
      if (!queued) return false;
      setSelectedAttachmentFileName([]);
      if (input) input.value = '';
      const stillPending = (await dbGetAll('syncQueue')).some(item => item.action === 'CREATE_ATTACHMENT' && String(item.data?.todo_id) === String(id));
      showToast(stillPending
        ? t('todo.attachments.uploadPending')
        : (files.length === 1 ? t('todo.attachments.uploaded') : t('todo.attachments.uploadedMany', { count: files.length })));
      return true;
    } finally {
      if (uploadButton) uploadButton.disabled = false;
      refreshTodoActionButtonState();
    }
  }

  function clearAttachmentPreviewState() {
    attachmentPreviewGeneration += 1;
    const body = document.getElementById('attachment-preview-body');
    if (body) body.innerHTML = '';
    if (attachmentPreviewObjectUrl) URL.revokeObjectURL(attachmentPreviewObjectUrl);
    attachmentPreviewObjectUrl = '';
    attachmentPreviewDownload = null;
  }

  function closeAttachmentPreview({ fromHistory = false } = {}) {
    clearAttachmentPreviewState();
    if (document.getElementById('attachment-preview-modal')?.classList.contains('active') && !fromHistory && requestCloseUiLayer('attachment-preview-modal', { reason: 'ui' })) return;
    closeModal('attachment-preview-modal', { fromHistory: true });
    document.getElementById('attachment-preview-modal')?.classList.remove('show');
  }

  async function previewTodoAttachment(todoId, attachment) {
    if (!todoId || !attachment?.id) return;
    if (!attachmentCanPreview(attachment)) {
      showToast(t('todo.attachments.noPreview'));
      return downloadTodoAttachment(todoId, attachment.id, attachment.original_filename);
    }
    clearAttachmentPreviewState();
    const previewGeneration = attachmentPreviewGeneration;
    try {
      const blob = await loadAttachmentBlob(todoId, attachment);
      if (previewGeneration !== attachmentPreviewGeneration) return;
      const objectUrl = URL.createObjectURL(blob);
      if (previewGeneration !== attachmentPreviewGeneration) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      attachmentPreviewObjectUrl = objectUrl;
      attachmentPreviewDownload = { todoId, attachmentId: attachment.id, filename: attachment.original_filename || 'attachment' };
      const title = document.getElementById('attachment-preview-title');
      const body = document.getElementById('attachment-preview-body');
      const download = document.getElementById('attachment-preview-download-btn');
      if (title) title.textContent = attachment.original_filename || t('todo.attachments.preview');
      if (download) download.disabled = false;
      if (body) {
        if (attachmentIsImagePreview(attachment, blob)) {
          body.innerHTML = `<img src="${attachmentPreviewObjectUrl}" alt="${escapeHtmlAttr(attachment.original_filename || t('todo.attachments.preview'))}">`;
        } else if (attachmentIsPdfPreview(attachment, blob)) {
          body.innerHTML = `<iframe src="${attachmentPreviewObjectUrl}" title="${escapeHtmlAttr(attachment.original_filename || t('todo.attachments.preview'))}"></iframe>`;
        } else {
          body.textContent = t('todo.attachments.noPreview');
        }
      }
      const modal = document.getElementById('attachment-preview-modal');
      const alreadyOpen = modal?.classList.contains('active');
      modal?.classList.add('active');
      if (!alreadyOpen) openUiLayer('attachment-preview-modal');
    } catch (error) {
      if (previewGeneration !== attachmentPreviewGeneration) return;
      console.error('Failed to preview todo attachment', error);
      showToast(t('todo.attachments.previewFailed'));
    }
  }

  async function downloadPreviewAttachment() {
    if (!attachmentPreviewDownload) return;
    await downloadTodoAttachment(attachmentPreviewDownload.todoId, attachmentPreviewDownload.attachmentId, attachmentPreviewDownload.filename);
  }

  async function downloadTodoAttachment(todoId, attachmentId, filename) {
    if (!todoId || !attachmentId) return;
    try {
      const attachment = getTodos()
        .find(todo => String(todo.id) === String(todoId))
        ?.attachments?.find(item => String(item.id) === String(attachmentId)) || { id: attachmentId, original_filename: filename };
      const blob = await loadAttachmentBlob(todoId, attachment);
      if (nativeBridge?.isNative?.() && nativeBridge?.downloadToDownloads && isOnlineForSync()) {
        const result = await todosApi.downloadAttachmentNative(todoId, attachmentId, filename || 'attachment', nativeBridge);
        if (result) {
          showToast(result?.path
            ? t('todo.attachments.downloadSavedTo', { path: result.path })
            : t('todo.attachments.downloadStarted'));
          return;
        }
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename || attachment.original_filename || 'attachment';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error('Failed to download todo attachment', error);
      showToast(t('todo.attachments.downloadFailed'));
    }
  }

  async function deleteTodoAttachment(todoId, attachmentId) {
    if (!todoId || !attachmentId) return;
    const confirmed = await confirmDanger({
      title: t('todo.attachments.deleteTitle'),
      message: t('todo.attachments.deleteMessage'),
      confirmText: t('todo.attachments.deleteConfirm'),
    });
    if (!confirmed) return;
    const todo = getTodos().find(item => String(item.id) === String(todoId));
    if (!todo || !dbTransactionStrict) return;

    try {
      const result = await runSyncQueueMutation(() => dbTransactionStrict(['todos', 'syncQueue', 'attachmentBlobs'], 'readwrite', async transaction => {
        const [durableTodo, queue] = await Promise.all([
          transaction.get('todos', todoId),
          transaction.getAll('syncQueue'),
        ]);
        const pendingCreate = queue.find(item => item.action === 'CREATE_ATTACHMENT'
          && String(item.data?.todo_id) === String(todoId)
          && String(item.data?.temp_id) === String(attachmentId));
        const cancelCreate = Boolean(pendingCreate && (!pendingCreate.data?.upload_started || pendingCreate.data?.failed_permanent));
        const sourceTodo = durableTodo || todo;
        const currentAttachment = (sourceTodo.attachments || []).find(item =>
          String(item.id) === String(attachmentId)
          || String(item.client_mutation_id || '') === String(attachmentId));
        if (!pendingCreate && !currentAttachment) return { updated: sourceTodo, shouldSync: false };
        const effectiveAttachmentId = currentAttachment?.id ?? attachmentId;
        const updated = {
          ...sourceTodo,
          attachments: (sourceTodo.attachments || []).filter(item => String(item.id) !== String(effectiveAttachmentId)),
          updated_at: new Date().toISOString(),
        };
        updated.attachments_count = updated.attachments.length;
        await transaction.put('todos', updated);
        if (cancelCreate) {
          await transaction.delete('attachmentBlobs', String(pendingCreate.data?.blob_id || attachmentId));
          await transaction.delete('syncQueue', pendingCreate.id);
        } else {
          await transaction.put('syncQueue', {
            action: 'DELETE_ATTACHMENT',
            data: { todo_id: todoId, attachment_id: effectiveAttachmentId },
            timestamp: Date.now(),
            localUpdatedAt: new Date().toISOString(),
          });
        }
        return { updated, shouldSync: !cancelCreate };
      }));
      setTodos(getTodos().map(item => String(item.id) === String(todoId) ? result.updated : item));
      if (typeof document !== 'undefined') renderTodoAttachments(result.updated.attachments || [], result.updated);
      renderStats();
      renderTodos();
      if (result.shouldSync && isOnlineForSync()) await syncWithServer();
    } catch (error) {
      console.error('Failed to delete todo attachment', error);
      setTodos(getTodos().map(item => String(item.id) === String(todoId) ? todo : item));
      showToast(t('todo.attachments.deleteFailed'));
    }
  }


  function bindTodoAttachmentInputs() {
    document.getElementById('todo-attachment-file')?.addEventListener('change', (event) => {
      setSelectedAttachmentFileName(Array.from(event.target?.files || []));
      refreshTodoSaveButtonState();
    });
    const attachmentDropZone = document.querySelector('.todo-attachments-add-row');
    if (attachmentDropZone) {
      attachmentDropZone.dataset.dropLabel = t('todo.attachments.dropHint');
      const stopDrag = (event) => {
        event.preventDefault();
        event.stopPropagation();
      };
      for (const eventName of ['dragenter', 'dragover']) {
        attachmentDropZone.addEventListener(eventName, (event) => {
          stopDrag(event);
          attachmentDropZone.classList.add('is-drag-over');
        });
      }
      for (const eventName of ['dragleave', 'drop']) {
        attachmentDropZone.addEventListener(eventName, (event) => {
          stopDrag(event);
          attachmentDropZone.classList.remove('is-drag-over');
        });
      }
      attachmentDropZone.addEventListener('drop', (event) => {
        const files = Array.from(event.dataTransfer?.files || []);
        if (files.length) setAttachmentInputFiles(files);
      });
    }
  }

  registerUiLayer('attachment-preview-modal', () => closeAttachmentPreview({ fromHistory: true }));

  return {
    getSelectedAttachmentFiles,
    queueAttachmentFiles,
    loadAttachmentBlob,
    makeAttachmentAvailableOffline,
    renderTodoAttachments,
    uploadTodoAttachmentFromInput,
    closeAttachmentPreview,
    downloadPreviewAttachment,
    deleteTodoAttachment,
    applyAttachmentTodoResponse,
    bindTodoAttachmentInputs,
  };
}

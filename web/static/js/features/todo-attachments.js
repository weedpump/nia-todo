export function createTodoAttachmentsFeature({
  getTodos,
  setTodos,
  getProjects,
  getCurrentUser,
  setCurrentUser,
  getAppInitialized,
  getDb,
  dbPut,
  isOnlineForSync,
  todosApi,
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
      icon.innerHTML = iconSvg(attachmentIconName(attachment));
      icon.setAttribute('aria-label', t('todo.attachments.preview'));
      icon.setAttribute('title', t('todo.attachments.preview'));
      icon.addEventListener('click', () => previewTodoAttachment(todoId, attachment));

      const body = document.createElement('div');
      body.className = 'todo-attachment-body';
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'todo-attachment-name';
      name.textContent = attachment.original_filename || t('todo.attachments.unnamed');
      name.addEventListener('click', () => previewTodoAttachment(todoId, attachment));
      const meta = document.createElement('div');
      meta.className = 'todo-attachment-meta';
      meta.textContent = `${formatAttachmentSize(attachment.size_bytes)} · ${attachment.uploader_display_name || attachment.uploader_username || t('todo.attachments.unknownUploader')}`;
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
    if (!updatedTodo) return;
    await dbPut('todos', updatedTodo);
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
    if (!id || id.startsWith('temp-')) {
      showToast(t('todo.attachments.saveFirst'));
      return false;
    }
    if (files.length === 0) {
      input?.focus();
      return true;
    }
    if (!isOnlineForSync()) {
      showToast(t('todo.attachments.onlineOnly'));
      return false;
    }
    const currentUser = getCurrentUser?.();
    if (currentUser?.attachments_enabled === false) {
      showToast(t('todo.attachments.disabled'));
      return false;
    }
    const maxUploadBytes = Number(currentUser?.attachment_max_upload_bytes || 0);
    const oversized = files.find(file => maxUploadBytes > 0 && file.size > maxUploadBytes);
    if (oversized) {
      showToast(t('todo.attachments.fileTooLarge', { max: formatAttachmentSize(maxUploadBytes) }));
      return false;
    }
    const remainingBytes = Number(currentUser?.attachment_remaining_bytes ?? currentUser?.attachment_quota_bytes ?? 0);
    const totalBytes = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    if (totalBytes > Math.max(remainingBytes, 0)) {
      showToast(t('todo.attachments.quotaExceeded'));
      return false;
    }
    if (files.some(file => !attachmentAllowedByClient(file, currentUser))) {
      showToast(t('todo.attachments.typeNotAllowed'));
      return false;
    }
    const uploadButton = document.getElementById('todo-attachment-upload-btn');
    const previousDisabled = uploadButton?.disabled;
    if (uploadButton) uploadButton.disabled = true;
    try {
      let latestResponse = null;
      let latestUser = currentUser;
      for (const file of files) {
        latestResponse = await todosApi.uploadAttachment(id, file);
        if (latestResponse?.usage && latestUser && typeof setCurrentUser === 'function') {
          latestUser = {
            ...latestUser,
            attachments_enabled: Boolean(latestResponse.usage.enabled),
            attachment_usage_bytes: latestResponse.usage.used_bytes,
            attachment_quota_bytes: latestResponse.usage.quota_bytes,
            attachment_remaining_bytes: latestResponse.usage.remaining_bytes,
            attachments_allowed_types: latestResponse.usage.allowed_types || latestUser.attachments_allowed_types,
            attachment_max_upload_bytes: latestResponse.usage.max_upload_bytes || latestUser.attachment_max_upload_bytes,
          };
          setCurrentUser(latestUser);
        }
      }
      if (latestResponse) await applyAttachmentTodoResponse(latestResponse);
      setSelectedAttachmentFileName([]);
      if (input) input.value = '';
      showToast(files.length === 1 ? t('todo.attachments.uploaded') : t('todo.attachments.uploadedMany', { count: files.length }));
      return true;
    } catch (error) {
      console.error('Failed to upload todo attachment', error);
      showToast(error?.message || t('todo.attachments.uploadFailed'));
      return false;
    } finally {
      if (uploadButton) uploadButton.disabled = previousDisabled ?? false;
      refreshTodoActionButtonState();
    }
  }

  function closeAttachmentPreview() {
    closeModal('attachment-preview-modal');
    document.getElementById('attachment-preview-modal')?.classList.remove('show');
    const body = document.getElementById('attachment-preview-body');
    if (body) body.innerHTML = '';
    if (attachmentPreviewObjectUrl) URL.revokeObjectURL(attachmentPreviewObjectUrl);
    attachmentPreviewObjectUrl = '';
    attachmentPreviewDownload = null;
  }

  async function previewTodoAttachment(todoId, attachment) {
    if (!todoId || !attachment?.id || !isOnlineForSync()) {
      showToast(t('todo.attachments.onlineOnly'));
      return;
    }
    if (!attachmentCanPreview(attachment)) {
      showToast(t('todo.attachments.noPreview'));
      return downloadTodoAttachment(todoId, attachment.id, attachment.original_filename);
    }
    try {
      closeAttachmentPreview();
      const blob = await todosApi.getAttachmentBlob(todoId, attachment.id);
      attachmentPreviewObjectUrl = URL.createObjectURL(blob);
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
      document.getElementById('attachment-preview-modal')?.classList.add('active');
    } catch (error) {
      console.error('Failed to preview todo attachment', error);
      showToast(t('todo.attachments.previewFailed'));
    }
  }

  async function downloadPreviewAttachment() {
    if (!attachmentPreviewDownload) return;
    await downloadTodoAttachment(attachmentPreviewDownload.todoId, attachmentPreviewDownload.attachmentId, attachmentPreviewDownload.filename);
  }

  async function downloadTodoAttachment(todoId, attachmentId, filename) {
    if (!todoId || !attachmentId || !isOnlineForSync()) {
      showToast(t('todo.attachments.onlineOnly'));
      return;
    }
    try {
      if (nativeBridge?.isNative?.() && nativeBridge?.downloadToDownloads) {
        const result = await todosApi.downloadAttachmentNative(todoId, attachmentId, filename || 'attachment', nativeBridge);
        if (result) {
          showToast(result?.path
            ? t('todo.attachments.downloadSavedTo', { path: result.path })
            : t('todo.attachments.downloadStarted'));
          return;
        }
      }
      await todosApi.downloadAttachment(todoId, attachmentId, filename || 'attachment');
    } catch (error) {
      console.error('Failed to download todo attachment', error);
      showToast(t('todo.attachments.downloadFailed'));
    }
  }

  async function deleteTodoAttachment(todoId, attachmentId) {
    if (!todoId || !attachmentId || !isOnlineForSync()) {
      showToast(t('todo.attachments.onlineOnly'));
      return;
    }
    const confirmed = await confirmDanger({
      title: t('todo.attachments.deleteTitle'),
      message: t('todo.attachments.deleteMessage'),
      confirmText: t('todo.attachments.deleteConfirm'),
    });
    if (!confirmed) return;
    try {
      const response = await todosApi.deleteAttachment(todoId, attachmentId);
      await applyAttachmentTodoResponse(response);
    } catch (error) {
      console.error('Failed to delete todo attachment', error);
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

  return {
    getSelectedAttachmentFiles,
    renderTodoAttachments,
    uploadTodoAttachmentFromInput,
    closeAttachmentPreview,
    downloadPreviewAttachment,
    deleteTodoAttachment,
    bindTodoAttachmentInputs,
  };
}

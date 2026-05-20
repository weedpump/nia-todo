function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

function escapeHtmlAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isHeicFile(file) {
  const name = file?.name?.toLowerCase?.() || '';
  const type = file?.type?.toLowerCase?.() || '';
  return type.includes('heic') || type.includes('heif') || name.endsWith('.heic') || name.endsWith('.heif');
}

export function createUserSettingsFeature({ authApi, getCurrentUser, setCurrentUser, resetApiKeyUi, loadApiKeys, updatePushSettingsUI, logout }) {
  const cropState = {
    file: null,
    image: null,
    objectUrl: '',
    scale: 1,
    minScale: 1,
    x: 0,
    y: 0,
    dragging: false,
    pointerId: null,
    dragStartX: 0,
    dragStartY: 0,
    startX: 0,
    startY: 0,
  };

  function avatarSrc(user) {
    if (!user?.avatar_url) return '';
    const version = user.avatar_updated_at ? encodeURIComponent(user.avatar_updated_at) : Date.now();
    return `${user.avatar_url}?v=${version}`;
  }

  function renderSettingsAvatar(user) {
    const initialEl = document.getElementById('settings-avatar-initial');
    const imgEl = document.getElementById('settings-avatar-preview');
    if (!initialEl || !imgEl) return;
    const name = user?.display_name || user?.username || 'User';
    const src = avatarSrc(user);
    initialEl.textContent = (name.trim()[0] || 'U').toUpperCase();
    if (src) {
      imgEl.src = src;
      imgEl.style.display = '';
      initialEl.style.display = 'none';
    } else {
      imgEl.removeAttribute('src');
      imgEl.style.display = 'none';
      initialEl.style.display = '';
    }
  }

  function renderDisplayNameDisplay(displayNameValue) {
    const name = displayNameValue ? escapeHtml(displayNameValue) : '<span class="settings-email-missing">-</span>';
    return `<span class="settings-display-name-display" id="settings-display-name-display">
      <span class="settings-display-name-value">${name}</span>
      <button type="button" class="settings-inline-action" title="Anzeigename bearbeiten" onclick="editUserDisplayName()">✏️</button>
    </span>`;
  }

  function renderSettingsEmailDisplay(emailValue) {
    const email = emailValue ? escapeHtml(emailValue) : '<span class="settings-email-missing">-</span>';
    return `<span class="settings-email-display" id="settings-email-display">
      <span class="settings-email-value">${email}</span>
      <button type="button" class="settings-email-action" title="E-Mail bearbeiten" onclick="editUserEmail()">✏️</button>
    </span>`;
  }

  function renderUserInfo() {
    const currentUser = getCurrentUser();
    const settingsUsernameEl = document.getElementById('settings-username');
    const settingsDisplayNameCell = document.getElementById('settings-display-name-cell');
    const settingsEmailCell = document.getElementById('settings-email-cell');
    if (settingsUsernameEl && currentUser) settingsUsernameEl.textContent = currentUser.username;
    if (settingsDisplayNameCell && currentUser) settingsDisplayNameCell.innerHTML = renderDisplayNameDisplay(currentUser.display_name || currentUser.username);
    if (settingsEmailCell && currentUser) settingsEmailCell.innerHTML = renderSettingsEmailDisplay(currentUser.email || '');
    renderSettingsAvatar(currentUser);
  }

  async function refreshCurrentUser() {
    const freshUser = await authApi.me();
    const token = freshUser.access_token || getCurrentUser()?.token;
    setCurrentUser({ ...freshUser, token });
    if (freshUser.access_token) localStorage.setItem('jwt_token', freshUser.access_token);
    if (freshUser.csrf_token) localStorage.setItem('csrf_token', freshUser.csrf_token);
    renderUserInfo();
  }

  async function openSettingsModal() {
    document.getElementById('settings-old-password').value = '';
    document.getElementById('settings-new-password').value = '';
    document.getElementById('settings-confirm-password').value = '';
    document.getElementById('settings-pw-error').textContent = '';
    document.getElementById('settings-pw-success').textContent = '';
    document.getElementById('settings-email-error').textContent = '';
    document.getElementById('settings-email-success').textContent = '';
    document.getElementById('settings-profile-error').textContent = '';
    document.getElementById('settings-profile-success').textContent = '';
    document.getElementById('settings-avatar-error').textContent = '';
    document.getElementById('settings-avatar-success').textContent = '';
    renderUserInfo();
    document.getElementById('settings-modal')?.classList.add('active');
    await refreshCurrentUser().catch(() => {});
    resetApiKeyUi();
    loadApiKeys();
    updatePushSettingsUI();
  }

  function editUserDisplayName() {
    const currentName = getCurrentUser()?.display_name || getCurrentUser()?.username || '';
    const cell = document.getElementById('settings-display-name-cell');
    if (!cell) return;
    cell.innerHTML = `<span class="settings-display-name-edit" id="settings-display-name-edit">
      <input id="settings-display-name-input" type="text" maxlength="80" value="${escapeHtmlAttr(currentName)}" placeholder="Anzeigename" autocomplete="name" onkeydown="if(event.key==='Enter') saveUserProfile(); if(event.key==='Escape') cancelUserDisplayNameEdit()">
      <button type="button" class="settings-inline-action" title="Speichern" onclick="saveUserProfile()">✅</button>
      <button type="button" class="settings-inline-action" title="Abbrechen" onclick="cancelUserDisplayNameEdit()">✕</button>
    </span>`;
    document.getElementById('settings-display-name-input')?.focus();
  }

  function cancelUserDisplayNameEdit() {
    renderUserInfo();
    document.getElementById('settings-profile-error').textContent = '';
  }

  async function saveUserProfile() {
    const displayName = document.getElementById('settings-display-name-input')?.value?.trim() || '';
    const errorEl = document.getElementById('settings-profile-error');
    const successEl = document.getElementById('settings-profile-success');
    errorEl.textContent = '';
    successEl.textContent = '';
    if (!displayName) {
      errorEl.textContent = 'Anzeigename ist erforderlich';
      return;
    }
    try {
      const data = await authApi.updateProfile(displayName);
      const currentUser = getCurrentUser();
      if (currentUser) setCurrentUser({ ...currentUser, ...data });
      renderUserInfo();
      successEl.textContent = 'Profil gespeichert';
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }

  function resetCropState() {
    if (cropState.objectUrl) URL.revokeObjectURL(cropState.objectUrl);
    Object.assign(cropState, {
      file: null,
      image: null,
      objectUrl: '',
      scale: 1,
      minScale: 1,
      x: 0,
      y: 0,
      dragging: false,
      pointerId: null,
      dragStartX: 0,
      dragStartY: 0,
      startX: 0,
      startY: 0,
    });
  }

  function clampCropPosition() {
    const stage = document.getElementById('avatar-crop-stage');
    if (!stage || !cropState.image) return;
    const stageSize = stage.clientWidth;
    const renderedWidth = cropState.image.naturalWidth * cropState.scale;
    const renderedHeight = cropState.image.naturalHeight * cropState.scale;
    cropState.x = Math.min(Math.max(cropState.x, -Math.max(0, (renderedWidth - stageSize) / 2)), Math.max(0, (renderedWidth - stageSize) / 2));
    cropState.y = Math.min(Math.max(cropState.y, -Math.max(0, (renderedHeight - stageSize) / 2)), Math.max(0, (renderedHeight - stageSize) / 2));
  }

  function renderCropTransform() {
    const img = document.getElementById('avatar-crop-image');
    if (!img) return;
    clampCropPosition();
    img.style.width = `${cropState.image.naturalWidth}px`;
    img.style.height = `${cropState.image.naturalHeight}px`;
    img.style.transform = `translate(calc(-50% + ${cropState.x}px), calc(-50% + ${cropState.y}px)) scale(${cropState.scale})`;
  }

  function bindCropStageOnce() {
    const stage = document.getElementById('avatar-crop-stage');
    if (!stage || stage.dataset.bound === 'true') return;
    stage.dataset.bound = 'true';
    stage.addEventListener('pointerdown', (event) => {
      if (!cropState.image) return;
      cropState.dragging = true;
      cropState.pointerId = event.pointerId;
      cropState.dragStartX = event.clientX;
      cropState.dragStartY = event.clientY;
      cropState.startX = cropState.x;
      cropState.startY = cropState.y;
      stage.setPointerCapture(event.pointerId);
    });
    stage.addEventListener('pointermove', (event) => {
      if (!cropState.dragging || cropState.pointerId !== event.pointerId) return;
      cropState.x = cropState.startX + event.clientX - cropState.dragStartX;
      cropState.y = cropState.startY + event.clientY - cropState.dragStartY;
      renderCropTransform();
    });
    const stopDragging = (event) => {
      if (cropState.pointerId !== event.pointerId) return;
      cropState.dragging = false;
      cropState.pointerId = null;
    };
    stage.addEventListener('pointerup', stopDragging);
    stage.addEventListener('pointercancel', stopDragging);
  }

  function updateAvatarCropZoom(value) {
    cropState.scale = Number(value) || cropState.minScale;
    renderCropTransform();
  }

  async function uploadOriginalAvatar(file, fallbackMessage = 'Avatar gespeichert') {
    const input = document.getElementById('settings-avatar-input');
    const errorEl = document.getElementById('settings-avatar-error');
    const successEl = document.getElementById('settings-avatar-success');
    try {
      const data = await authApi.uploadAvatar(file);
      const currentUser = getCurrentUser();
      if (currentUser) setCurrentUser({ ...currentUser, ...data });
      renderUserInfo();
      successEl.textContent = fallbackMessage;
    } catch (e) {
      errorEl.textContent = e.message;
    } finally {
      if (input) input.value = '';
    }
  }

  async function startAvatarUpload(file) {
    const input = document.getElementById('settings-avatar-input');
    const errorEl = document.getElementById('settings-avatar-error');
    const successEl = document.getElementById('settings-avatar-success');
    errorEl.textContent = '';
    successEl.textContent = '';
    if (!file) return;
    if (!file.type.startsWith('image/') && !isHeicFile(file)) {
      errorEl.textContent = 'Bitte ein gültiges Bild hochladen';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      errorEl.textContent = 'Bild ist zu groß';
      return;
    }

    resetCropState();
    cropState.file = file;
    cropState.objectUrl = URL.createObjectURL(file);
    const img = document.getElementById('avatar-crop-image');
    const cropErrorEl = document.getElementById('avatar-crop-error');
    cropErrorEl.textContent = '';
    img.onload = () => {
      cropState.image = img;
      document.getElementById('avatar-crop-modal')?.classList.add('active');
      requestAnimationFrame(() => {
        const stage = document.getElementById('avatar-crop-stage');
        const stageSize = stage?.clientWidth || 320;
        cropState.minScale = Math.max(stageSize / img.naturalWidth, stageSize / img.naturalHeight);
        cropState.scale = cropState.minScale;
        cropState.x = 0;
        cropState.y = 0;
        const zoom = document.getElementById('avatar-zoom-range');
        zoom.min = String(cropState.minScale);
        zoom.max = String(cropState.minScale * 4);
        zoom.step = '0.01';
        zoom.value = String(cropState.scale);
        renderCropTransform();
        bindCropStageOnce();
      });
    };
    img.onerror = async () => {
      resetCropState();
      if (isHeicFile(file)) {
        await uploadOriginalAvatar(file, 'Avatar gespeichert. HEIC wurde serverseitig zentriert zugeschnitten.');
      } else {
        if (input) input.value = '';
        errorEl.textContent = 'Bild konnte nicht geöffnet werden';
      }
    };
    img.src = cropState.objectUrl;
  }

  function cancelAvatarCrop() {
    document.getElementById('avatar-crop-modal')?.classList.remove('active');
    document.getElementById('avatar-crop-image')?.removeAttribute('src');
    document.getElementById('avatar-crop-error').textContent = '';
    const input = document.getElementById('settings-avatar-input');
    if (input) input.value = '';
    resetCropState();
  }

  async function saveAvatarCrop() {
    const stage = document.getElementById('avatar-crop-stage');
    const errorEl = document.getElementById('avatar-crop-error');
    const settingsErrorEl = document.getElementById('settings-avatar-error');
    const successEl = document.getElementById('settings-avatar-success');
    errorEl.textContent = '';
    settingsErrorEl.textContent = '';
    successEl.textContent = '';
    if (!stage || !cropState.image || !cropState.file) return;

    const stageSize = stage.clientWidth;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const outputScale = canvas.width / stageSize;
    const renderedWidth = cropState.image.naturalWidth * cropState.scale * outputScale;
    const renderedHeight = cropState.image.naturalHeight * cropState.scale * outputScale;
    const dx = (canvas.width - renderedWidth) / 2 + cropState.x * outputScale;
    const dy = (canvas.height - renderedHeight) / 2 + cropState.y * outputScale;
    ctx.drawImage(cropState.image, dx, dy, renderedWidth, renderedHeight);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
    if (!blob) {
      errorEl.textContent = 'Avatar konnte nicht erzeugt werden';
      return;
    }

    try {
      const file = new File([blob], 'avatar.webp', { type: 'image/webp' });
      const data = await authApi.uploadAvatar(file);
      const currentUser = getCurrentUser();
      if (currentUser) setCurrentUser({ ...currentUser, ...data });
      cancelAvatarCrop();
      renderUserInfo();
      successEl.textContent = 'Avatar gespeichert';
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }

  function editUserEmail() {
    const currentEmail = getCurrentUser()?.email || '';
    const cell = document.getElementById('settings-email-cell');
    if (!cell) return;
    cell.innerHTML = `<span class="settings-email-edit" id="settings-email-edit">
      <input id="settings-email-input" type="email" value="${escapeHtmlAttr(currentEmail)}" placeholder="E-Mail setzen" autocomplete="email" onkeydown="if(event.key==='Enter') saveUserEmail(); if(event.key==='Escape') cancelUserEmailEdit()">
      <button type="button" class="settings-email-action" title="Speichern" onclick="saveUserEmail()">✅</button>
      <button type="button" class="settings-email-action" title="Abbrechen" onclick="cancelUserEmailEdit()">✕</button>
    </span>`;
    document.getElementById('settings-email-input')?.focus();
  }

  function cancelUserEmailEdit() {
    renderUserInfo();
    document.getElementById('settings-email-error').textContent = '';
  }

  async function saveUserEmail() {
    const email = document.getElementById('settings-email-input')?.value?.trim() || '';
    const errorEl = document.getElementById('settings-email-error');
    const successEl = document.getElementById('settings-email-success');
    errorEl.textContent = '';
    successEl.textContent = '';

    if (!email) {
      errorEl.textContent = 'E-Mail ist erforderlich';
      return;
    }
    if (!isValidEmail(email)) {
      errorEl.textContent = 'Bitte eine gültige E-Mail-Adresse eingeben';
      return;
    }

    try {
      const data = await authApi.updateEmail(email);
      const currentUser = getCurrentUser();
      if (currentUser) setCurrentUser({ ...currentUser, email: data.email });
      renderUserInfo();
      successEl.textContent = 'E-Mail gespeichert';
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }

  async function changeUserPassword() {
    const oldPw = document.getElementById('settings-old-password').value;
    const newPw = document.getElementById('settings-new-password').value;
    const confirmPw = document.getElementById('settings-confirm-password').value;

    document.getElementById('settings-pw-error').textContent = '';
    document.getElementById('settings-pw-success').textContent = '';

    if (!oldPw || !newPw || !confirmPw) {
      document.getElementById('settings-pw-error').textContent = 'Alle Felder sind erforderlich';
      return;
    }
    if (newPw !== confirmPw) {
      document.getElementById('settings-pw-error').textContent = 'Passwörter stimmen nicht überein';
      return;
    }

    try {
      await authApi.changePassword(oldPw, newPw);
      document.getElementById('settings-pw-success').textContent = 'Passwort geändert! Du wirst abgemeldet...';
      setTimeout(() => logout(), 1500);
    } catch (e) {
      document.getElementById('settings-pw-error').textContent = e.message;
    }
  }

  return {
    renderUserInfo,
    openSettingsModal,
    editUserDisplayName,
    cancelUserDisplayNameEdit,
    saveUserProfile,
    startAvatarUpload,
    updateAvatarCropZoom,
    cancelAvatarCrop,
    saveAvatarCrop,
    editUserEmail,
    cancelUserEmailEdit,
    saveUserEmail,
    changeUserPassword,
  };
}

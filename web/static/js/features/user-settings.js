import { RUNTIME_CAPABILITIES } from '../core/config.js';
import { iconSvg } from '../icons/lucide-icons.js';
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
    pointers: new Map(),
    pinchDistance: 0,
    pinchStartScale: 1,
    dragStartX: 0,
    dragStartY: 0,
    startX: 0,
    startY: 0,
  };

  function avatarSrc(user) {
    if (!user?.avatar_url) return '';
    const version = user.avatar_updated_at ? encodeURIComponent(user.avatar_updated_at) : '';
    return version ? `${user.avatar_url}?v=${version}` : user.avatar_url;
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
      <button type="button" class="settings-inline-action" title="Anzeigename bearbeiten" onclick="editUserDisplayName()">${iconSvg('edit-3')}</button>
    </span>`;
  }

  function renderSettingsEmailDisplay(user) {
    const email = user?.email ? escapeHtml(user.email) : '<span class="settings-email-missing">-</span>';
    const verified = user?.email
      ? (user?.email_verified_at
        ? '<span class="settings-email-status settings-email-verified">bestätigt</span>'
        : '<span class="settings-email-status settings-email-unverified">nicht bestätigt</span>')
      : '';
    const pending = user?.pending_email ? `<span class="settings-email-pending">Ausstehend: ${escapeHtml(user.pending_email)}</span>` : '';
    return `<span class="settings-email-display" id="settings-email-display">
      <span class="settings-email-value">${email}</span>
      ${verified}
      ${pending}
      <button type="button" class="settings-email-action" title="E-Mail bearbeiten" onclick="editUserEmail()">${iconSvg('edit-3')}</button>
    </span>`;
  }

  function renderUserInfo() {
    const currentUser = getCurrentUser();
    const settingsUsernameEl = document.getElementById('settings-username');
    const settingsDisplayNameCell = document.getElementById('settings-display-name-cell');
    const settingsEmailCell = document.getElementById('settings-email-cell');
    if (settingsUsernameEl && currentUser) settingsUsernameEl.textContent = currentUser.username;
    if (settingsDisplayNameCell && currentUser) settingsDisplayNameCell.innerHTML = renderDisplayNameDisplay(currentUser.display_name || currentUser.username);
    if (settingsEmailCell && currentUser) settingsEmailCell.innerHTML = renderSettingsEmailDisplay(currentUser);
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

  let pendingTotpSecret = '';

  function renderRecoveryCodes(codes) {
    const box = document.getElementById('settings-2fa-recovery');
    if (!box || !codes?.length) return;
    box.style.display = '';
    box.innerHTML = `<strong>Recovery Codes — jetzt speichern:</strong><br><code style="white-space:pre-wrap; display:block; margin-top:8px;">${codes.map(escapeHtml).join('\n')}</code>`;
  }

  async function refreshTwoFactorStatus() {
    const statusEl = document.getElementById('settings-2fa-status');
    const errorEl = document.getElementById('settings-2fa-error');
    if (!statusEl) return;
    try {
      const state = await authApi.twoFactorStatus();
      const parts = [];
      const hasAnyFactor = state.has_totp || state.has_passkey || state.has_recovery_codes || state.has_email_fallback;
      parts.push(state.enabled ? 'aktiv' : (state.required ? (hasAnyFactor ? 'erforderlich, nutzbarer Faktor verfügbar' : 'erforderlich, kein Faktor verfügbar') : 'nicht aktiv'));
      if (state.has_totp) parts.push('TOTP eingerichtet');
      if (state.has_passkey) parts.push(`${state.passkey_count} Passkey(s)`);
      if (state.has_email_fallback) parts.push('E-Mail-Code verfügbar');
      if (state.has_recovery_codes) parts.push(`${state.recovery_codes_remaining} Recovery Codes`);
      statusEl.textContent = `Status: ${parts.join(' · ')}`;
      document.getElementById('settings-2fa-actions')?.querySelectorAll('button').forEach((btn) => {
        if (btn.textContent.includes('deaktivieren')) btn.style.display = state.enabled ? '' : 'none';
      });
    } catch (e) {
      if (errorEl) errorEl.textContent = e.message || '2FA-Status konnte nicht geladen werden';
    }
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
    document.getElementById('settings-2fa-error').textContent = '';
    document.getElementById('settings-2fa-success').textContent = '';
    document.getElementById('settings-2fa-setup').style.display = 'none';
    document.getElementById('settings-2fa-recovery').style.display = 'none';
    renderUserInfo();
    document.getElementById('settings-modal')?.classList.add('active');
    await refreshCurrentUser().catch(() => {});
    await refreshTwoFactorStatus();
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
      <button type="button" class="settings-inline-action" title="Speichern" onclick="saveUserProfile()">${iconSvg('check')}</button>
      <button type="button" class="settings-inline-action" title="Abbrechen" onclick="cancelUserDisplayNameEdit()">${iconSvg('x')}</button>
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
      pointers: new Map(),
      pinchDistance: 0,
      pinchStartScale: 1,
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

  function clampScale(value) {
    return Math.min(Math.max(value, cropState.minScale), cropState.minScale * 4);
  }

  function distanceBetweenPointers() {
    const points = Array.from(cropState.pointers.values());
    if (points.length < 2) return 0;
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  }

  function setCropScale(nextScale) {
    cropState.scale = clampScale(nextScale);
    renderCropTransform();
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
      event.preventDefault();
      cropState.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      stage.setPointerCapture(event.pointerId);

      if (cropState.pointers.size === 1) {
        cropState.dragging = true;
        cropState.pointerId = event.pointerId;
        cropState.dragStartX = event.clientX;
        cropState.dragStartY = event.clientY;
        cropState.startX = cropState.x;
        cropState.startY = cropState.y;
      } else if (cropState.pointers.size === 2) {
        cropState.dragging = false;
        cropState.pointerId = null;
        cropState.pinchDistance = distanceBetweenPointers();
        cropState.pinchStartScale = cropState.scale;
      }
    });
    stage.addEventListener('pointermove', (event) => {
      if (!cropState.image || !cropState.pointers.has(event.pointerId)) return;
      event.preventDefault();
      cropState.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (cropState.pointers.size >= 2) {
        const distance = distanceBetweenPointers();
        if (cropState.pinchDistance > 0) {
          setCropScale(cropState.pinchStartScale * (distance / cropState.pinchDistance));
        }
        return;
      }

      if (!cropState.dragging || cropState.pointerId !== event.pointerId) return;
      cropState.x = cropState.startX + event.clientX - cropState.dragStartX;
      cropState.y = cropState.startY + event.clientY - cropState.dragStartY;
      renderCropTransform();
    });
    const stopPointer = (event) => {
      cropState.pointers.delete(event.pointerId);
      if (cropState.pointerId === event.pointerId) {
        cropState.dragging = false;
        cropState.pointerId = null;
      }
      if (cropState.pointers.size === 1) {
        const [nextPointerId, point] = cropState.pointers.entries().next().value;
        cropState.dragging = true;
        cropState.pointerId = nextPointerId;
        cropState.dragStartX = point.x;
        cropState.dragStartY = point.y;
        cropState.startX = cropState.x;
        cropState.startY = cropState.y;
      }
      if (cropState.pointers.size < 2) {
        cropState.pinchDistance = 0;
      }
    };
    stage.addEventListener('pointerup', stopPointer);
    stage.addEventListener('pointercancel', stopPointer);
    stage.addEventListener('lostpointercapture', stopPointer);
    stage.addEventListener('wheel', (event) => {
      if (!cropState.image) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.08 : 0.92;
      setCropScale(cropState.scale * factor);
    }, { passive: false });
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
      <button type="button" class="settings-email-action" title="Speichern" onclick="saveUserEmail()">${iconSvg('check')}</button>
      <button type="button" class="settings-email-action" title="Abbrechen" onclick="cancelUserEmailEdit()">${iconSvg('x')}</button>
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
      const data = await withRecentMfaRetry(() => authApi.updateEmail(email));
      if (data.email_verification_delivery === 'unavailable') {
        await refreshCurrentUser().catch(() => renderUserInfo());
        errorEl.textContent = 'E-Mail schon vergeben';
        return;
      }
      const currentUser = getCurrentUser();
      if (currentUser) setCurrentUser({ ...currentUser, email: data.email || currentUser.email, pending_email: data.pending_email || null });
      await refreshCurrentUser().catch(() => renderUserInfo());
      successEl.textContent = data.email_verification_required
        ? 'Bestätigungsmail gesendet'
        : (data.email_verification_delivery === 'unverified_no_smtp' ? 'E-Mail gespeichert, aber ohne SMTP nicht per Mail bestätigt' : 'E-Mail gespeichert und bestätigt');
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }

  async function startTwoFactorTotp() {
    const errorEl = document.getElementById('settings-2fa-error');
    const successEl = document.getElementById('settings-2fa-success');
    errorEl.textContent = '';
    successEl.textContent = '';
    try {
      const data = await withRecentMfaRetry(() => authApi.startTotp());
      pendingTotpSecret = data.secret;
      document.getElementById('settings-2fa-secret').textContent = data.secret;
      document.getElementById('settings-2fa-setup').style.display = '';
      document.getElementById('settings-2fa-code')?.focus();
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }

  async function confirmTwoFactorTotp() {
    const code = document.getElementById('settings-2fa-code')?.value?.trim() || '';
    const errorEl = document.getElementById('settings-2fa-error');
    const successEl = document.getElementById('settings-2fa-success');
    errorEl.textContent = '';
    successEl.textContent = '';
    if (!pendingTotpSecret || !code) {
      errorEl.textContent = 'Secret und Code sind erforderlich';
      return;
    }
    try {
      const password = window.prompt('Zur Bestätigung bitte dein Passwort eingeben');
      if (!password) throw new Error('Passwortbestätigung erforderlich');
      const data = await authApi.confirmTotp(pendingTotpSecret, code, password);
      if (data.access_token) localStorage.setItem('jwt_token', data.access_token);
      pendingTotpSecret = '';
      document.getElementById('settings-2fa-setup').style.display = 'none';
      renderRecoveryCodes(data.recovery_codes);
      successEl.textContent = '2FA aktiviert';
      await refreshTwoFactorStatus();
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }

  async function ensureRecentMfa() {
    const state = await authApi.twoFactorStatus().catch(() => ({}));
    if (state.has_passkey && !RUNTIME_CAPABILITIES.native && window.PublicKeyCredential && navigator.credentials && window.confirm('Mit Passkey reauthentifizieren?')) {
      const data = await authApi.reauthPasskey();
      if (data.access_token) localStorage.setItem('jwt_token', data.access_token);
      return;
    }
    let method = 'totp';
    if (state.has_email_fallback && !state.has_totp && !state.has_passkey) {
      await authApi.startEmailReauth();
      method = 'email';
    }
    const label = method === 'email' ? 'E-Mail-Code' : '2FA-Code';
    const code = window.prompt(`${label} für diese Sicherheitsaktion eingeben`);
    if (!code) throw new Error('2FA/Reauth abgebrochen');
    if (method !== 'email') method = code.includes('-') ? 'recovery_code' : 'totp';
    const data = await authApi.reauth(method, code.trim());
    if (data.access_token) localStorage.setItem('jwt_token', data.access_token);
  }

  async function withRecentMfaRetry(action) {
    try {
      return await action();
    } catch (e) {
      if (e.status !== 403) throw e;
      await ensureRecentMfa();
      return action();
    }
  }

  async function disableTwoFactor() {
    if (!confirm('2FA wirklich deaktivieren?')) return;
    const errorEl = document.getElementById('settings-2fa-error');
    const successEl = document.getElementById('settings-2fa-success');
    errorEl.textContent = '';
    successEl.textContent = '';
    try {
      await ensureRecentMfa();
      await authApi.disable2fa('');
      successEl.textContent = '2FA deaktiviert';
      await refreshTwoFactorStatus();
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }

  async function addPasskey() {
    const errorEl = document.getElementById('settings-2fa-error');
    const successEl = document.getElementById('settings-2fa-success');
    errorEl.textContent = '';
    successEl.textContent = '';
    if (RUNTIME_CAPABILITIES.native || !window.PublicKeyCredential || !navigator.credentials) {
      errorEl.textContent = 'Passkeys werden von dieser Umgebung nicht unterstützt';
      return;
    }
    try {
      const state = await authApi.twoFactorStatus().catch(() => ({}));
      if (state.enabled || state.required) await ensureRecentMfa();
      const name = window.prompt('Name für diesen Passkey', 'Passkey') || 'Passkey';
      const password = window.prompt('Zur Bestätigung bitte dein Passwort eingeben');
      if (!password) throw new Error('Passwortbestätigung erforderlich');
      const data = await authApi.createPasskey(name, password);
      if (data.access_token) localStorage.setItem('jwt_token', data.access_token);
      if (data.recovery_codes?.length) renderRecoveryCodes(data.recovery_codes);
      successEl.textContent = 'Passkey gespeichert';
      await refreshTwoFactorStatus();
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }

  async function regenerateRecoveryCodes() {
    const errorEl = document.getElementById('settings-2fa-error');
    const successEl = document.getElementById('settings-2fa-success');
    errorEl.textContent = '';
    successEl.textContent = '';
    try {
      await ensureRecentMfa();
      const data = await authApi.regenerateRecoveryCodes();
      renderRecoveryCodes(data.recovery_codes);
      successEl.textContent = 'Neue Recovery Codes erzeugt';
      await refreshTwoFactorStatus();
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
      await withRecentMfaRetry(() => authApi.changePassword(oldPw, newPw));
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
    cancelAvatarCrop,
    saveAvatarCrop,
    editUserEmail,
    cancelUserEmailEdit,
    saveUserEmail,
    changeUserPassword,
    startTwoFactorTotp,
    confirmTwoFactorTotp,
    disableTwoFactor,
    addPasskey,
    regenerateRecoveryCodes,
  };
}

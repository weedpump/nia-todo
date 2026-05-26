import { RUNTIME_CAPABILITIES, apiResourceUrl } from '../core/config.js';
import { getLanguagePreference, setLanguagePreference, adoptServerLanguagePreference, getActiveLanguage, t, translatePage } from '../i18n/index.js';
import { cleanSessionUserAgent, sessionDeviceName } from '../core/device-labels.js';
import { iconSvg } from '../icons/lucide-icons.js';
import qrcode from '../../vendor/qrcode-generator.js';
import { confirmSecurityAction, performMfaReauth, promptSecurityPassword, promptSecurityText } from './security-dialogs.js';
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

function formatLocaleDateTime(value) {
  if (!value) return '-';
  const raw = String(value);
  const normalized = raw.replace(' ', 'T') + (raw.includes('Z') ? '' : 'Z');
  const language = getActiveLanguage() === 'de' ? 'de-DE' : 'en-US';
  return new Date(normalized).toLocaleString(language);
}

function isHeicFile(file) {
  const name = file?.name?.toLowerCase?.() || '';
  const type = file?.type?.toLowerCase?.() || '';
  return type.includes('heic') || type.includes('heif') || name.endsWith('.heic') || name.endsWith('.heif');
}

export function createUserSettingsFeature({ authApi, getCurrentUser, setCurrentUser, resetApiKeyUi, loadApiKeys, updatePushSettingsUI, logout }) {
  let lastTwoFactorState = null;
  let trustedDeviceRevokeInFlight = false;
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
    const src = apiResourceUrl(user.avatar_url);
    return version ? `${src}?v=${version}` : src;
  }

  function renderSettingsAvatar(user) {
    const initialEl = document.getElementById('settings-avatar-initial');
    const imgEl = document.getElementById('settings-avatar-preview');
    const removeBtn = document.getElementById('settings-avatar-remove');
    if (!initialEl || !imgEl) return;
    const name = user?.display_name || user?.username || 'User';
    const src = avatarSrc(user);
    initialEl.textContent = (name.trim()[0] || 'U').toUpperCase();
    if (src) {
      imgEl.src = src;
      imgEl.style.display = '';
      initialEl.style.display = 'none';
      if (removeBtn) removeBtn.style.display = '';
    } else {
      imgEl.removeAttribute('src');
      imgEl.style.display = 'none';
      initialEl.style.display = '';
      if (removeBtn) removeBtn.style.display = 'none';
    }
  }

  function renderDisplayNameDisplay(displayNameValue) {
    const name = displayNameValue ? escapeHtml(displayNameValue) : '<span class="settings-email-missing">-</span>';
    return `<span class="settings-display-name-display" id="settings-display-name-display">
      <span class="settings-display-name-value">${name}</span>
      <button type="button" class="settings-inline-action" title="${escapeHtmlAttr(t('settings.profile.editDisplayName'))}" onclick="editUserDisplayName()">${iconSvg('edit-3')}</button>
    </span>`;
  }

  function renderSettingsEmailDisplay(user) {
    const email = user?.email ? escapeHtml(user.email) : '<span class="settings-email-missing">-</span>';
    const verified = user?.email
      ? (user?.email_verified_at
        ? `<span class="settings-email-status settings-email-verified">${escapeHtml(t('settings.email.verified'))}</span>`
        : `<span class="settings-email-status settings-email-unverified">${escapeHtml(t('settings.email.unverified'))}</span>`)
      : '';
    const pending = user?.pending_email ? `<span class="settings-email-pending">${escapeHtml(t('settings.email.pending', { email: user.pending_email }))}</span>` : '';
    return `<span class="settings-email-display" id="settings-email-display">
      <span class="settings-email-value">${email}</span>
      ${verified}
      ${pending}
      <button type="button" class="settings-email-action" title="${escapeHtmlAttr(t('settings.email.edit'))}" onclick="editUserEmail()">${iconSvg('edit-3')}</button>
    </span>`;
  }

  function renderLanguageSetting() {
    const select = document.getElementById('settings-language');
    if (select) select.value = getLanguagePreference();
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
    renderLanguageSetting();
  }

  async function refreshCurrentUser() {
    const freshUser = await authApi.me();
    const token = freshUser.access_token || getCurrentUser()?.token;
    const mfaEnrollmentRequired = Boolean(freshUser.mfa_enrollment_required || getCurrentUser()?.mfa_enrollment_required);
    setCurrentUser({ ...freshUser, token, mfa_enrollment_required: mfaEnrollmentRequired });
    localStorage.setItem('nia-mfa-enrollment-required', mfaEnrollmentRequired ? '1' : '0');
    if (freshUser.access_token) localStorage.setItem('jwt_token', freshUser.access_token);
    if (freshUser.csrf_token) localStorage.setItem('csrf_token', freshUser.csrf_token);
    if (freshUser.language) await adoptServerLanguagePreference(freshUser.language);
    renderUserInfo();
    translatePage(document);
  }

  function isMfaEnrollmentLocked() {
    return Boolean(getCurrentUser()?.mfa_enrollment_required || localStorage.getItem('nia-mfa-enrollment-required') === '1');
  }

  function shouldLockForTwoFactorState(state) {
    return Boolean(state?.required && !state?.enabled && !state?.has_totp && !state?.has_passkey && !state?.has_recovery_codes && !state?.has_email_fallback);
  }

  function updateSettingsEnrollmentLock(state = lastTwoFactorState) {
    const locked = Boolean(isMfaEnrollmentLocked() || shouldLockForTwoFactorState(state));
    const modal = document.getElementById('settings-modal');
    modal?.classList.toggle('mfa-enrollment-locked', locked);
    const overlay = modal?.querySelector('.modal-overlay');
    if (overlay) {
      if (locked) overlay.removeAttribute('onclick');
      else overlay.setAttribute('onclick', "closeModal('settings-modal')");
    }
    modal?.querySelector('.modal-close-x')?.toggleAttribute('hidden', locked);
    const closeBtn = document.getElementById('settings-close-btn');
    if (closeBtn) closeBtn.style.display = locked ? 'none' : '';
  }

  let pendingTotpSecret = '';
  let pendingTotpUrl = '';

  function renderRecoveryCodes(codes) {
    const box = document.getElementById('settings-2fa-recovery');
    if (!box || !codes?.length) return;
    box.style.display = '';
    box.innerHTML = `<strong>${escapeHtml(t('settings.2fa.recoverySaveNow'))}</strong><br><code style="white-space:pre-wrap; display:block; margin-top:8px;">${codes.map(escapeHtml).join('\n')}</code>`;
  }

  function renderTotpQr(otpauthUrl) {
    const qrEl = document.getElementById('settings-2fa-qr');
    if (!qrEl || !otpauthUrl) return;
    try {
      const qr = qrcode(0, 'M');
      qr.addData(otpauthUrl);
      qr.make();
      qrEl.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true, title: t('settings.2fa.qrTitle'), alt: t('settings.2fa.qrAlt') });
    } catch (err) {
      qrEl.textContent = t('settings.2fa.qrFailed');
    }
  }

  function trustedDeviceName(device) {
    return sessionDeviceName(device, t);
  }

  function sessionIpLocation(device) {
    const ip = String(device.ip_address || '').trim();
    if (!ip) return '';
    const lower = ip.toLowerCase();
    const parts = ip.split('.').map(part => Number(part));
    const isIpv4 = parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255);
    let locationKey = 'settings.2fa.sessionLocationPublic';
    if (ip === '127.0.0.1' || lower === '::1') locationKey = 'settings.2fa.sessionLocationLocal';
    else if (isIpv4 && (parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31))) locationKey = 'settings.2fa.sessionLocationPrivate';
    else if (isIpv4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) locationKey = 'settings.2fa.sessionLocationCarrierNat';
    else if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')) locationKey = 'settings.2fa.sessionLocationPrivate';
    return t('settings.2fa.sessionIpLocation', { ip, location: t(locationKey) });
  }

  function toggleTrustedDevicesList(forceOpen = null) {
    const panel = document.getElementById('settings-2fa-trusted-panel');
    const toggle = document.getElementById('settings-sessions-toggle');
    if (!panel || !toggle) return;
    const open = forceOpen === null ? panel.hidden : Boolean(forceOpen);
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  async function renderTrustedDevices(enrollmentOnly = false) {
    const listEl = document.getElementById('settings-2fa-trusted-devices');
    if (!listEl) return;
    const countEl = document.getElementById('settings-2fa-session-count');
    toggleTrustedDevicesList(false);
    if (enrollmentOnly) {
      if (countEl) countEl.textContent = '';
      listEl.innerHTML = `<div class="settings-device-note">${escapeHtml(t('settings.2fa.trustedDevicesUnavailable'))}</div>`;
      return;
    }
    try {
      const data = await authApi.listTrustedDevices();
      const devices = data.trusted_devices || [];
      if (countEl) countEl.textContent = devices.length ? `(${devices.length})` : '';
      if (!devices.length) {
        listEl.innerHTML = `<div class="settings-device-note">${escapeHtml(t('settings.2fa.noTrustedDevices'))}</div>`;
        return;
      }
      listEl.innerHTML = devices.map((device) => {
        const current = device.current_device ? ` <strong style="display:inline; color:var(--accent);">${escapeHtml(t('settings.2fa.currentDevice'))}</strong>` : '';
        const trusted = device.trusted ? ` · ${t('settings.2fa.trustedDeviceRemembered')}` : '';
        const lastUsed = device.last_used_at ? formatLocaleDateTime(device.last_used_at) : t('common.never');
        const expires = device.expires_at ? formatLocaleDateTime(device.expires_at) : '-';
        const details = t('settings.2fa.trustedDeviceDetails', { lastUsed, expires }) + trusted;
        const ipLocation = sessionIpLocation(device);
        const userAgent = cleanSessionUserAgent(device.user_agent || '');
        return `<div class="settings-device-row"><div><strong>${escapeHtml(trustedDeviceName(device))}${current}</strong><span>${escapeHtml(details)}</span>${ipLocation ? `<span>${escapeHtml(ipLocation)}</span>` : ''}<span title="${escapeHtmlAttr(userAgent)}">${escapeHtml(userAgent.slice(0, 120))}</span></div><button type="button" class="btn btn-danger" onclick="revokeTrustedDevice('${escapeHtmlAttr(device.id)}')">${escapeHtml(t('settings.2fa.revoke'))}</button></div>`;
      }).join('');
    } catch (err) {
      if (countEl) countEl.textContent = '';
      listEl.innerHTML = `<div class="settings-device-note">${escapeHtml(t('settings.2fa.trustedDevicesLoadFailed', { error: err.message || err }))}</div>`;
    }
  }

  async function renderTwoFactorDevices(state) {
    const listEl = document.getElementById('settings-2fa-devices');
    if (!listEl) return;
    const items = [];
    const enrollmentOnly = Boolean(isMfaEnrollmentLocked() || (state?.required && !state?.enabled && !state?.has_totp && !state?.has_passkey && !state?.has_recovery_codes && !state?.has_email_fallback));
    if (state?.has_totp) {
      items.push(`<div class="settings-device-row"><div><strong>${escapeHtml(t('settings.2fa.device.authenticator'))}</strong><span>${escapeHtml(t('settings.2fa.device.totpReady'))}</span></div><button type="button" class="btn btn-danger" onclick="removeTotpDevice()">${escapeHtml(t('settings.2fa.revoke'))}</button></div>`);
    } else if (!enrollmentOnly) {
      items.push(`<div class="settings-device-row"><div><strong>${escapeHtml(t('settings.2fa.device.authenticator'))}</strong><span>${escapeHtml(t('settings.2fa.device.totpNotSet'))}</span></div><button type="button" class="btn btn-primary" onclick="startTwoFactorTotp()">${escapeHtml(t('settings.2fa.setupAuthenticator'))}</button></div>`);
    }
    try {
      const data = enrollmentOnly ? { passkeys: [] } : await authApi.listPasskeys();
      (data.passkeys || []).forEach((pk) => {
        const used = pk.last_used_at ? t('settings.2fa.device.lastUsed', { date: formatLocaleDateTime(pk.last_used_at) }) : '';
        const details = t('settings.2fa.device.passkeyCreated', { created: pk.created_at || '-', used });
        items.push(`<div class="settings-device-row"><div><strong>${escapeHtml(pk.name || t('settings.2fa.passkeyDefaultName'))}</strong><span>${escapeHtml(details)}</span></div><button type="button" class="btn btn-danger" onclick="removePasskeyDevice(${Number(pk.id)})">${escapeHtml(t('settings.2fa.revoke'))}</button></div>`);
      });
    } catch (err) {
      items.push(`<div class="settings-device-note">${escapeHtml(t('settings.2fa.device.passkeysLoadFailed', { error: err.message || err }))}</div>`);
    }
    if (!items.length) {
      listEl.innerHTML = `<div class="settings-device-note">${escapeHtml(t('settings.2fa.noDevices'))}</div>`;
      return;
    }
    listEl.innerHTML = items.join('');
  }

  function updateRecoveryCodesAction(state) {
    const button = document.getElementById('settings-2fa-regenerate-recovery-btn');
    if (!button) return;
    const hasPrimaryFactor = Boolean(state?.has_totp || state?.has_passkey);
    button.style.display = hasPrimaryFactor ? '' : 'none';
    button.disabled = !hasPrimaryFactor;
    button.title = hasPrimaryFactor ? '' : t('settings.2fa.recoveryNeedsPrimary');
  }

  async function refreshTwoFactorStatus() {
    const statusEl = document.getElementById('settings-2fa-status');
    const errorEl = document.getElementById('settings-2fa-error');
    if (!statusEl) return;
    try {
      const state = await authApi.twoFactorStatus();
      lastTwoFactorState = state;
      updateRecoveryCodesAction(state);
      const parts = [];
      const hasPrimaryFactor = Boolean(state.has_totp || state.has_passkey);
      if (state.enabled) {
        parts.push(t('settings.2fa.state.active'));
      } else if (state.required && hasPrimaryFactor) {
        parts.push(t('settings.2fa.state.started'));
      } else if (state.required) {
        parts.push(t('settings.2fa.state.requiredMissing'));
      } else {
        parts.push(t('settings.2fa.state.inactive'));
      }
      if (state.has_totp) parts.push(t('settings.2fa.factor.authenticator', { count: 1 }));
      if (state.has_passkey) parts.push(t('settings.2fa.factor.passkeys', { count: state.passkey_count }));
      if (state.has_recovery_codes) parts.push(t('settings.2fa.factor.recovery', { count: state.recovery_codes_remaining }));
      if (state.has_email_fallback && !hasPrimaryFactor) parts.push(t('settings.2fa.factor.emailFallback'));
      statusEl.removeAttribute('data-i18n-key');
      statusEl.textContent = t('settings.2fa.status', { status: parts.join(' · ') });
      const setupBtn = document.querySelector('#settings-2fa-actions button[onclick="startTwoFactorTotp()"]');
      if (setupBtn) setupBtn.style.display = state.has_totp ? 'none' : '';
      document.getElementById('settings-2fa-actions')?.querySelectorAll('button').forEach((btn) => {
        if (btn.textContent.includes('deaktivieren')) btn.style.display = state.enabled ? '' : 'none';
      });
      updateSettingsEnrollmentLock(state);
      await renderTwoFactorDevices(state);
      await renderTrustedDevices(shouldLockForTwoFactorState(state));
    } catch (e) {
      lastTwoFactorState = null;
      updateRecoveryCodesAction(null);
      if (errorEl) errorEl.textContent = e.message || t('settings.2fa.loadFailed');
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
    document.getElementById('settings-language-error').textContent = '';
    document.getElementById('settings-language-success').textContent = '';
    document.getElementById('settings-2fa-error').textContent = '';
    document.getElementById('settings-2fa-success').textContent = '';
    document.getElementById('settings-2fa-setup').style.display = 'none';
    document.getElementById('settings-2fa-recovery').style.display = 'none';
    renderUserInfo();
    document.getElementById('settings-modal')?.classList.add('active');
    updateSettingsEnrollmentLock();
    await refreshCurrentUser().catch(() => {});
    updateSettingsEnrollmentLock();
    await refreshTwoFactorStatus();
    if (!isMfaEnrollmentLocked()) {
      resetApiKeyUi();
      loadApiKeys();
      updatePushSettingsUI();
    }
  }

  async function changeLanguagePreference(mode) {
    const errorEl = document.getElementById('settings-language-error');
    const successEl = document.getElementById('settings-language-success');
    if (errorEl) errorEl.textContent = '';
    if (successEl) successEl.textContent = '';
    try {
      await setLanguagePreference(mode, { authApi, syncServer: true });
      renderLanguageSetting();
      if (successEl) successEl.textContent = t('settings.language.saved');
    } catch (error) {
      if (errorEl) errorEl.textContent = error?.message || t('settings.language.saveFailed');
    }
  }

  function editUserDisplayName() {
    const currentName = getCurrentUser()?.display_name || getCurrentUser()?.username || '';
    const cell = document.getElementById('settings-display-name-cell');
    if (!cell) return;
    cell.innerHTML = `<span class="settings-display-name-edit" id="settings-display-name-edit">
      <input id="settings-display-name-input" type="text" maxlength="80" value="${escapeHtmlAttr(currentName)}" placeholder="${escapeHtmlAttr(t('settings.profile.displayName'))}" autocomplete="name" onkeydown="if(event.key==='Enter') saveUserProfile(); if(event.key==='Escape') cancelUserDisplayNameEdit()">
      <button type="button" class="settings-inline-action" title="${escapeHtmlAttr(t('common.save'))}" onclick="saveUserProfile()">${iconSvg('check')}</button>
      <button type="button" class="settings-inline-action" title="${escapeHtmlAttr(t('common.cancel'))}" onclick="cancelUserDisplayNameEdit()">${iconSvg('x')}</button>
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
      errorEl.textContent = t('settings.profile.displayNameRequired');
      return;
    }
    try {
      const data = await authApi.updateProfile(displayName);
      const currentUser = getCurrentUser();
      if (currentUser) setCurrentUser({ ...currentUser, ...data });
      renderUserInfo();
      successEl.textContent = t('settings.profile.saved');
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

  async function uploadOriginalAvatar(file, fallbackMessage = t('settings.avatar.saved')) {
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
      errorEl.textContent = t('settings.avatar.invalidImage');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      errorEl.textContent = t('settings.avatar.tooLarge');
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
        await uploadOriginalAvatar(file, t('settings.avatar.savedHeicCentered'));
      } else {
        if (input) input.value = '';
        errorEl.textContent = t('settings.avatar.openFailed');
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
      errorEl.textContent = t('settings.avatar.generateFailed');
      return;
    }

    try {
      const file = new File([blob], 'avatar.webp', { type: 'image/webp' });
      const data = await authApi.uploadAvatar(file);
      const currentUser = getCurrentUser();
      if (currentUser) setCurrentUser({ ...currentUser, ...data });
      cancelAvatarCrop();
      renderUserInfo();
      successEl.textContent = t('settings.avatar.saved');
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }

  async function deleteUserAvatar() {
    const confirmed = await confirmSecurityAction({
      title: t('settings.avatar.deleteTitle'),
      message: t('settings.avatar.deleteMessage'),
      confirmText: t('settings.avatar.deleteConfirm'),
      danger: true,
    });
    if (!confirmed) return;
    const errorEl = document.getElementById('settings-avatar-error');
    const successEl = document.getElementById('settings-avatar-success');
    errorEl.textContent = '';
    successEl.textContent = '';
    try {
      const data = await authApi.deleteAvatar();
      const currentUser = getCurrentUser();
      if (currentUser) setCurrentUser({ ...currentUser, ...data });
      renderUserInfo();
      successEl.textContent = t('settings.avatar.deleted');
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }

  function editUserEmail() {
    const currentEmail = getCurrentUser()?.email || '';
    const cell = document.getElementById('settings-email-cell');
    if (!cell) return;
    cell.innerHTML = `<span class="settings-email-edit" id="settings-email-edit">
      <input id="settings-email-input" type="email" value="${escapeHtmlAttr(currentEmail)}" placeholder="${escapeHtmlAttr(t('settings.email.placeholder'))}" autocomplete="email" onkeydown="if(event.key==='Enter') saveUserEmail(); if(event.key==='Escape') cancelUserEmailEdit()">
      <button type="button" class="settings-email-action" title="${escapeHtmlAttr(t('common.save'))}" onclick="saveUserEmail()">${iconSvg('check')}</button>
      <button type="button" class="settings-email-action" title="${escapeHtmlAttr(t('common.cancel'))}" onclick="cancelUserEmailEdit()">${iconSvg('x')}</button>
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
      errorEl.textContent = t('settings.email.required');
      return;
    }
    if (!isValidEmail(email)) {
      errorEl.textContent = t('settings.email.invalid');
      return;
    }

    try {
      const data = await withRecentMfaRetry(() => authApi.updateEmail(email), t('settings.email.mfaPurpose'));
      if (data.email_verification_delivery === 'unavailable') {
        await refreshCurrentUser().catch(() => renderUserInfo());
        errorEl.textContent = t('settings.email.alreadyUsed');
        return;
      }
      const currentUser = getCurrentUser();
      if (currentUser) setCurrentUser({ ...currentUser, email: data.email || currentUser.email, pending_email: data.pending_email || null });
      await refreshCurrentUser().catch(() => renderUserInfo());
      successEl.textContent = data.email_verification_required
        ? t('settings.email.verificationSent')
        : (data.email_verification_delivery === 'unverified_no_smtp' ? t('settings.email.savedUnverifiedNoSmtp') : t('settings.email.savedVerified'));
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
      const data = await withRecentMfaRetry(() => authApi.startTotp(), t('settings.2fa.purpose.setupTotp'));
      pendingTotpSecret = data.secret;
      pendingTotpUrl = data.otpauth_url || '';
      document.getElementById('settings-2fa-secret').textContent = data.secret;
      document.getElementById('settings-2fa-otpauth').value = pendingTotpUrl;
      renderTotpQr(pendingTotpUrl);
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
      errorEl.textContent = t('settings.2fa.secretAndCodeRequired');
      return;
    }
    try {
      const password = await promptSecurityPassword({
        title: t('settings.2fa.enableTitle'),
        message: t('settings.2fa.enableMessage'),
        primaryText: t('settings.2fa.enable'),
      });
      if (!password) throw new Error(t('security.passwordRequired'));
      const data = await authApi.confirmTotp(pendingTotpSecret, code, password);
      const wasEnrollmentLocked = isMfaEnrollmentLocked();
      if (data.access_token) localStorage.setItem('jwt_token', data.access_token);
      localStorage.setItem('nia-mfa-enrollment-required', '0');
      const currentUser = getCurrentUser();
      if (currentUser) setCurrentUser({ ...currentUser, token: data.access_token || currentUser.token, mfa_enrollment_required: false });
      updateSettingsEnrollmentLock();
      pendingTotpSecret = '';
      pendingTotpUrl = '';
      document.getElementById('settings-2fa-setup').style.display = 'none';
      renderRecoveryCodes(data.recovery_codes);
      successEl.textContent = t('settings.2fa.enabled');
      await refreshTwoFactorStatus();
      if (wasEnrollmentLocked) {
        document.getElementById('settings-modal')?.classList.remove('active');
        if (typeof window.initApp === 'function') await window.initApp();
        if (typeof window.refreshFromServer === 'function') await window.refreshFromServer();
      }
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }

  async function ensureRecentMfa(purpose = t('security.mfa.purposeDefault')) {
    await performMfaReauth({ authApi, purpose });
  }

  async function withRecentMfaRetry(action, purpose = t('security.mfa.purposeDefault')) {
    try {
      return await action();
    } catch (e) {
      if (e.status !== 403) throw e;
      await ensureRecentMfa(purpose);
      return action();
    }
  }

  async function disableTwoFactor() {
    const confirmed = await confirmSecurityAction({ title: t('settings.2fa.disableTitle'), message: t('settings.2fa.disableMessage'), confirmText: t('settings.2fa.disable'), danger: true });
    if (!confirmed) return;
    const errorEl = document.getElementById('settings-2fa-error');
    const successEl = document.getElementById('settings-2fa-success');
    errorEl.textContent = '';
    successEl.textContent = '';
    try {
      await ensureRecentMfa(t('settings.2fa.purpose.disable'));
      await authApi.disable2fa('');
      successEl.textContent = t('settings.2fa.disabled');
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
    if (!(RUNTIME_CAPABILITIES.nativePasskeys || (!RUNTIME_CAPABILITIES.native && window.PublicKeyCredential && navigator.credentials))) {
      errorEl.textContent = t('settings.2fa.passkeyUnsupported');
      return;
    }
    try {
      const state = await authApi.twoFactorStatus().catch(() => ({}));
      const wasEnrollmentLocked = Boolean(isMfaEnrollmentLocked() || shouldLockForTwoFactorState(state));
      const hasExistingSecondFactor = Boolean(state.has_totp || state.has_passkey || state.has_recovery_codes || state.has_email_fallback);
      if ((state.enabled || state.required) && hasExistingSecondFactor && !wasEnrollmentLocked) await ensureRecentMfa(t('settings.2fa.purpose.addPasskey'));
      const name = await promptSecurityText({ title: t('settings.2fa.addPasskey'), message: t('settings.2fa.passkeyAddMessage'), label: t('common.name'), value: t('settings.2fa.passkeyDefaultName'), required: true, primaryText: t('common.continue') });
      if (!name) throw new Error(t('settings.2fa.passkeySetupCancelled'));
      const password = await promptSecurityPassword({ title: t('settings.2fa.addPasskey'), message: t('settings.2fa.passkeyPasswordMessage'), primaryText: t('settings.2fa.passkeyCreate') });
      if (!password) throw new Error(t('security.passwordRequired'));
      const data = await authApi.createPasskey(name.trim() || t('settings.2fa.passkeyDefaultName'), password);
      if (data.access_token) localStorage.setItem('jwt_token', data.access_token);
      localStorage.setItem('nia-mfa-enrollment-required', '0');
      const currentUser = getCurrentUser();
      if (currentUser) setCurrentUser({ ...currentUser, token: data.access_token || currentUser.token, mfa_enrollment_required: false });
      updateSettingsEnrollmentLock();
      if (data.recovery_codes?.length) renderRecoveryCodes(data.recovery_codes);
      successEl.textContent = t('settings.2fa.passkeySaved');
      await refreshTwoFactorStatus();
      if (wasEnrollmentLocked) {
        document.getElementById('settings-modal')?.classList.remove('active');
        if (typeof window.initApp === 'function') await window.initApp();
        if (typeof window.refreshFromServer === 'function') await window.refreshFromServer();
      }
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }

  async function removeTotpDevice() {
    const confirmed = await confirmSecurityAction({ title: t('settings.2fa.revokeTotpTitle'), message: t('settings.2fa.revokeTotpMessage'), confirmText: t('settings.2fa.revokeTotpConfirm'), danger: true });
    if (!confirmed) return;
    const errorEl = document.getElementById('settings-2fa-error');
    const successEl = document.getElementById('settings-2fa-success');
    errorEl.textContent = '';
    successEl.textContent = '';
    try {
      await ensureRecentMfa(t('settings.2fa.purpose.revokeTotp'));
      await authApi.deleteTotp();
      successEl.textContent = t('settings.2fa.totpRevoked');
      await refreshTwoFactorStatus();
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }

  function setTrustedDeviceRevokeLoading(loading) {
    trustedDeviceRevokeInFlight = loading;
    document.querySelectorAll('.settings-device-row button, #settings-2fa-revoke-all-trusted').forEach((button) => {
      button.disabled = loading;
    });
  }

  async function revokeTrustedDevice(deviceId) {
    if (trustedDeviceRevokeInFlight) return;
    const confirmed = await confirmSecurityAction({ title: t('settings.2fa.revokeTrustedTitle'), message: t('settings.2fa.revokeTrustedMessage'), confirmText: t('settings.2fa.revokeTrustedConfirm'), danger: true });
    if (!confirmed) return;
    const errorEl = document.getElementById('settings-2fa-error');
    const successEl = document.getElementById('settings-2fa-success');
    errorEl.textContent = '';
    successEl.textContent = '';
    setTrustedDeviceRevokeLoading(true);
    try {
      const data = await authApi.deleteTrustedDevice(deviceId);
      successEl.textContent = t('settings.2fa.trustedDeviceRevoked');
      if (data.current_session) {
        setTimeout(() => logout(), 600);
        return;
      }
      await renderTrustedDevices();
    } catch (e) {
      errorEl.textContent = e.message;
    } finally {
      setTrustedDeviceRevokeLoading(false);
    }
  }

  async function revokeAllTrustedDevices() {
    if (trustedDeviceRevokeInFlight) return;
    const confirmed = await confirmSecurityAction({ title: t('settings.2fa.revokeAllTrustedTitle'), message: t('settings.2fa.revokeAllTrustedMessage'), confirmText: t('settings.2fa.revokeAllTrusted'), danger: true });
    if (!confirmed) return;
    const errorEl = document.getElementById('settings-2fa-error');
    const successEl = document.getElementById('settings-2fa-success');
    errorEl.textContent = '';
    successEl.textContent = '';
    setTrustedDeviceRevokeLoading(true);
    try {
      await authApi.deleteAllTrustedDevices();
      successEl.textContent = t('settings.2fa.trustedDevicesRevoked');
      setTimeout(() => logout(), 600);
    } catch (e) {
      errorEl.textContent = e.message;
      setTrustedDeviceRevokeLoading(false);
    }
  }

  async function removePasskeyDevice(passkeyId) {
    const confirmed = await confirmSecurityAction({ title: t('settings.2fa.revokePasskeyTitle'), message: t('settings.2fa.revokePasskeyMessage'), confirmText: t('settings.2fa.revokePasskeyConfirm'), danger: true });
    if (!confirmed) return;
    const errorEl = document.getElementById('settings-2fa-error');
    const successEl = document.getElementById('settings-2fa-success');
    errorEl.textContent = '';
    successEl.textContent = '';
    try {
      await ensureRecentMfa(t('settings.2fa.purpose.revokePasskey'));
      await authApi.deletePasskey(passkeyId);
      successEl.textContent = t('settings.2fa.passkeyRevoked');
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
    if (!(lastTwoFactorState?.has_totp || lastTwoFactorState?.has_passkey)) {
      errorEl.textContent = t('settings.2fa.recoveryNeedsPrimary');
      updateRecoveryCodesAction(lastTwoFactorState);
      return;
    }
    try {
      await ensureRecentMfa(t('settings.2fa.purpose.regenerateRecovery'));
      const data = await authApi.regenerateRecoveryCodes();
      renderRecoveryCodes(data.recovery_codes);
      successEl.textContent = t('settings.2fa.recoveryRegenerated');
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
      document.getElementById('settings-pw-error').textContent = t('settings.password.allRequired');
      return;
    }
    if (newPw !== confirmPw) {
      document.getElementById('settings-pw-error').textContent = t('settings.password.mismatch');
      return;
    }

    try {
      await withRecentMfaRetry(() => authApi.changePassword(oldPw, newPw), t('settings.password.mfaPurpose'));
      document.getElementById('settings-pw-success').textContent = t('settings.password.changed');
      setTimeout(() => logout(), 1500);
    } catch (e) {
      document.getElementById('settings-pw-error').textContent = e.message;
    }
  }

  return {
    renderUserInfo,
    openSettingsModal,
    changeLanguagePreference,
    editUserDisplayName,
    cancelUserDisplayNameEdit,
    saveUserProfile,
    startAvatarUpload,
    cancelAvatarCrop,
    saveAvatarCrop,
    deleteUserAvatar,
    editUserEmail,
    cancelUserEmailEdit,
    saveUserEmail,
    changeUserPassword,
    startTwoFactorTotp,
    confirmTwoFactorTotp,
    disableTwoFactor,
    addPasskey,
    regenerateRecoveryCodes,
    removeTotpDevice,
    removePasskeyDevice,
    toggleTrustedDevicesList,
    revokeTrustedDevice,
    revokeAllTrustedDevices,
  };
}

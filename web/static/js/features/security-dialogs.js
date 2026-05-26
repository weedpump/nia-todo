import { RUNTIME_CAPABILITIES } from '../core/config.js';
import { t } from '../i18n/index.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function setText(id, value = '') {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setDisplay(id, value) {
  const el = document.getElementById(id);
  if (el) el.style.display = value;
}

function closeSecurityDialog() {
  document.getElementById('security-action-modal')?.classList.remove('active');
}

function openSecurityDialog({ title, message = '', bodyHtml = '', primaryText = t('common.confirm'), danger = false, onSubmit, onOpen }) {
  const modal = document.getElementById('security-action-modal');
  const form = document.getElementById('security-action-form');
  const body = document.getElementById('security-action-body');
  const primary = document.getElementById('security-action-primary');
  const cancel = document.getElementById('security-action-cancel');
  const overlay = document.getElementById('security-action-overlay');
  const error = document.getElementById('security-action-error');
  if (!modal || !form || !body || !primary) {
    return Promise.reject(new Error(t('security.dialogUnavailable')));
  }

  const titleEl = document.getElementById('security-action-title');
  const messageEl = document.getElementById('security-action-message');
  titleEl?.removeAttribute('data-i18n-key');
  primary?.removeAttribute('data-i18n-key');
  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;
  error.textContent = '';
  body.innerHTML = bodyHtml;
  primary.textContent = primaryText;
  primary.classList.toggle('btn-danger', Boolean(danger));
  primary.classList.toggle('btn-primary', !danger);
  modal.classList.add('active');

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      form.removeEventListener('submit', submitHandler);
      cancel?.removeEventListener('click', cancelHandler);
      overlay?.removeEventListener('click', cancelHandler);
      document.removeEventListener('keydown', keyHandler);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      closeSecurityDialog();
      resolve(value);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      closeSecurityDialog();
      reject(err);
    };
    const cancelHandler = () => finish(null);
    const keyHandler = (event) => {
      if (event.key === 'Escape') cancelHandler();
    };
    const submitHandler = async (event) => {
      event.preventDefault();
      error.textContent = '';
      primary.disabled = true;
      try {
        const result = await onSubmit?.(new FormData(form));
        finish(result ?? true);
      } catch (err) {
        error.textContent = err?.message || String(err);
      } finally {
        primary.disabled = false;
      }
    };
    form.addEventListener('submit', submitHandler);
    cancel?.addEventListener('click', cancelHandler);
    overlay?.addEventListener('click', cancelHandler);
    document.addEventListener('keydown', keyHandler);
    try {
      onOpen?.(form);
    } catch (err) {
      fail(err);
    }
  });
}

export function promptSecurityText({ title, message = '', label = t('security.input'), name = 'value', value = '', placeholder = '', required = false, autocomplete = 'off', primaryText = t('common.continue') }) {
  return openSecurityDialog({
    title,
    message,
    primaryText,
    bodyHtml: `<label class="security-field"><span>${escapeHtml(label)}</span><input name="${escapeHtml(name)}" type="text" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" autocomplete="${escapeHtml(autocomplete)}" ${required ? 'required' : ''}></label>`,
    onOpen: (form) => form.querySelector('input')?.focus(),
    onSubmit: (formData) => formData.get(name)?.toString() || '',
  });
}

export function promptSecurityPassword({ title, message = '', label = t('security.password'), primaryText = t('common.confirm') }) {
  return openSecurityDialog({
    title,
    message,
    primaryText,
    bodyHtml: `<label class="security-field"><span>${escapeHtml(label)}</span><input name="password" type="password" autocomplete="current-password" required></label>`,
    onOpen: (form) => form.querySelector('input')?.focus(),
    onSubmit: (formData) => {
      const password = formData.get('password')?.toString() || '';
      if (!password) throw new Error(t('security.passwordRequired'));
      return password;
    },
  });
}

export function confirmSecurityAction({ title, message = '', confirmText = t('common.confirm'), danger = false }) {
  return openSecurityDialog({
    title,
    message,
    primaryText: confirmText,
    danger,
    bodyHtml: '',
    onSubmit: () => true,
  });
}

export function promptPasskeyDetails() {
  return openSecurityDialog({
    title: t('security.passkey.add'),
    message: t('security.passkey.addMessage'),
    primaryText: t('security.passkey.create'),
    bodyHtml: `
      <label class="security-field"><span>${escapeHtml(t('security.passkey.name'))}</span><input name="name" type="text" value="Passkey" autocomplete="off" maxlength="80" required></label>
      <label class="security-field"><span>${escapeHtml(t('security.confirmPassword'))}</span><input name="password" type="password" autocomplete="current-password" required></label>
    `,
    onOpen: (form) => form.querySelector('input[name="name"]')?.focus(),
    onSubmit: (formData) => {
      const name = (formData.get('name')?.toString() || 'Passkey').trim() || 'Passkey';
      const password = formData.get('password')?.toString() || '';
      if (!password) throw new Error(t('security.passwordRequired'));
      return { name, password };
    },
  });
}

export async function performMfaReauth({ authApi, purpose = t('security.mfa.purposeDefault') }) {
  const state = await authApi.twoFactorStatus().catch(() => ({}));
  if (!state.enabled && !state.required) return;

  const canPasskey = state.has_passkey && ((!RUNTIME_CAPABILITIES.native && window.PublicKeyCredential && navigator.credentials) || RUNTIME_CAPABILITIES.nativePasskeys);
  const hasCode = state.has_totp || state.has_recovery_codes || state.has_email_fallback;
  const codeLabel = state.has_totp && state.has_recovery_codes
    ? t('security.mfa.code.authOrRecovery')
    : state.has_totp
      ? t('security.mfa.code.authenticator')
      : state.has_recovery_codes
        ? t('security.mfa.code.recovery')
        : t('security.mfa.code.email');
  let emailStarted = false;
  let codeMode = (state.has_totp || state.has_recovery_codes) ? 'totp' : (state.has_email_fallback ? 'email' : 'none');

  const startEmailIfNeeded = async () => {
    if (codeMode === 'email' && !emailStarted) {
      await authApi.startEmailReauth();
      emailStarted = true;
      setDisplay('security-reauth-email-hint', '');
    }
  };

  let passkeyCompleted = false;
  const runPasskeyReauth = async () => {
    const data = await authApi.reauthPasskey();
    if (data.access_token) localStorage.setItem('jwt_token', data.access_token);
    passkeyCompleted = true;
    return true;
  };
  const result = await openSecurityDialog({
    title: t('security.mfa.requiredTitle'),
    message: t('security.mfa.requiredMessage', { purpose }),
    primaryText: canPasskey && !hasCode ? t('security.mfa.passkey') : t('security.mfa.confirmCode'),
    bodyHtml: `
      ${canPasskey && hasCode ? `<button type="button" class="btn btn-secondary security-passkey-btn" id="security-reauth-passkey">${escapeHtml(t('security.mfa.passkey'))}</button>` : ''}
      ${hasCode ? `<label class="security-field"><span id="security-reauth-code-label">${codeLabel}</span><input name="code" id="security-reauth-code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="${escapeHtml(t('security.mfa.codePlaceholder'))}"></label>` : ''}
      <div class="security-dialog-hint" id="security-reauth-email-hint" style="display:none;">${escapeHtml(t('security.mfa.emailSent'))}</div>
      <div class="security-dialog-hint">${escapeHtml(t('security.mfa.singleUseHint'))}</div>
    `,
    onOpen: async (form) => {
      const passkeyBtn = form.querySelector('#security-reauth-passkey');
      passkeyBtn?.addEventListener('click', async () => {
        setText('security-action-error', '');
        passkeyBtn.disabled = true;
        try {
          await runPasskeyReauth();
          form.requestSubmit();
        } catch (err) {
          setText('security-action-error', err?.message || String(err));
        } finally {
          passkeyBtn.disabled = false;
        }
      });
      if (codeMode === 'email') await startEmailIfNeeded();
      form.querySelector('#security-reauth-code')?.focus();
    },
    onSubmit: async (formData) => {
      if (passkeyCompleted) return true;
      if (canPasskey && !hasCode) return runPasskeyReauth();
      await startEmailIfNeeded();
      const code = formData.get('code')?.toString().trim() || '';
      if (!code) throw new Error(t('security.mfa.codeRequired'));
      const method = codeMode === 'email' ? 'email' : (code.includes('-') ? 'recovery_code' : 'totp');
      const data = await authApi.reauth(method, code);
      if (data.access_token) localStorage.setItem('jwt_token', data.access_token);
      return true;
    },
  });

  if (!result) throw new Error(t('security.mfa.cancelled'));
}

export { closeSecurityDialog };

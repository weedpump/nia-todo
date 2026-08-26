import { hydrateIcons } from '../icons/lucide-icons.js';
hydrateIcons(document);
import { initI18n, t } from '../i18n/index.js';
import { apiErrorFromResponse } from '../api/errors.js';
await initI18n();

const initialParams = new URLSearchParams(location.search);
const token = initialParams.get('token') || '';
if (token) {
  initialParams.delete('token');
  const cleanUrl = `${location.pathname}${initialParams.toString() ? `?${initialParams}` : ''}${location.hash}`;
  history.replaceState(null, '', cleanUrl);
}
const intro = document.getElementById('intro');
const form = document.getElementById('password-form');
const errorEl = document.getElementById('error');
const fatalError = document.getElementById('fatal-error');
const successEl = document.getElementById('success');
const submitBtn = document.getElementById('submit-btn');
const resendBox = document.getElementById('resend-box');
const resendBtn = document.getElementById('resend-btn');
const resendLinkInput = document.getElementById('resend-link-input');

async function parseOrThrow(response) {
  if (!response.ok) await apiErrorFromResponse(response, t('common.error'));
  return response.json().catch(() => ({}));
}

async function init() {
  if (!token) {
    intro.textContent = t('setPassword.missingTokenIntro');
    fatalError.textContent = t('setPassword.missingTokenHint');
    return;
  }
  try {
    const data = await fetch('/api/password-setup/validate?token=' + encodeURIComponent(token)).then(parseOrThrow);
    if (data.expired) {
      intro.textContent = t('setPassword.expiredIntro', { name: data.display_name || data.username });
      if (data.can_resend) {
        fatalError.textContent = t('setPassword.canResend');
        resendBox.classList.remove('hidden');
      } else {
        fatalError.textContent = t('setPassword.contactAdmin');
      }
      return;
    }
    intro.textContent = t('setPassword.validIntro', { name: data.display_name || data.username });
    form.classList.remove('hidden');
  } catch (e) {
    intro.textContent = t('setPassword.invalidLink');
    fatalError.textContent = e.message;
  }
}

resendBtn.addEventListener('click', async () => {
  fatalError.textContent = '';
  successEl.textContent = '';
  resendLinkInput.classList.add('hidden');
  resendBtn.disabled = true;
  try {
    const data = await fetch('/api/password-setup/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }).then(parseOrThrow);
    if (data.password_setup_delivery === 'email') {
      successEl.textContent = t('setPassword.resendSentEmail');
    } else if (data.password_setup_url) {
      successEl.textContent = t('setPassword.resendCreated');
      resendLinkInput.value = data.password_setup_url;
      resendLinkInput.classList.remove('hidden');
    } else {
      successEl.textContent = data.message || t('setPassword.resendRequested');
    }
  } catch (e) {
    fatalError.textContent = e.message;
    resendBtn.disabled = false;
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.textContent = '';
  successEl.textContent = '';
  const password = document.getElementById('password').value;
  const confirm = document.getElementById('confirm-password').value;
  if (password !== confirm) {
    errorEl.textContent = t('settings.password.mismatch');
    return;
  }
  submitBtn.disabled = true;
  try {
    await fetch('/api/password-setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    }).then(parseOrThrow);
    form.classList.add('hidden');
    intro.textContent = t('setPassword.completedIntro');
    successEl.innerHTML = `${t('setPassword.completedMessage')}<br><a class="btn btn-primary" href="/">${t('setPassword.toApp')}</a>`;
  } catch (e) {
    errorEl.textContent = e.message;
    submitBtn.disabled = false;
  }
});

init();

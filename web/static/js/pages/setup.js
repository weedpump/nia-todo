import { hydrateIcons } from '../icons/lucide-icons.js';
import { initI18n, t } from '../i18n/index.js';
import { apiErrorFromResponse } from '../api/errors.js';
await initI18n();
hydrateIcons(document);

const API = '';


function setTheme(mode) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = mode === 'dark' || (mode === 'system' && prefersDark);
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  localStorage.setItem('theme', mode);
  document.querySelectorAll('.setup-theme-toggle button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === mode);
  });
}

// Init theme
const stored = localStorage.getItem('theme');
if (stored && stored !== 'system') setTheme(stored);
else setTheme('system');

// Check setup status on load
async function checkSetup() {
  try {
    const r = await fetch(API + '/api/setup/status');
    const data = await r.json();
    if (data.setup_complete) {
      window.location.href = '/';
    } else if (data.admin_password_set) {
      showStep(2);
    }
  } catch(e) {
    console.error('Setup check failed:', e);
  }
}
checkSetup();

function showStep(step) {
  document.querySelectorAll('.setup-step').forEach(s => s.classList.remove('active'));
  document.getElementById('step-' + step).classList.add('active');
  document.querySelectorAll('.step-dot').forEach((d, i) => d.classList.toggle('active', i + 1 === step));
}

function showError(step, msg) {
  document.getElementById('error-' + step).textContent = msg;
}

async function getApiErrorMessage(response) {
  try {
    await apiErrorFromResponse(response, t('common.error'));
  } catch (error) {
    return error?.message || t('common.error');
  }
  return t('common.error');
}

async function setAdminPassword() {
  const pw = document.getElementById('admin-password').value;
  const confirm = document.getElementById('admin-password-confirm').value;

  if (!pw || pw.length < 12) {
    showError(1, t('setup.error.adminPasswordTooShort'));
    return;
  }
  if (pw !== confirm) {
    showError(1, t('settings.password.mismatch'));
    return;
  }

  try {
    const r = await fetch(API + '/api/setup/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Setup-Token': document.getElementById('setup-token').value.trim() },
      body: JSON.stringify({ admin_password: pw })
    });
    if (!r.ok) {
      showError(1, await getApiErrorMessage(r));
      return;
    }
    showError(1, '');
    showStep(2);
  } catch(e) {
    showError(1, t('setup.error.network'));
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

async function createFirstUser() {
  const username = document.getElementById('first-username').value.trim();
  const displayName = document.getElementById('first-display-name').value.trim();
  const email = document.getElementById('first-email').value.trim();
  const password = document.getElementById('first-password').value;

  if (!username || !email || !password) {
    showError(2, t('setup.error.firstUserRequired'));
    return;
  }
  if (!isValidEmail(email)) {
    showError(2, t('setup.error.invalidEmail'));
    return;
  }

  try {
    const r = await fetch(API + '/api/setup/first-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Setup-Token': document.getElementById('setup-token').value.trim() },
      body: JSON.stringify({
        username: username,
        email: email,
        display_name: displayName || username,
        password: password
      })
    });
    if (!r.ok) {
      showError(2, await getApiErrorMessage(r));
      return;
    }
    showError(2, '');
    showStep('success');
    setTimeout(() => window.location.href = '/', 2000);
  } catch(e) {
    showError(2, t('setup.error.network'));
  }
}


document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-setup-action]');
  if (!target) return;
  const action = target.dataset.setupAction;
  if (action === 'set-admin-password') setAdminPassword();
  if (action === 'create-first-user') createFirstUser();
  if (action === 'set-theme') setTheme(target.dataset.theme);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const target = event.target;
  if (target.dataset.setupAction === 'set-admin-password') setAdminPassword();
  else if (target.dataset.setupAction === 'create-first-user') createFirstUser();
  else if (target.dataset.nextFocus) document.getElementById(target.dataset.nextFocus)?.focus();
});

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

export function createUserSettingsFeature({ authApi, getCurrentUser, setCurrentUser, resetApiKeyUi, loadApiKeys, updatePushSettingsUI, logout }) {
  function renderSettingsEmailDisplay(emailValue) {
    const email = emailValue ? escapeHtml(emailValue) : '<span class="settings-email-missing">-</span>';
    return `<span class="settings-email-display" id="settings-email-display">
      <span class="settings-email-value">${email}</span>
      <button type="button" class="settings-email-action" title="E-Mail bearbeiten" onclick="editUserEmail()">✏️</button>
    </span>`;
  }

  function renderUserInfo() {
    const currentUser = getCurrentUser();
    const nameEl = document.getElementById('user-name');
    const settingsNameEl = document.getElementById('settings-user-name');
    const settingsEmailCell = document.getElementById('settings-email-cell');
    if (nameEl && currentUser) nameEl.textContent = currentUser.display_name || currentUser.username;
    if (settingsNameEl && currentUser) settingsNameEl.textContent = currentUser.display_name || currentUser.username;
    if (settingsEmailCell && currentUser) settingsEmailCell.innerHTML = renderSettingsEmailDisplay(currentUser.email || '');
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
    renderUserInfo();
    document.getElementById('settings-modal')?.classList.add('active');
    await refreshCurrentUser().catch(() => {});
    resetApiKeyUi();
    loadApiKeys();
    updatePushSettingsUI();
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

  return { renderUserInfo, openSettingsModal, editUserEmail, cancelUserEmailEdit, saveUserEmail, changeUserPassword };
}

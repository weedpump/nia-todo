export function createUserSettingsFeature({ authApi, getCurrentUser, setCurrentUser, resetApiKeyUi, loadApiKeys, updatePushSettingsUI, logout }) {
  function renderUserInfo() {
    const currentUser = getCurrentUser();
    const nameEl = document.getElementById('user-name');
    const settingsNameEl = document.getElementById('settings-user-name');
    const settingsEmailEl = document.getElementById('settings-email');
    if (nameEl && currentUser) nameEl.textContent = currentUser.display_name || currentUser.username;
    if (settingsNameEl && currentUser) settingsNameEl.textContent = currentUser.display_name || currentUser.username;
    if (settingsEmailEl && currentUser) settingsEmailEl.value = currentUser.email || '';
  }

  function openSettingsModal() {
    document.getElementById('settings-old-password').value = '';
    document.getElementById('settings-new-password').value = '';
    document.getElementById('settings-confirm-password').value = '';
    document.getElementById('settings-pw-error').textContent = '';
    document.getElementById('settings-pw-success').textContent = '';
    document.getElementById('settings-email-error').textContent = '';
    document.getElementById('settings-email-success').textContent = '';
    renderUserInfo();
    resetApiKeyUi();
    document.getElementById('settings-modal')?.classList.add('active');
    loadApiKeys();
    updatePushSettingsUI();
  }

  async function changeUserEmail() {
    const email = document.getElementById('settings-email').value.trim();
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

  return { renderUserInfo, openSettingsModal, changeUserEmail, changeUserPassword };
}

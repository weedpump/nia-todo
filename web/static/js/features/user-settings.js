export function createUserSettingsFeature({ authApi, getCurrentUser, resetApiKeyUi, loadApiKeys, updatePushSettingsUI, logout }) {
  function renderUserInfo() {
    const currentUser = getCurrentUser();
    const nameEl = document.getElementById('user-name');
    const settingsNameEl = document.getElementById('settings-user-name');
    if (nameEl && currentUser) nameEl.textContent = currentUser.display_name || currentUser.username;
    if (settingsNameEl && currentUser) settingsNameEl.textContent = currentUser.display_name || currentUser.username;
  }

  function openSettingsModal() {
    document.getElementById('settings-old-password').value = '';
    document.getElementById('settings-new-password').value = '';
    document.getElementById('settings-confirm-password').value = '';
    document.getElementById('settings-pw-error').textContent = '';
    document.getElementById('settings-pw-success').textContent = '';
    resetApiKeyUi();
    document.getElementById('settings-modal')?.classList.add('active');
    loadApiKeys();
    updatePushSettingsUI();
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

  return { renderUserInfo, openSettingsModal, changeUserPassword };
}

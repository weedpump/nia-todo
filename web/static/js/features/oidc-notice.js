export function createOidcNoticeFeature({ t, showLoginOverlay, alertInfo }) {
  function consumeOidcErrorNotice() {
    const raw = sessionStorage.getItem('nia_oidc_error');
    if (!raw) return;
    sessionStorage.removeItem('nia_oidc_error');
    let message = t('auth.oidc.errorMessage');
    try {
      const data = JSON.parse(raw);
      message = data?.error_key ? t(data.error_key) : message;
    } catch (_) {}
    requestAnimationFrame(() => {
      showLoginOverlay();
      const errorEl = document.getElementById('login-error');
      if (errorEl) errorEl.textContent = message;
      alertInfo({ title: t('auth.oidc.errorTitle'), message }).catch(() => {});
    });
  }

  return { consumeOidcErrorNotice };
}

import { t, getActiveLanguage } from '../i18n/index.js';
import { iconSvg } from '../icons/lucide-icons.js';
import { confirmSecurityAction, performMfaReauth, promptSecurityText } from './security-dialogs.js';

export function createApiKeysFeature({ authApi }) {
  let lastApiKeys = [];
  let hasLoadedApiKeys = false;

  function parseServerUtcTimestamp(value) {
    if (!value) return null;
    const raw = String(value).trim();
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const date = new Date(hasTimezone ? normalized : `${normalized}Z`);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function formatServerTimestamp(value) {
    const date = parseServerUtcTimestamp(value);
    const locale = getActiveLanguage() === 'en' ? 'en-US' : 'de-DE';
    return date ? date.toLocaleString(locale) : String(value || '');
  }

  function resetApiKeyUi() {
    const createdEl = document.getElementById('api-key-created');
    const valueEl = document.getElementById('api-key-value');
    const errorEl = document.getElementById('api-key-error');
    const copyStatusEl = document.getElementById('api-key-copy-status');
    if (createdEl) createdEl.style.display = 'none';
    if (valueEl) valueEl.textContent = '';
    if (errorEl) errorEl.textContent = '';
    if (copyStatusEl) copyStatusEl.textContent = '';
  }

  async function loadApiKeys() {
    const listEl = document.getElementById('api-keys-list');
    const errorEl = document.getElementById('api-key-error');
    if (!listEl) return;
    try {
      const data = await authApi.listApiKeys();
      renderApiKeys(data.api_keys || []);
    } catch (e) {
      console.error('API keys load failed:', e);
      if (errorEl) errorEl.textContent = e.message;
    }
  }

  function renderApiKeys(keys) {
    hasLoadedApiKeys = true;
    lastApiKeys = Array.isArray(keys) ? keys : [];
    const listEl = document.getElementById('api-keys-list');
    if (!listEl) return;
    listEl.textContent = '';

    if (!keys.length) {
      const p = document.createElement('p');
      p.style.cssText = 'font-size:13px; color:var(--text-muted);';
      p.textContent = t('settings.apiKeys.empty');
      listEl.appendChild(p);
      return;
    }

    keys.forEach(k => {
      const revoked = k.revoked_at;
      const container = document.createElement('div');
      container.style.cssText = 'background:var(--bg-tertiary); padding:10px 12px; border-radius:var(--radius); margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;';

      const left = document.createElement('div');
      left.style.minWidth = '0';

      const nameRow = document.createElement('div');
      nameRow.style.cssText = 'font-size:13px; font-weight:500; margin-bottom:2px;';
      nameRow.textContent = k.name;
      if (revoked) {
        const span = document.createElement('span');
        span.style.cssText = 'color:var(--danger); font-size:11px; margin-left:4px;';
        span.append('(');
        span.insertAdjacentHTML('beforeend', iconSvg('ban'));
        span.append(` ${t('settings.apiKeys.revoked')})`);
        nameRow.appendChild(span);
      }

      const keyRow = document.createElement('div');
      keyRow.style.cssText = 'font-size:12px; color:var(--text-muted); font-family:monospace;';
      keyRow.textContent = k.key_prefix + '****';

      const usedRow = document.createElement('div');
      usedRow.style.cssText = 'margin-top:4px; font-size:11px; color:var(--text-muted);';
      usedRow.textContent = k.last_used_at
        ? t('settings.apiKeys.lastUsed', { timestamp: formatServerTimestamp(k.last_used_at) })
        : t('settings.apiKeys.neverUsed');

      left.appendChild(nameRow);
      left.appendChild(keyRow);
      left.appendChild(usedRow);
      container.appendChild(left);

      if (!revoked) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-danger';
        btn.style.cssText = 'font-size:12px; padding:4px 8px; flex-shrink:0; margin-left:8px;';
        btn.title = t('settings.apiKeys.revoke');
        btn.innerHTML = iconSvg('trash-2');
        btn.onclick = () => revokeApiKey(k.id);
        container.appendChild(btn);
      }

      listEl.appendChild(container);
    });
  }

  async function ensureRecentMfaForApiKeyAction() {
    await performMfaReauth({ authApi, purpose: t('settings.apiKeys.mfaPurpose') });
  }

  async function withMfaRetry(action) {
    try {
      return await action();
    } catch (e) {
      if (![401, 403].includes(e.status)) throw e;
      await ensureRecentMfaForApiKeyAction();
      return action();
    }
  }

  async function createApiKey() {
    const name = await promptSecurityText({
      title: t('settings.apiKeys.create'),
      message: t('settings.apiKeys.createMessage'),
      label: t('settings.apiKeys.nameOptional'),
      placeholder: t('settings.apiKeys.namePlaceholder'),
      primaryText: t('settings.apiKeys.create'),
    });
    if (name === null) return;
    const errorEl = document.getElementById('api-key-error');
    const createdEl = document.getElementById('api-key-created');
    const valueEl = document.getElementById('api-key-value');
    if (errorEl) errorEl.textContent = '';
    try {
      const data = await withMfaRetry(() => authApi.createApiKey(name || undefined));
      if (valueEl) valueEl.textContent = data.key;
      if (createdEl) createdEl.style.display = 'block';
      await loadApiKeys();
    } catch (e) {
      console.error('API key creation failed:', e);
      if (errorEl) errorEl.textContent = e.message;
    }
  }

  async function revokeApiKey(keyId) {
    const confirmed = await confirmSecurityAction({
      title: t('settings.apiKeys.revokeTitle'),
      message: t('settings.apiKeys.revokeMessage'),
      confirmText: t('settings.apiKeys.revokeConfirm'),
      danger: true,
    });
    if (!confirmed) return;
    const errorEl = document.getElementById('api-key-error');
    if (errorEl) errorEl.textContent = '';
    try {
      await withMfaRetry(() => authApi.revokeApiKey(keyId));
      await loadApiKeys();
    } catch (e) {
      console.error('API key revoke failed:', e);
      if (errorEl) errorEl.textContent = e.message;
    }
  }

  function showCopyStatus(message, isError = false) {
    const statusEl = document.getElementById('api-key-copy-status');
    if (!statusEl) return;
    statusEl.style.color = isError ? 'var(--danger)' : 'var(--success)';
    statusEl.textContent = message;
  }

  function copyApiKey() {
    const valueEl = document.getElementById('api-key-value');
    if (!valueEl || !valueEl.textContent) return;
    navigator.clipboard.writeText(valueEl.textContent).then(() => {
      showCopyStatus(t('settings.apiKeys.copied'));
    }).catch(err => {
      console.error('Copy failed:', err);
      try {
        const range = document.createRange();
        range.selectNode(valueEl);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        document.execCommand('copy');
        window.getSelection().removeAllRanges();
        showCopyStatus(t('settings.apiKeys.copied'));
      } catch (fallbackErr) {
        console.error('Fallback copy failed:', fallbackErr);
        showCopyStatus(t('settings.apiKeys.copyFailed'), true);
      }
    });
  }

  window.addEventListener('nia-language-change', () => {
    if (hasLoadedApiKeys) renderApiKeys(lastApiKeys);
  });

  return { resetApiKeyUi, loadApiKeys, renderApiKeys, createApiKey, revokeApiKey, copyApiKey };
}

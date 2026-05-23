import { RUNTIME_CAPABILITIES } from '../core/config.js';
import { iconSvg } from '../icons/lucide-icons.js';

export function createApiKeysFeature({ authApi }) {
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
    return date ? date.toLocaleString('de-DE') : String(value || '');
  }

  function resetApiKeyUi() {
    const createdEl = document.getElementById('api-key-created');
    const valueEl = document.getElementById('api-key-value');
    const errorEl = document.getElementById('api-key-error');
    if (createdEl) createdEl.style.display = 'none';
    if (valueEl) valueEl.textContent = '';
    if (errorEl) errorEl.textContent = '';
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
    const listEl = document.getElementById('api-keys-list');
    if (!listEl) return;
    listEl.textContent = '';

    if (!keys.length) {
      const p = document.createElement('p');
      p.style.cssText = 'font-size:13px; color:var(--text-muted);';
      p.textContent = 'Keine API-Keys vorhanden.';
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
        span.innerHTML = `(${iconSvg('ban')} widerrufen)`;
        nameRow.appendChild(span);
      }

      const keyRow = document.createElement('div');
      keyRow.style.cssText = 'font-size:12px; color:var(--text-muted); font-family:monospace;';
      keyRow.textContent = k.key_prefix + '****';

      const usedRow = document.createElement('div');
      usedRow.style.cssText = 'margin-top:4px; font-size:11px; color:var(--text-muted);';
      usedRow.textContent = k.last_used_at
        ? 'Letzter Zugriff: ' + formatServerTimestamp(k.last_used_at)
        : 'Noch nicht verwendet';

      left.appendChild(nameRow);
      left.appendChild(keyRow);
      left.appendChild(usedRow);
      container.appendChild(left);

      if (!revoked) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-danger';
        btn.style.cssText = 'font-size:12px; padding:4px 8px; flex-shrink:0; margin-left:8px;';
        btn.title = 'Widerrufen';
        btn.innerHTML = iconSvg('trash-2');
        btn.onclick = () => revokeApiKey(k.id);
        container.appendChild(btn);
      }

      listEl.appendChild(container);
    });
  }

  async function ensureRecentMfaForApiKeyAction() {
    const state = await authApi.twoFactorStatus().catch(() => ({}));
    if (!state.enabled && !state.required) return;
    if (state.has_passkey && !RUNTIME_CAPABILITIES.native && window.PublicKeyCredential && navigator.credentials && confirm('Für diese API-Key-Aktion ist frische 2FA nötig. Mit Passkey reauthentifizieren?')) {
      const data = await authApi.reauthPasskey();
      if (data.access_token) localStorage.setItem('jwt_token', data.access_token);
      return;
    }
    const code = prompt('2FA-Code für diese API-Key-Aktion eingeben');
    if (!code) throw new Error('2FA/Reauth abgebrochen');
    const data = await authApi.reauth(code.includes('-') ? 'recovery_code' : 'totp', code.trim());
    if (data.access_token) localStorage.setItem('jwt_token', data.access_token);
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
    const name = prompt('Name für den API-Key (optional):');
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
    if (!confirm('API-Key wirklich widerrufen?')) return;
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

  function copyApiKey() {
    const valueEl = document.getElementById('api-key-value');
    if (!valueEl || !valueEl.textContent) return;
    navigator.clipboard.writeText(valueEl.textContent).then(() => {
      alert('API-Key kopiert!');
    }).catch(err => {
      console.error('Copy failed:', err);
      const range = document.createRange();
      range.selectNode(valueEl);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      document.execCommand('copy');
      window.getSelection().removeAllRanges();
      alert('API-Key kopiert!');
    });
  }

  return { resetApiKeyUi, loadApiKeys, renderApiKeys, createApiKey, revokeApiKey, copyApiKey };
}

(function() {
      const data = document.getElementById('oidc-completion-data')?.dataset || {};
      const payload = JSON.parse(data.payload || '{}');
      const kind = data.kind || 'error';
      const redirectTo = data.redirectTo || '/';
      async function clearPreviousUserData(newUserId) {
        let previousUserId = localStorage.getItem('last_user_id');
        if (!previousUserId) {
          try {
            previousUserId = String(JSON.parse(localStorage.getItem('cached_user') || 'null')?.id || '');
          } catch (_error) {
            previousUserId = '';
          }
        }
        const hasPreviousSession = Boolean(previousUserId || localStorage.getItem('jwt_token') || localStorage.getItem('auth_token'));
        if (!hasPreviousSession || previousUserId === newUserId) return;
        if ('serviceWorker' in navigator && typeof navigator.serviceWorker.getRegistrations === 'function') {
          const registrations = await navigator.serviceWorker.getRegistrations();
          registrations.forEach(registration => registration.active?.postMessage({ action: 'clearAuthCaches' }));
        }
        if ('caches' in globalThis) {
          const names = await caches.keys();
          await Promise.all(names.filter(name => name.startsWith('nia-todo-api-')).map(name => caches.delete(name)));
        }
        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase('nia-todo-db');
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error || new Error('Failed to clear local database'));
          request.onblocked = () => reject(new Error('Local database cleanup was blocked'));
        });
      }
      if (kind === 'user') {
        void (async () => {
          try {
            const newUserId = String(payload.user?.id || '');
            if (!newUserId) throw new Error('OIDC response did not include a user identity');
            await clearPreviousUserData(newUserId);
            localStorage.setItem('jwt_token', payload.access_token);
            if (payload.csrf_token) localStorage.setItem('csrf_token', payload.csrf_token);
            localStorage.setItem('cached_user', JSON.stringify(payload.user));
            localStorage.setItem('last_user_id', newUserId);
            location.replace(redirectTo);
          } catch (error) {
            localStorage.removeItem('jwt_token');
            localStorage.removeItem('auth_token');
            localStorage.removeItem('csrf_token');
            localStorage.removeItem('cached_user');
            const message = document.getElementById('message');
            if (message) message.textContent = 'Local privacy cleanup failed. Sign-in was not completed.';
            document.title = 'OIDC sign-in failed';
            console.error('OIDC identity cleanup failed:', error);
          }
        })();
        return;
      }
      if (kind === 'admin') {
        localStorage.setItem('admin_jwt_token', payload.access_token);
        if (payload.csrf_token) localStorage.setItem('csrf_token', payload.csrf_token);
        location.replace('/admin');
        return;
      }
      if (kind === 'admin_link') {
        sessionStorage.setItem('nia_admin_oidc_link_result', JSON.stringify(payload));
        location.replace('/admin');
        return;
      }
      if (kind === 'error') {
        sessionStorage.setItem('nia_oidc_error', JSON.stringify({ error_key: payload.error_key || 'auth.oidc.errorMessage', error: payload.error || '', kind: payload.kind || 'user' }));
        location.replace(redirectTo);
        return;
      }
      const fallbackLanguage = 'en';
      function normalizeLanguage(value) {
        const raw = String(value || '').trim();
        const lower = raw.toLowerCase();
        if (lower === 'zh-cn' || lower === 'zh-hans' || lower.startsWith('zh-hans-')) return 'zh-CN';
        if (lower === 'pt-br' || lower.startsWith('pt-br-')) return 'pt-BR';
        const base = lower.split('-')[0];
        if (base === 'zh') return 'zh-CN';
        if (base === 'pt') return 'pt-BR';
        return base || fallbackLanguage;
      }
      async function loadMessages() {
        const candidates = [];
        const seen = new Set();
        for (const language of (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language])) {
          const normalized = normalizeLanguage(language);
          if (!seen.has(normalized)) { seen.add(normalized); candidates.push(normalized); }
        }
        if (!seen.has(fallbackLanguage)) candidates.push(fallbackLanguage);
        for (const language of candidates) {
          try {
            const response = await fetch('/static/i18n/' + encodeURIComponent(language) + '.json', { cache: 'no-store' });
            if (!response.ok) continue;
            return { language, messages: await response.json() };
          } catch (error) {}
        }
        return { language: fallbackLanguage, messages: {} };
      }
      loadMessages().then(({ language, messages }) => {
        document.documentElement.lang = language;
        const message = document.getElementById('message');
        const fallback = payload.error || messages['auth.oidc.failedFallback'] || 'OIDC failed';
        message.textContent = fallback;
        document.title = messages['auth.oidc.errorTitle'] || 'OIDC sign-in failed';
      });
    })();

(function() {
      const data = document.getElementById('oidc-completion-data')?.dataset || {};
      const payload = JSON.parse(data.payload || '{}');
      const kind = data.kind || 'error';
      const redirectTo = data.redirectTo || '/';
      if (kind === 'user') {
        localStorage.setItem('jwt_token', payload.access_token);
        if (payload.csrf_token) localStorage.setItem('csrf_token', payload.csrf_token);
        if (payload.user) {
          localStorage.setItem('cached_user', JSON.stringify(payload.user));
          localStorage.setItem('last_user_id', String(payload.user.id));
        }
        location.replace(redirectTo);
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

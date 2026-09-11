(function() {
      const callbackUrl = document.getElementById('oidc-native-return-data')?.dataset.callbackUrl || '/';
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
      function languageCandidates() {
        const seen = new Set();
        const result = [];
        for (const language of (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language])) {
          const normalized = normalizeLanguage(language);
          if (!seen.has(normalized)) {
            seen.add(normalized);
            result.push(normalized);
          }
        }
        if (!seen.has(fallbackLanguage)) result.push(fallbackLanguage);
        return result;
      }
      async function loadMessages() {
        for (const language of languageCandidates()) {
          try {
            const response = await fetch('/static/i18n/' + encodeURIComponent(language) + '.json', { cache: 'no-store' });
            if (!response.ok) continue;
            return { language, messages: await response.json() };
          } catch (error) {}
        }
        return { language: fallbackLanguage, messages: {} };
      }
      function applyMessages(language, messages) {
        document.documentElement.lang = language;
        document.querySelectorAll('[data-i18n-key]').forEach((el) => {
          const key = el.getAttribute('data-i18n-key');
          if (typeof messages[key] === 'string') el.textContent = messages[key];
        });
        if (typeof messages['auth.oidc.return.title'] === 'string') document.title = messages['auth.oidc.return.title'];
      }
      window.addEventListener('load', async () => {
        const { language, messages } = await loadMessages();
        applyMessages(language, messages);
        setTimeout(() => { window.location.href = callbackUrl; }, 900);
      });
    })();

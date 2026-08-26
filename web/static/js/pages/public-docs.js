(() => {
      const ICONS = {
        sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
        moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
        monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
      };
      document.querySelectorAll('[data-icon]').forEach((el) => {
        const name = el.getAttribute('data-icon');
        if (!ICONS[name]) return;
        el.innerHTML = `<svg class="ui-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
      });
      const root = document.documentElement;
      const buttons = Array.from(document.querySelectorAll('[data-theme]'));
      function setTheme(mode) {
        try { localStorage.setItem('nia-docs-theme', mode); } catch {}
        root.removeAttribute('data-theme');
        if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
        buttons.forEach(btn => btn.classList.toggle('active', btn.dataset.theme === mode));
      }
      let saved = 'system';
      try { saved = localStorage.getItem('nia-docs-theme') || 'system'; } catch {}
      setTheme(saved);
      buttons.forEach(btn => btn.addEventListener('click', () => setTheme(btn.dataset.theme)));

      const tocPanel = document.querySelector('nav.toc-panel');
      const tocToggle = document.querySelector('.toc-toggle');
      tocToggle?.addEventListener('click', () => {
        const open = !tocPanel?.classList.contains('toc-open');
        tocPanel?.classList.toggle('toc-open', open);
        tocToggle.setAttribute('aria-expanded', String(open));
      });

      const search = document.getElementById('api-search');
      const clear = document.getElementById('api-search-clear');
      const status = document.getElementById('search-status');
      const blocks = Array.from(document.querySelectorAll('main > *')).map((el) => ({ el, html: el.innerHTML, text: el.textContent || '' }));
      const tocLinks = Array.from(document.querySelectorAll('nav a'));
      function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
      function highlightTextNodes(element, rawQuery) {
        const rx = new RegExp(escapeRegExp(rawQuery), 'gi');
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(rawQuery.toLowerCase())) return NodeFilter.FILTER_REJECT;
            if (node.parentElement?.closest('script, style, code, pre, mark')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        });
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach((node) => {
          const fragment = document.createDocumentFragment();
          let lastIndex = 0;
          const text = node.nodeValue;
          text.replace(rx, (match, offset) => {
            if (offset > lastIndex) fragment.appendChild(document.createTextNode(text.slice(lastIndex, offset)));
            const mark = document.createElement('mark');
            mark.textContent = match;
            fragment.appendChild(mark);
            lastIndex = offset + match.length;
            return match;
          });
          if (lastIndex < text.length) fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
          node.parentNode?.replaceChild(fragment, node);
        });
      }
      function runSearch() {
        const rawQuery = search.value.trim();
        const query = rawQuery.toLowerCase();
        const visible = new Set();
        let matches = 0;
        blocks.forEach((block, index) => {
          block.el.classList.remove('hidden-by-search');
          block.el.innerHTML = block.html;
          if (!query) {
            visible.add(index);
            return;
          }
          const hit = block.text.toLowerCase().includes(query);
          if (!hit) return;
          matches++;
          visible.add(index);
          for (let cursor = index - 1; cursor >= 0; cursor--) {
            const tag = blocks[cursor].el.tagName;
            if (/^H[1-4]$/.test(tag)) visible.add(cursor);
            if (tag === 'H2') break;
          }
        });
        blocks.forEach((block, index) => {
          const show = !query || visible.has(index);
          block.el.classList.toggle('hidden-by-search', !show);
          if (show && query && block.text.toLowerCase().includes(query)) {
            highlightTextNodes(block.el, rawQuery);
          }
        });
        tocLinks.forEach((link) => {
          const href = link.getAttribute('href') || '';
          const target = href.startsWith('#') ? document.getElementById(decodeURIComponent(href.slice(1))) : null;
          link.classList.toggle('hidden-by-search', Boolean(query) && target?.classList.contains('hidden-by-search'));
        });
        status.textContent = query ? `${matches} results for “${search.value.trim()}”` : '';
      }
      search.addEventListener('input', runSearch);
      clear.addEventListener('click', () => { search.value = ''; search.focus(); runSearch(); });
    })();

import { getActiveLanguage, t as i18nT } from '../i18n/index.js';

export function escapeHtml(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

export function escapeHtmlAttr(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function jsArg(value) {
  return JSON.stringify(value);
}

export function formatDate(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const isToday = date.toDateString() === today.toDateString();
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const locale = getActiveLanguage() === 'en' ? 'en-US' : 'de-DE';
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

  if (isToday) return i18nT('date.todayAt', { time });
  if (isTomorrow) return i18nT('date.tomorrowAt', { time });
  return `${date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' })} ${time}`;
}


export function truncateWords(str, maxWords) {
  const words = str.trim().split(/\s+/);
  if (words.length <= maxWords) return str;
  return words.slice(0, maxWords).join(' ') + '...';
}

function renderInlineMarkdown(text) {
  const source = String(text ?? '');
  const tokenPattern = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let html = '';
  let lastIndex = 0;

  for (const match of source.matchAll(tokenPattern)) {
    html += escapeHtml(source.slice(lastIndex, match.index));

    if (match[2] != null) {
      html += `<code>${escapeHtml(match[2])}</code>`;
    } else if (match[4] != null) {
      html += `<strong>${escapeHtml(match[4])}</strong>`;
    } else if (match[6] != null) {
      html += `<em>${escapeHtml(match[6])}</em>`;
    } else if (match[8] != null && match[9] != null) {
      try {
        const url = new URL(match[9]);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          html += `<a href="${escapeHtmlAttr(url.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(match[8])}</a>`;
        } else {
          html += escapeHtml(match[0]);
        }
      } catch {
        html += escapeHtml(match[0]);
      }
    } else {
      html += escapeHtml(match[0]);
    }

    lastIndex = match.index + match[0].length;
  }

  html += escapeHtml(source.slice(lastIndex));
  return html;
}

export function renderMarkdown(text) {
  if (!text) return '';
  return String(text)
    .split('\n')
    .map(line => line.startsWith('- ') ? `• ${renderInlineMarkdown(line.slice(2))}` : renderInlineMarkdown(line))
    .join('<br>');
}

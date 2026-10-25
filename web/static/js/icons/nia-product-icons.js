let nextGradientId = 1;

const ICONS = {
  nia: gradientId => `
    <path d="M19.75 45.625V18.375L44.25 45.625V18.375" fill="none" stroke="#fff" stroke-width="8.25" stroke-linecap="round" stroke-linejoin="round"/>
  `,
  tasks: gradientId => `
    <path d="m17.5 32.5 9 9L47 21" fill="none" stroke="#fff" stroke-width="8.5" stroke-linecap="round" stroke-linejoin="round"/>
  `,
  shopping: gradientId => `
    <path d="M18 25.5h28l-2.6 22.2A4 4 0 0 1 39.4 51H24.6a4 4 0 0 1-4-3.3L18 25.5Z" fill="#fff"/>
    <path d="M24.5 27v-3.5a7.5 7.5 0 0 1 15 0V27" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round"/>
    <path d="m26.5 38 3.6 3.6 7.4-8" fill="none" stroke="url(#${gradientId})" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>
  `,
  recipes: gradientId => `
    <path d="M14 20.5A4.5 4.5 0 0 1 18.5 16H30c3.2 0 5.8 1.2 8 3.2 2.2-2 4.8-3.2 8-3.2h.5A4.5 4.5 0 0 1 51 20.5v25a3.5 3.5 0 0 1-3.5 3.5H46c-3.7 0-7.2 1.1-10 3.1-2.8-2-6.3-3.1-10-3.1h-8.5a3.5 3.5 0 0 1-3.5-3.5v-25Z" fill="#fff"/>
    <path d="M32 21v25.5M38 19.5v26" fill="none" stroke="url(#${gradientId})" stroke-width="3.4" stroke-linecap="round"/>
    <path d="M20.5 27h6M20.5 34h6M41.5 27h4M41.5 34h4" fill="none" stroke="url(#${gradientId})" stroke-width="3.4" stroke-linecap="round"/>
  `,
};

export function niaIconSvg(icon, className = '') {
  const renderBody = ICONS[icon] || ICONS.nia;
  const gradientId = `nia-icon-gradient-${nextGradientId++}`;
  const classes = ['nia-product-icon', className].filter(Boolean).join(' ');
  return `<svg class="${classes}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="${gradientId}" x1="8" y1="6" x2="58" y2="60" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="var(--nia-icon-head)"/>
        <stop offset="0.52" stop-color="var(--nia-icon-mid)"/>
        <stop offset="1" stop-color="var(--nia-icon-tail)"/>
      </linearGradient>
    </defs>
    <circle cx="32" cy="32" r="30" fill="url(#${gradientId})"/>
    ${renderBody(gradientId)}
  </svg>`;
}

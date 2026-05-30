// Lucide icon subset, vendored as SVG path data for offline/PWA use.
// Source style: https://lucide.dev (ISC). Icons render with currentColor.

import { t } from '../i18n/index.js';

export const ICONS = {
  'layout-dashboard': '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  'circle': '<circle cx="12" cy="12" r="10"/>',
  'mic': '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
  'sparkles': '<path d="M9.94 14.66 9 18l-.94-3.34a2 2 0 0 0-1.4-1.4L3.32 12l3.34-.94a2 2 0 0 0 1.4-1.4L9 6.32l.94 3.34a2 2 0 0 0 1.4 1.4l3.34.94-3.34.94a2 2 0 0 0-1.4 1.4Z"/><path d="M18 8.5 17.5 10l-.5-1.5a1 1 0 0 0-.7-.7L14.8 7.3l1.5-.5a1 1 0 0 0 .7-.7L17.5 4l.5 2.1a1 1 0 0 0 .7.7l1.5.5-1.5.5a1 1 0 0 0-.7.7Z"/>',
  'target': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  'clock': '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  'flame': '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  'check': '<path d="M20 6 9 17l-5-5"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'check-circle': '<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/>',
  'plus': '<path d="M5 12h14"/><path d="M12 5v14"/>',
  'trash-2': '<path d="M3 6h18"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><path d="M19 6l-1 14c-.1 1-1 2-2 2H8c-1 0-1.9-1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  'calendar': '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  'calendar-days': '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/>',
  'chart-line': '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
  'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  'settings': '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  'monitor': '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  'moon': '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  'refresh-cw': '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
  'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  'edit-3': '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  'image': '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  'key-round': '<path d="M2 18v3h3l9.7-9.7"/><circle cx="16.5" cy="7.5" r="5.5"/>',
  'bell': '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8a6 6 0 0 0-12 0c0 4.499-1.411 5.956-2.738 7.326"/>',
  'smartphone': '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  'keyboard': '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
  'share-2': '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98"/><path d="m15.41 6.51-6.82 3.98"/>',
  'download': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  'clipboard': '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  'ban': '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  'folder': '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  'briefcase': '<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
  'home': '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  'code': '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  'server': '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  'shopping-cart': '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57L21.7 8H5.12"/>',
  'heart': '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/>',
  'star': '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.12 2.12 0 0 0 1.595 1.16l5.166.751a.53.53 0 0 1 .294.904l-3.736 3.642a2.12 2.12 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.12 2.12 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.771-.56l.882-5.14a2.12 2.12 0 0 0-.611-1.878L2.86 9.79a.53.53 0 0 1 .294-.904l5.166-.751a2.12 2.12 0 0 0 1.595-1.16z"/>',
  'users': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  'user-plus': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  'menu': '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
  'search': '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  'mail': '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  'inbox': '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  'lock-keyhole': '<circle cx="12" cy="16" r="1"/><rect x="3" y="10" width="18" height="12" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/>',
  'shield': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/>',
  'database': '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/>',
  'cloud': '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  'wifi': '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.86a10 10 0 0 1 14 0"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/>',
  'wrench': '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"/>',
  'rocket': '<path d="M4.5 16.5c-1.5 1.26-2 4-2 4s2.74-.5 4-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22 22 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  'car': '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9L18.7 6a2 2 0 0 0-1.9-1H7.2a2 2 0 0 0-1.9 1l-1.8 5.1C2.7 11.3 2 12.1 2 13v3c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M5 11h14"/>',
  'plane': '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 20.5 3S17.5 2.5 16 4l-3.5 3.5L4.3 5.7a1 1 0 0 0-1.1.3l-.4.4a1 1 0 0 0 .1 1.4l6.2 4.7-2.4 2.4-2-.4a1 1 0 0 0-.9.3l-.7.7a1 1 0 0 0 .3 1.6l2.2 1 1 2.2a1 1 0 0 0 1.6.3l.7-.7a1 1 0 0 0 .3-.9l-.4-2 2.4-2.4 4.7 6.2a1 1 0 0 0 1.4.1l.4-.4a1 1 0 0 0 .3-1.1z"/>',
  'book-open': '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  'laptop': '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9"/><path d="M2 16h20v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/>',
  'cpu': '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M9 2v2"/><path d="M9 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/>',
  'terminal': '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  'hammer': '<path d="m15 12-8.5 8.5a2.12 2.12 0 0 1-3-3L12 9"/><path d="m17 14 4-4"/><path d="m17 14-5-5"/><path d="m12 9 4-4"/><path d="m16 5 3 3"/>',
  'bug': '<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3 3 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.8 3.8-4"/><path d="M17.47 9C19.4 8.8 21 7.1 21 5"/><path d="M18 13h4"/><path d="M21 21c0-2.1-1.7-3.8-3.8-4"/>',
  'package': '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  'archive': '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  'tag': '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  'bookmark': '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  'flag': '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
  'map-pin': '<path d="M20 10c0 4.99-5.54 10.19-7.4 11.78a1 1 0 0 1-1.2 0C9.54 20.19 4 14.99 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
};

export const ICON_PICKER_CATEGORIES = [
  {
    labelKey: 'iconPicker.category.everyday',
    icons: ['home', 'inbox', 'shopping-cart', 'calendar', 'calendar-days', 'clock', 'bell', 'heart', 'star', 'users', 'user-plus', 'mail'],
  },
  {
    labelKey: 'iconPicker.category.workTech',
    icons: ['briefcase', 'folder', 'file-text', 'book-open', 'code', 'terminal', 'server', 'database', 'cloud', 'wifi', 'laptop', 'cpu', 'keyboard', 'smartphone'],
  },
  {
    labelKey: 'iconPicker.category.organization',
    icons: ['layout-dashboard', 'chart-line', 'tag', 'bookmark', 'flag', 'map-pin', 'archive', 'package', 'clipboard', 'download', 'share-2', 'image'],
  },
  {
    labelKey: 'iconPicker.category.statusSecurity',
    icons: ['check-circle', 'check', 'flame', 'triangle-alert', 'shield', 'lock-keyhole', 'key-round', 'ban', 'circle'],
  },
  {
    labelKey: 'iconPicker.category.toolsMovement',
    icons: ['settings', 'wrench', 'hammer', 'bug', 'rocket', 'car', 'plane'],
  },
  {
    labelKey: 'iconPicker.category.system',
    icons: ['sun', 'moon', 'monitor', 'search', 'menu', 'plus', 'edit-3', 'trash-2', 'refresh-cw', 'arrow-left', 'log-out', 'x'],
  },
];

export const ICON_PICKER = ICON_PICKER_CATEGORIES.flatMap(category => category.icons);

export function safeColor(value, fallback = '#6366f1') {
  const color = String(value || '').trim();
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) return fallback;
  if (color.length === 4) {
    return `#${color.slice(1).split('').map(ch => ch + ch).join('')}`.toLowerCase();
  }
  return color.toLowerCase();
}

export function safeIconName(name) {
  return Object.prototype.hasOwnProperty.call(ICONS, name) ? name : '';
}

export function iconSvg(name, className = 'ui-icon', attrs = '') {
  const paths = ICONS[safeIconName(name)] || ICONS.circle;
  return `<svg class="${className}" ${attrs} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    const icon = el.getAttribute('data-icon');
    const cls = el.getAttribute('data-icon-class') || 'ui-icon';
    el.innerHTML = iconSvg(icon, cls);
  });
}

export function markerHtml(item, dotClass = 'project-dot') {
  const color = safeColor(item?.color);
  const icon = safeIconName(item?.icon);
  if (icon) {
    return `<span class="entity-icon" style="color:${color}">${iconSvg(icon)}</span>`;
  }
  return `<span class="${dotClass}" style="background:${color}"></span>`;
}

function currentIconPreview(icon, color) {
  if (icon) return `<span class="icon-picker-current-preview" style="color:${color}">${iconSvg(icon)}</span>`;
  return `<span class="icon-picker-current-preview"><span class="icon-picker-dot" style="background:${color}"></span></span>`;
}

function currentIconLabel(icon) {
  return icon || t('iconPicker.none');
}

export function renderIconPicker({ container, input, selected = '', color = '#6366f1' }) {
  if (!container || !input) return;
  const safeSelected = safeIconName(selected);
  const safePickerColor = safeColor(color);
  input.value = safeSelected;
  container.innerHTML = `
    <button type="button" class="icon-picker-current" aria-expanded="false">
      ${currentIconPreview(safeSelected, safePickerColor)}
      <span class="icon-picker-current-text">
        <span class="icon-picker-current-label">${t('iconPicker.selected')}</span>
        <span class="icon-picker-current-name">${currentIconLabel(safeSelected)}</span>
      </span>
      <svg class="icon-picker-current-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="icon-picker-panel" hidden>
      <div class="icon-picker-toolbar">
        <input class="icon-picker-search" type="search" placeholder="${t('iconPicker.searchPlaceholder')}" aria-label="${t('iconPicker.searchAria')}">
      </div>
      <div class="icon-picker-sections">
        <section class="icon-picker-section" data-category="none">
          <div class="icon-picker-category-title">${t('iconPicker.noneCategory')}</div>
          <div class="icon-picker-grid">
            <button type="button" class="icon-picker-option ${!safeSelected ? 'active' : ''}" data-value="" data-search="${t('iconPicker.noneSearch')}" title="${t('iconPicker.none')}">
              <span class="icon-picker-dot" style="background:${safePickerColor}"></span>
            </button>
          </div>
        </section>
        ${ICON_PICKER_CATEGORIES.map(category => {
          const categoryLabel = t(category.labelKey);
          return `
          <section class="icon-picker-section" data-category="${category.labelKey}">
            <div class="icon-picker-category-title">${categoryLabel}</div>
            <div class="icon-picker-grid">
              ${category.icons.map(name => `
                <button type="button" class="icon-picker-option ${safeSelected === name ? 'active' : ''}" data-value="${name}" data-search="${name.replace(/-/g, ' ')} ${categoryLabel.toLowerCase()}" title="${name}" style="color:${safePickerColor}">
                  ${iconSvg(name)}
                </button>
              `).join('')}
            </div>
          </section>
        `;
        }).join('')}
      </div>
    </div>
  `;

  const currentButton = container.querySelector('.icon-picker-current');
  const currentName = container.querySelector('.icon-picker-current-name');
  const panel = container.querySelector('.icon-picker-panel');
  const search = container.querySelector('.icon-picker-search');
  const options = Array.from(container.querySelectorAll('.icon-picker-option'));

  function setExpanded(expanded) {
    panel.hidden = !expanded;
    currentButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function updateCurrent(value) {
    const icon = safeIconName(value);
    input.value = icon;
    const currentPreview = container.querySelector('.icon-picker-current-preview');
    if (currentPreview) currentPreview.outerHTML = currentIconPreview(icon, safePickerColor);
    if (currentName) currentName.textContent = currentIconLabel(icon);
    options.forEach(btn => btn.classList.toggle('active', (btn.dataset.value || '') === icon));
  }

  currentButton?.addEventListener('click', () => {
    const expanded = currentButton.getAttribute('aria-expanded') === 'true';
    setExpanded(!expanded);
    if (!expanded) search?.focus();
  });

  options.forEach((button) => {
    button.addEventListener('click', () => {
      updateCurrent(button.dataset.value || '');
      setExpanded(false);
    });
  });

  search?.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    container.querySelectorAll('.icon-picker-section').forEach((section) => {
      let visibleCount = 0;
      section.querySelectorAll('.icon-picker-option').forEach((button) => {
        const match = !query || (button.dataset.search || '').includes(query);
        button.hidden = !match;
        if (match) visibleCount += 1;
      });
      section.hidden = visibleCount === 0;
    });
  });
}

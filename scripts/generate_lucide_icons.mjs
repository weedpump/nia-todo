#!/usr/bin/env node
import * as lucide from 'lucide';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ICON_NAMES = [
  'activity',
  'archive',
  'arrow-left',
  'ban',
  'bell',
  'book-open',
  'bookmark',
  'briefcase',
  'brush-cleaning',
  'bug',
  'calendar',
  'calendar-days',
  'car',
  'chart-line',
  'check',
  'check-circle',
  'chevron-down',
  'chevron-left',
  'chevron-up',
  'circle',
  'clipboard',
  'clock',
  'cloud',
  'cloud-alert',
  'cloud-check',
  'code',
  'copy',
  'cpu',
  'database',
  'download',
  'download-cloud',
  'edit-3',
  'file',
  'file-image',
  'file-text',
  'file-type',
  'flag',
  'flame',
  'folder',
  'funnel',
  'hammer',
  'heart',
  'home',
  'image',
  'inbox',
  'key-round',
  'keyboard',
  'laptop',
  'layers',
  'layout-dashboard',
  'link',
  'list',
  'list-todo',
  'lock-keyhole',
  'log-out',
  'mail',
  'map-pin',
  'menu',
  'mic',
  'monitor',
  'moon',
  'notebook-pen',
  'package',
  'paperclip',
  'plane',
  'plus',
  'plus-square',
  'refresh-cw',
  'repeat',
  'rocket',
  'search',
  'server',
  'settings',
  'share-2',
  'shield',
  'shield-check',
  'shopping-cart',
  'smartphone',
  'sparkles',
  'star',
  'sun',
  'tag',
  'target',
  'terminal',
  'trash',
  'trash-2',
  'triangle-alert',
  'upload',
  'user',
  'user-plus',
  'users',
  'wifi',
  'wrench',
  'x',
];

const ICON_ALIASES = {
  'plus-square': 'square-plus',
  trash: 'trash-2',
};

function pascalCase(name) {
  const canonical = ICON_ALIASES[name] || name;
  return canonical.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

function attrsToString(attrs) {
  return Object.entries(attrs || {})
    .map(([key, value]) => ` ${key}=${JSON.stringify(String(value))}`)
    .join('');
}

function nodeToSvgPath(node) {
  const [tag, attrs] = node;
  return `<${tag}${attrsToString(attrs)}/>`;
}

const icons = {};
for (const name of ICON_NAMES) {
  const exportName = pascalCase(name);
  const iconNode = lucide[exportName];
  if (!iconNode) throw new Error(`Lucide export not found for ${name} (${exportName})`);
  icons[name] = iconNode.map(nodeToSvgPath).join('');
}

const sourceVersion = require('lucide/package.json').version;
const output = `// Generated from the lucide npm package. Do not edit by hand.\n// Run: npm run generate:icons\n// lucide version: ${sourceVersion}\n\nexport const LUCIDE_VERSION = ${JSON.stringify(sourceVersion)};\n\nexport const ICONS = ${JSON.stringify(icons, null, 2)};\n`;

writeFileSync('web/static/js/icons/lucide-generated.js', output);
console.log(`Generated ${Object.keys(icons).length} Lucide icons from lucide ${sourceVersion}`);

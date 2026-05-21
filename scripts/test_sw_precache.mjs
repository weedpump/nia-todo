#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { readdirSync, statSync, existsSync } from 'node:fs';

const webRoot = new URL('../web/', import.meta.url);
const swPath = new URL('../web/sw.js', import.meta.url);
const swSource = readFileSync(swPath, 'utf8');

function walk(dirUrl) {
  const dirPath = dirUrl.pathname;
  const entries = [];
  for (const name of readdirSync(dirPath)) {
    const child = new URL(name, dirUrl);
    const childPath = child.pathname;
    const stat = statSync(childPath);
    if (stat.isDirectory()) entries.push(...walk(new URL(`${name}/`, dirUrl)));
    else entries.push(childPath);
  }
  return entries;
}

const precacheBlockMatch = swSource.match(/const PRECACHE_ASSETS = \[([\s\S]*?)\];/);
if (!precacheBlockMatch) {
  throw new Error('PRECACHE_ASSETS block not found in web/sw.js');
}

const precacheAssets = new Set(
  [...precacheBlockMatch[1].matchAll(/'([^']+)'/g)].map(match => match[1])
);

const jsModules = walk(new URL('static/js/', webRoot))
  .filter(path => path.endsWith('.js'))
  .map(path => `/${relative(webRoot.pathname, path)}`)
  .sort();

const requiredStaticAssets = [
  '/',
  '/index.html',
  '/manifest.json',
  '/static/style.css',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
];

const missingJs = jsModules.filter(asset => !precacheAssets.has(asset));
const missingRequired = requiredStaticAssets.filter(asset => !precacheAssets.has(asset));
const staleAssets = [...precacheAssets]
  .filter(asset => asset !== '/')
  .filter(asset => !existsSync(new URL(asset.replace(/^\//, ''), webRoot).pathname))
  .sort();

if (missingJs.length || missingRequired.length || staleAssets.length) {
  console.error('❌ Service worker precache validation failed');
  if (missingJs.length) console.error('\nMissing JS modules:\n' + missingJs.map(x => `  - ${x}`).join('\n'));
  if (missingRequired.length) console.error('\nMissing required assets:\n' + missingRequired.map(x => `  - ${x}`).join('\n'));
  if (staleAssets.length) console.error('\nStale/nonexistent assets:\n' + staleAssets.map(x => `  - ${x}`).join('\n'));
  process.exit(1);
}

console.log(`✅ Service worker precache includes all ${jsModules.length} JS modules and required app-shell assets`);

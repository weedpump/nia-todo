#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const readJson = relativePath => JSON.parse(read(relativePath));

const supportedLanguages = ['de', 'en', 'cs', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'es', 'zh-CN'];
const technicalLocaleBrandExceptions = new Set([
  'todo.attachments.downloadStarted',
]);

const manifest = readJson('web/manifest.json');
assert.equal(manifest.name, 'Nia', 'The installed PWA name must use the visible product name');
assert.equal(manifest.short_name, 'Nia', 'The compact PWA name must use the visible product name');
assert.equal(manifest.start_url, '/', 'The existing PWA identity boundary must remain stable');

const indexHtml = read('web/index.html');
assert.match(indexHtml, /<title>Nia<\/title>/, 'The main document title must use Nia');
assert.match(indexHtml, /class="login-title">Nia<\/div>/, 'The login surface must use Nia');
assert.match(indexHtml, /class="module-switcher-app-name">Nia<\/span>/, 'The authenticated shell must use Nia');
assert.doesNotMatch(indexHtml, /alt="nia-todo"/, 'Visible logo alternatives must use the new product name');

for (const page of ['web/setup.html', 'web/admin.html', 'web/set-password.html']) {
  const source = read(page);
  assert.match(source, /Nia/, `${page} must expose the visible Nia product name`);
}

for (const language of supportedLanguages) {
  const dictionary = readJson(`web/static/i18n/${language}.json`);
  for (const [key, value] of Object.entries(dictionary)) {
    if (typeof value !== 'string' || !/nia-todo/i.test(value)) continue;
    assert(
      technicalLocaleBrandExceptions.has(key),
      `${language}:${key} still exposes the old visible product name`,
    );
  }
}

const serviceWorker = read('web/sw.js');
assert.match(serviceWorker, /<title>Nia - Offline<\/title>/, 'The offline fallback title must use Nia');
assert.match(serviceWorker, /const CACHE_NAME = 'nia-todo-'/, 'The service-worker cache namespace must remain compatible');

const tauriConfig = readJson('src-tauri/tauri.conf.json');
assert.equal(tauriConfig.productName, 'nia-todo', 'The native packaging identity must remain unchanged for now');
assert.equal(tauriConfig.identifier, 'de.tobiaskneidl.nia-todo', 'The Tauri identifier must remain unchanged');
assert.equal(tauriConfig.app.windows[0].title, 'Nia', 'The native window title must use Nia');

const androidGradle = read('src-tauri/gen/android/app/build.gradle.kts');
assert.match(androidGradle, /namespace = "de\.tobiaskneidl\.nia_todo"/);
assert.match(androidGradle, /applicationId = "de\.tobiaskneidl\.nia_todo"/);
const androidStrings = read('src-tauri/gen/android/app/src/main/res/values/strings.xml');
assert.match(androidStrings, /<string name="app_name">Nia<\/string>/);
assert.match(androidStrings, /<string name="main_activity_title">Nia<\/string>/);

const androidManifest = read('src-tauri/gen/android/app/src/main/AndroidManifest.xml');
assert.match(androidManifest, /android:scheme="nia-todo"/, 'The existing native OIDC deep-link scheme must remain unchanged');

const linuxDesktop = read('src-tauri/linux/nia-todo-desktop.desktop');
assert.match(linuxDesktop, /^Name=Nia$/m, 'The Linux launcher must use the visible product name');
assert.match(linuxDesktop, /^StartupWMClass=nia-todo-desktop$/m, 'The existing Linux application identity must remain unchanged');
assert.match(linuxDesktop, /^MimeType=x-scheme-handler\/nia-todo;$/m, 'The existing Linux deep-link registration must remain unchanged');

const frontendConfig = read('web/static/js/core/config.js');
assert.match(frontendConfig, /DB_NAME = 'nia-todo-db'/, 'The existing IndexedDB name must remain unchanged');
const i18nSource = read('web/static/js/i18n/index.js');
assert.match(i18nSource, /LANGUAGE_STORAGE_KEY = 'nia-todo-language'/, 'The language preference storage key must remain unchanged');
const nativeSetupSource = read('web/static/js/main.js');
assert.match(nativeSetupSource, /instance\?\.app !== 'nia-todo'/, 'The server identity handshake must remain unchanged');

const oidcRouter = read('api/routers/oidc.py');
assert.match(oidcRouter, /NATIVE_OIDC_SCHEME = "nia-todo"/, 'The native OIDC scheme must remain unchanged');
assert.match(oidcRouter, /<title>Nia<\/title>/, 'Native OIDC return pages must use Nia');

const emailTemplates = read('api/services/email_templates.py');
assert.match(emailTemplates, /BRAND_NAME = "Nia"/, 'System emails must use the visible product name');
assert.match(emailTemplates, /LOGO_CID = "nia-todo-logo"/, 'The existing inline email asset identity must remain unchanged');
const emailConfig = read('api/services/email_config.py');
assert.match(emailConfig, /"mail_from_name": "Nia"/, 'Fresh email configuration must default to Nia');
assert.match(read('api/migrations/056_rebrand_default_mail_sender.sql'), /WHERE key = 'mail_from_name'[\s\S]*value = 'nia-todo'/, 'Existing untouched default sender names must migrate to Nia');

const rustSource = read('src-tauri/src/lib.rs');
assert.match(rustSource, /toggle_app: "Nia anzeigen\/verstecken"/);
assert.match(rustSource, /\.tooltip\("Nia"\)/);
assert.match(rustSource, /"--app-name", "Nia"/);
assert.match(rustSource, /join\("nia-todo"\)/, 'The existing native download directory must remain unchanged');

const polkitPolicy = read('src-tauri/linux/de.tobiaskneidl.nia-todo.desktop-update.policy');
assert.match(polkitPolicy, /<vendor>Nia<\/vendor>/);
assert.match(polkitPolicy, /<action id="de\.tobiaskneidl\.nia-todo\.desktop-update\.install">/, 'The Polkit action identity must remain unchanged');
assert.match(polkitPolicy, /\/usr\/lib\/nia-todo-desktop\//, 'The Debian updater path must remain unchanged');

console.log('✅ Visible Nia branding keeps existing technical identities stable');

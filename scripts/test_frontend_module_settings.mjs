#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const settingsSource = readFileSync(new URL('../web/static/js/features/user-settings.js', import.meta.url), 'utf8');
const visibilitySource = readFileSync(new URL('../web/static/js/modules/visibility.js', import.meta.url), 'utf8');
const utilsSource = readFileSync(new URL('../web/static/js/core/utils.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../web/static/js/app.js', import.meta.url), 'utf8');
const remotePreferencesBody = appSource.match(/onModulePreferencesUpdate: payload => \{([\s\S]*?)\n  \},/)[1];

const html = `<!doctype html><html><body>
  <div id="settings-module-list"></div>
  <div id="settings-modules-error"></div>
  <div id="settings-modules-success"></div>
  <script type="module">
    import { createUserSettingsFeature } from '/static/js/features/user-settings.js';
    import { updateCachedUserMetadata } from '/static/js/core/utils.js';
    let user = JSON.parse(localStorage.getItem('cached_user') || 'null') || { id: 1, username: 'tester', disabled_modules: ['future-module'] };
    localStorage.setItem('cached_user',JSON.stringify(user));
    const updates = [];
    let preferenceChanges = 0;
    let holdNextUpdate = false;
    let releaseHeldUpdate = null;
    const feature = createUserSettingsFeature({
      authApi: {
        updateModules: async disabledModules => {
          updates.push([...disabledModules]);
          if (holdNextUpdate) {
            holdNextUpdate = false;
            await new Promise(resolve => { releaseHeldUpdate = resolve; });
          }
          return { disabled_modules: [...disabledModules] };
        },
      },
      placesApi: null,
      getCurrentUser: () => user,
      setCurrentUser: next => { user = next; },
      onModulePreferencesChange: () => { preferenceChanges += 1; },
      resetApiKeyUi: () => {},
      loadApiKeys: () => {},
      updatePushSettingsUI: () => {},
      logout: () => {},
    });
    feature.renderUserInfo();
    feature.bindUserSettingsActions();
    window.moduleSettingsTest = {
      getState: () => ({ user, updates, preferenceChanges }),
      holdNext: () => { holdNextUpdate = true; },
      release: () => releaseHeldUpdate?.(),
      replaceUser: next => { user=next;localStorage.setItem('cached_user',JSON.stringify(next));feature.renderUserInfo(); },
      applyRemote: payload => {
        let currentUser=user;
        const moduleShell={applyModulePreferences:()=>{preferenceChanges++;}},moduleSwitcher=null,recipeShoppingTransferFeature=null;
        const renderCookbooks=()=>{},renderUserInfo=()=>{};
        ${remotePreferencesBody}
        user=currentUser;feature.renderUserInfo();
      },
      updateCachedUserMetadata,
    };
  </script>
</body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('http://nia.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const stubs = {
      '/static/js/features/user-settings.js': settingsSource,
      '/static/js/modules/visibility.js': visibilitySource,
      '/static/js/core/utils.js': utilsSource,
      '/static/js/core/config.js': "export const RUNTIME_CAPABILITIES = {}; export const apiResourceUrl = value => value;",
      '/static/js/core/authenticated-image.js': "export const loadAuthenticatedImage=()=>{}; export const releaseAuthenticatedImage=()=>{}; export const removeCachedAvatar=async()=>{};",
      '/static/js/i18n/index.js': "export const getLanguagePreference=()=> 'auto'; export const setLanguagePreference=()=>{}; export const adoptServerLanguagePreference=async()=>{}; export const getActiveLanguage=()=> 'de'; export const getActiveLocale=()=> 'de-DE'; export const t=key=>key; export const translatePage=()=>{};",
      '/static/js/core/device-labels.js': "export const cleanSessionUserAgent=()=>''; export const sessionDeviceName=()=>'';",
      '/static/js/icons/lucide-icons.js': "export const iconSvg=()=>'';",
      '/static/js/icons/nia-product-icons.js': "export const niaIconSvg=id=>id;",
      '/static/js/modules/registry.js': "export const MODULES=[{id:'tasks',labelKey:'module.tasks.label',descriptionKey:'module.tasks.description',icon:'tasks'},{id:'shopping',labelKey:'module.shopping.label',descriptionKey:'module.shopping.description',icon:'shopping'},{id:'recipes',labelKey:'module.recipes.label',descriptionKey:'module.recipes.description',icon:'recipes'}];",
      '/static/js/ui/dropdowns.js': "export const hydrateSelect=()=>{}; export const refreshSelect=()=>{};",
      '/static/vendor/qrcode-generator.js': "export default function(){ return {}; }",
      '/static/js/features/security-dialogs.js': "export const confirmSecurityAction=async()=>true; export const performMfaReauth=async()=>true; export const promptSecurityPassword=async()=>''; export const promptSecurityText=async()=>'';",
      '/static/js/features/ui-history.js': "export const openUiLayer=()=>{}; export const registerUiLayer=()=>{}; export const requestCloseUiLayer=()=>false;",
    };
    if (Object.hasOwn(stubs, pathname)) {
      await route.fulfill({ contentType: 'text/javascript', body: stubs[pathname] });
      return;
    }
    await route.fulfill({ contentType: 'text/html', body: html });
  });
  await page.goto('http://nia.test/');
  await page.waitForFunction(() => Boolean(window.moduleSettingsTest));

  assert.equal(await page.locator('[data-user-settings-module-id="tasks"]').isChecked(), true);
  assert.equal(await page.locator('[data-user-settings-module-id="shopping"]').isChecked(), true);
  assert.equal(await page.locator('[data-user-settings-module-id="recipes"]').isChecked(), true);

  await page.click('[data-user-settings-module-id="shopping"]');
  await page.waitForFunction(() => window.moduleSettingsTest.getState().updates.length === 1);
  assert.deepEqual(
    await page.evaluate(() => window.moduleSettingsTest.getState()),
    {
      user: { id: 1, username: 'tester', disabled_modules: ['future-module', 'shopping'] },
      updates: [['future-module', 'shopping']],
      preferenceChanges: 1,
    },
  );
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('cached_user')).disabled_modules),['future-module','shopping'],'local settings responses update the offline user cache');

  await page.evaluate(() => window.moduleSettingsTest.holdNext());
  await page.click('[data-user-settings-module-id="recipes"]');
  await page.waitForFunction(() => window.moduleSettingsTest.getState().updates.length === 2);
  assert.equal(await page.locator('[data-user-settings-module-id]:not(:disabled)').count(), 0);
  await page.evaluate(() => window.moduleSettingsTest.release());
  await page.waitForFunction(() => window.moduleSettingsTest.getState().preferenceChanges === 2);
  await page.click('[data-user-settings-module-id="tasks"]');
  assert.equal(await page.locator('[data-user-settings-module-id="tasks"]').isChecked(), true);
  assert.equal(await page.locator('#settings-modules-error').textContent(), 'settings.modules.oneRequired');
  assert.equal((await page.evaluate(() => window.moduleSettingsTest.getState().updates)).length, 2);
  await page.reload();await page.waitForFunction(()=>Boolean(window.moduleSettingsTest));
  assert.equal(await page.locator('[data-user-settings-module-id="shopping"]').isChecked(),false,'an offline-style reload uses the saved local module setting');
  assert.equal(await page.locator('[data-user-settings-module-id="recipes"]').isChecked(),false);
  await page.evaluate(()=>window.moduleSettingsTest.applyRemote({disabled_modules:['tasks']}));
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('cached_user')).disabled_modules),['tasks'],'the actual realtime callback updates the same offline cache');
  await page.reload();await page.waitForFunction(()=>Boolean(window.moduleSettingsTest));
  assert.equal(await page.locator('[data-user-settings-module-id="tasks"]').isChecked(),false,'a remote setting survives reload without a fresh user fetch');
  assert.equal(await page.locator('[data-user-settings-module-id="shopping"]').isChecked(),true);
  for (const switchSession of ['other-account','same-account-new-token']) {
    await page.evaluate(()=>{window.moduleSettingsTest.replaceUser({id:1,username:'tester',token:'old-session',disabled_modules:[]});window.moduleSettingsTest.holdNext();});
    await page.click('[data-user-settings-module-id="shopping"]');
    await page.waitForFunction(()=>document.querySelector('[data-user-settings-module-id="tasks"]').disabled);
    const next={id:switchSession==='other-account'?2:1,username:'next-session',token:'new-session',disabled_modules:['recipes']};
    await page.evaluate(next=>{window.moduleSettingsTest.replaceUser(next);window.moduleSettingsTest.release();},next);
    await page.waitForFunction(()=>!document.querySelector('[data-user-settings-module-id="shopping"]').disabled);
    assert.deepEqual(await page.evaluate(()=>window.moduleSettingsTest.getState().user),next,'a stale response cannot change another authenticated session');
    assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('cached_user'))),next,'a stale response cannot change another session cache');
  }
  assert.equal(await page.evaluate(()=>window.moduleSettingsTest.updateCachedUserMetadata(999,{disabled_modules:['tasks']})),false,'cache updates cannot overwrite another account');
  await page.evaluate(()=>window.moduleSettingsTest.updateCachedUserMetadata(1,{id:999,token:'do-not-persist',disabled_modules:['shopping']}));
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('cached_user'))),{id:1,username:'next-session',token:'new-session',disabled_modules:['shopping']},'metadata patches cannot change the account identity or persist an authentication token');
  assert.equal(await page.evaluate(()=>window.moduleSettingsTest.updateCachedUserMetadata(1,{disabled_modules:[]},{getItem:()=>{throw new Error('blocked storage');}})),false,'blocked optional storage never fails the preference update');
  await page.evaluate(()=>localStorage.setItem('cached_user','corrupt'));
  assert.equal(await page.evaluate(()=>window.moduleSettingsTest.updateCachedUserMetadata(1,{disabled_modules:['tasks']})),false,'a corrupt user cache remains optional');
} finally {
  await browser.close();
}

console.log('✅ Account module settings interaction passed');

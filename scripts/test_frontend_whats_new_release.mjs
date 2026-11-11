#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { ICONS } from '../web/static/js/icons/lucide-generated.js';

console.log('🆕 Running localized release-tour content and version-selection tests...');

const releases = JSON.parse(readFileSync(new URL('../web/static/content/whats-new.json', import.meta.url), 'utf8')).releases;
const rendererSource = readFileSync(new URL('../web/static/js/features/whats-new.js', import.meta.url), 'utf8');
const tourCss = readFileSync(new URL('../web/static/css/74-whats-new.css', import.meta.url), 'utf8');
assert.ok(ICONS['arrow-right'], 'the brand transition needs the registered Lucide arrow rather than a fallback icon');
const v4Version = '4.0.0';
const expectedLanguages = ['de', 'en', 'cs', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'es', 'zh-CN'];

assert.deepEqual(releases.map(release => release.version).sort(), ['3.3.0', v4Version], 'ship the V4 tour and preserve the historical 3.3.0 tour');
const release = releases.find(release => release.version === '3.3.0');
assert.equal(release.version, '3.3.0');
assert.equal(release.appVersions, undefined, 'the release tour must use only the canonical release version');
assert.equal(JSON.stringify(release).includes(['-', 'dev'].join('')), false, 'the pushed release-tour content must not contain development-version suffixes');
assert.equal(release.carryForward, true, 'the current release tour should remain available until completed');
assert.deepEqual(Object.keys(release.content).sort(), [...expectedLanguages].sort(), 'all twelve supported languages must be present');

for (const language of expectedLanguages) {
  const content = release.content[language];
  assert.equal(typeof content.title, 'string', `${language} title is required`);
  assert.ok(content.title.trim(), `${language} title must not be empty`);
  assert.equal(typeof content.intro, 'string', `${language} intro is required`);
  assert.ok(content.intro.trim(), `${language} intro must not be empty`);
  assert.equal(content.slides.length, 4, `${language} must contain the four 3.3.0 feature slides`);
  for (const [index, slide] of content.slides.entries()) {
    if (index === 2) {
      assert.equal(slide.media?.type, 'icons', `${language} Today/Calm slide must show both controls`);
      assert.deepEqual(slide.media?.icons, ['calendar-days', 'leaf'], `${language} Today/Calm slide must use the current Today and Calm icons`);
    } else {
      assert.equal(slide.media?.type, 'icon', `${language} slide ${index + 1} must use a local icon`);
      assert.ok(slide.media?.icon, `${language} slide ${index + 1} icon is required`);
    }
    assert.ok(slide.title?.trim(), `${language} slide ${index + 1} title is required`);
    assert.ok(slide.body?.trim(), `${language} slide ${index + 1} body is required`);
    assert.equal(slide.bullets?.length, 3, `${language} slide ${index + 1} must contain three highlights`);
    assert.ok(slide.bullets.every((bullet) => typeof bullet === 'string' && bullet.trim()), `${language} slide ${index + 1} bullets must be complete`);
  }
}

assert.deepEqual(
  release.content.en.slides.map((slide) => slide.media.icon || slide.media.icons),
  ['layout-dashboard', 'chart-no-axes-column', ['calendar-days', 'leaf'], 'list-todo'],
  'the tour must cover dashboard personalization, drilldowns, focus/minimal, and multi-Todo creation',
);
assert.match(rendererSource, /media\.type === 'icons'/, 'the tour renderer must support paired local icons');
assert.match(tourCss, /\.whats-new-slide-media-icons/, 'paired Today and Calm icons need a dedicated layout');

const v4 = releases.find(release => release.version === v4Version);
assert.equal(v4.carryForward, true);
assert.equal(v4.appVersions, undefined, 'V4 content uses the canonical release identity');
assert.deepEqual(Object.keys(v4.content).sort(), [...expectedLanguages].sort());
const v4Icons = ['users', 'shopping-cart', 'book-open', 'download', 'sparkles'];
for (const language of expectedLanguages) {
  const content = v4.content[language];
  assert.ok(content.title?.trim() && content.intro?.trim(), `${language} V4 introduction must be complete`);
  assert.match(content.title, /4\.0/, `${language} V4 title must match the 4.0 release`);
  assert.equal(content.slides.length, 6, `${language} covers all six V4 topics`);
  assert.equal(content.slides[0].media.type, 'brand-transition');
  assert.match(content.slides[0].title, /nia-todo.*Nia/, `${language} explains the product rename`);
  assert.deepEqual(content.slides.slice(1).map(slide => slide.media?.icon), v4Icons, `${language} uses the same V4 topics`);
  assert.ok(!JSON.stringify(content.slides.slice(1)).includes('nia-todo'), `${language} remaining V4 topics use the visible Nia brand`);
  if (language !== 'en') assert.notDeepEqual(content, v4.content.en, `${language} must contain a translated tour`);
  for (const [index, slide] of content.slides.entries()) {
    if (index > 0) {
      assert.equal(slide.media.type, 'icon');
      assert.ok(ICONS[slide.media.icon], `V4 icon ${slide.media.icon} must exist in the icon registry`);
    }
    assert.ok(slide.title?.trim() && slide.body?.trim());
    assert.equal(slide.bullets.length, 3);
    assert.ok(slide.bullets.every(value => typeof value === 'string' && value.trim()));
  }
}

const browser = await chromium.launch({ headless: true });
async function withTour({ appVersion, content = releases, language = 'en', userId = 1, seen = [] }, run) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.route('http://release-tour.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/static/style.css">
        </head><body><script type="module">
        import { createWhatsNewFeature } from '/static/js/features/whats-new.js';
        import { setLanguagePreference } from '/static/js/i18n/index.js';
        import { bindUiHistory } from '/static/js/features/ui-history.js';
        import { ACCENT_PRESETS, setAccentPreset, setAccentIntensity, setTheme } from '/static/js/features/theme.js';
        window.tourTest={createWhatsNewFeature,setLanguagePreference,bindUiHistory,
          ACCENT_PRESETS,setAccentPreset,setAccentIntensity,setTheme};
        </script></body></html>` });
      if (path === '/static/content/whats-new.json') return route.fulfill({ json: { releases: content } });
      if (!path.startsWith('/static/')) return route.fulfill({ status: 404 });
      const extension = path.split('.').at(-1);
      const type = { js: 'text/javascript', css: 'text/css', json: 'application/json', woff2: 'font/woff2', svg: 'image/svg+xml', png: 'image/png' }[extension] || 'application/octet-stream';
      try { return route.fulfill({ contentType: type, body: readFileSync(new URL(`../web${path}`, import.meta.url)) }); }
      catch { return route.fulfill({ status: 404 }); }
    });
    await page.goto('http://release-tour.test/');
    await page.waitForFunction(() => Boolean(window.tourTest));
    await page.evaluate(async ({ appVersion, language, userId, seen }) => {
      localStorage.clear();
      await window.tourTest.setLanguagePreference(language);
      for (const [id, version] of seen) localStorage.setItem(`nia-whats-new:${id}:${version}`, '1');
      window.tourUser = { id: userId };
      window.tourTest.bindUiHistory();
      window.tour = window.tourTest.createWhatsNewFeature({ appVersion, getCurrentUser: () => window.tourUser });
      window.tour.bindWhatsNewActions();
    }, { appVersion, language, userId, seen });
    await run(page);
  } finally { await page.close(); }
}
const shownVersion = async (page, force = false) => page.evaluate(async force => {
  const shown = await window.tour.maybeShowWhatsNew({ force });
  return { shown, title: shown ? document.querySelector('#whats-new-title').textContent : null };
}, force);
const testRelease = (version, { carryForward = true, appVersions, title = version } = {}) => ({ version, carryForward,
  ...(appVersions ? { appVersions } : {}), content: { en: { title, intro: 'Release fixture', slides: [{ title: 'Fixture', body: 'Fixture body', media: { type: 'icon', icon: 'layers' } }] } } });

try {
  const page = await browser.newPage({ viewport: { width: 560, height: 240 } });
  await page.setContent(`
    <style>${tourCss}</style>
    <div class="whats-new-slide-media whats-new-slide-media-icon whats-new-slide-media-icons">
      <span><svg class="ui-icon"></svg></span>
      <span><svg class="ui-icon"></svg></span>
    </div>
  `);
  const centers = await page.evaluate(() => {
    const container = document.querySelector('.whats-new-slide-media-icons').getBoundingClientRect();
    const icons = [...document.querySelectorAll('.whats-new-slide-media-icons > span')].map(element => element.getBoundingClientRect());
    return {
      container: (container.left + container.right) / 2,
      group: (icons[0].left + icons.at(-1).right) / 2,
    };
  });
  assert.ok(Math.abs(centers.container - centers.group) <= 1, 'Today and Calm icons must be centered as a group inside the media pill');
  await page.close();

  for (const language of expectedLanguages) {
    await withTour({ appVersion: `v${v4Version}`, language }, async page => {
      assert.deepEqual(await shownVersion(page), { shown: true, title: v4.content[language].title });
      for (const [index, slide] of v4.content[language].slides.entries()) {
        assert.equal(await page.locator('.whats-new-slide-copy h4').textContent(), slide.title);
        assert.deepEqual(await page.locator('.whats-new-slide-bullets li').allTextContents(), slide.bullets);
        if (index === 0) {
          assert.equal(await page.locator('.whats-new-brand .nia-product-icon').count(), 2);
          assert.equal(await page.locator('.whats-new-brand img').count(), 0, 'use theme-aware product icons rather than static images');
          assert.deepEqual(await page.locator('.whats-new-brand > span').allTextContents(), ['nia-todo', 'Nia']);
          assert.equal(await page.locator('.whats-new-brand-arrow svg').count(), 1);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${language} V4 slide ${index + 1} fits mobile`);
        if (index < 5) await page.locator('[data-whats-new-action="next"]').click();
      }
      await page.locator('[data-whats-new-action="done"]').click();
      await page.locator('#whats-new-modal').waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(version => localStorage.getItem(`nia-whats-new:1:${version}`), v4Version), '1');
      assert.deepEqual(await shownVersion(page), { shown: false, title: null }, `${language} completed V4 cannot fall back to 3.3.0`);
      assert.deepEqual(await shownVersion(page, true), { shown: true, title: v4.content[language].title }, `${language} manual reopen keeps the newest eligible tour`);
    });
  }

  for (const width of [320, 1440]) {
    await withTour({ appVersion: `v${v4Version}`, language: 'de' }, async page => {
      await page.setViewportSize({ width, height: 900 });
      assert.equal((await shownVersion(page)).shown, true);
      const layout = await page.locator('.whats-new-brand-transition').evaluate(container => {
        const box = container.getBoundingClientRect();
        const [oldBrand, arrow, newBrand] = [...container.children].map(child => child.getBoundingClientRect());
        const arrowIcon = container.querySelector('.whats-new-brand-arrow svg').getBoundingClientRect();
        const arrowCenter = (arrowIcon.top + arrowIcon.bottom) / 2;
        return {
          ordered: oldBrand.right < arrow.left && arrow.right < newBrand.left,
          centered: Math.abs((oldBrand.left + newBrand.right) / 2 - (box.left + box.right) / 2) < 1,
          fits: oldBrand.left >= box.left && newBrand.right <= box.right
            && document.documentElement.scrollWidth <= innerWidth,
          aligned: [oldBrand, newBrand].every(brand => Math.abs((brand.top + brand.bottom) / 2 - arrowCenter) < 1),
        };
      });
      assert.deepEqual(layout, { ordered: true, centered: true, fits: true, aligned: true }, `both logos and arrow fit at ${width}px`);
      const themeResults = await page.evaluate(() => {
        const logos = [...document.querySelectorAll('.whats-new-brand .nia-product-icon')];
        const results = [];
        for (const theme of ['dark', 'light']) {
          window.tourTest.setTheme(theme);
          for (const preset of window.tourTest.ACCENT_PRESETS) {
            window.tourTest.setAccentPreset(preset.id);
            for (const intensity of [100, 40]) {
              window.tourTest.setAccentIntensity(intensity);
              results.push({
                theme, preset: preset.id, intensity,
                colors: logos.map(logo => [...logo.querySelectorAll('stop')].map(stop => getComputedStyle(stop).stopColor)),
              });
            }
          }
        }
        window.tourTest.setTheme('dark');
        window.tourTest.setAccentPreset('amber');
        window.tourTest.setAccentIntensity(100);
        return {
          results,
          sameNodes: logos.every((logo, index) => logo === document.querySelectorAll('.whats-new-brand .nia-product-icon')[index]),
          distinctIds: new Set(logos.map(logo => logo.querySelector('linearGradient').id)).size === 2,
        };
      });
      assert.equal(themeResults.sameNodes, true, 'both visible logos react to theme changes without rerendering');
      assert.equal(themeResults.distinctIds, true, 'each logo uses its own gradient reference');
      for (const result of themeResults.results) {
        assert.deepEqual(result.colors[0], result.colors[1], `both logos follow ${result.theme}/${result.preset}/${result.intensity}`);
      }
      assert.ok(new Set(themeResults.results.map(result => JSON.stringify(result.colors[0]))).size > 7,
        'theme, accent and intensity changes must visibly recolor the logos');
      if (process.env.NIA_TODO_TEST_OUTPUT_DIR) {
        mkdirSync(process.env.NIA_TODO_TEST_OUTPUT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.NIA_TODO_TEST_OUTPUT_DIR,
          `nia-v4-brand-transition-${width === 1440 ? 'desktop' : 'mobile'}.png`) });
      }
    });
  }

  for (const appVersion of ['v3.6.3', '3.6.3+build.1', '3.9.9', '3.99.99']) {
    await withTour({ appVersion }, async page => {
      assert.deepEqual(await shownVersion(page), { shown: true, title: release.content.en.title }, 'shipping V4 content cannot expose it to an app below 4.0.0');
    });
    await withTour({ appVersion, seen: [[1, '3.3.0']] }, async page => {
      assert.deepEqual(await shownVersion(page), { shown: false, title: null }, 'an older app with its old tour completed must not see the future 4.0 tour');
    });
  }
  await withTour({ appVersion: '3.0.0' }, async page => {
    assert.deepEqual(await shownVersion(page, true), { shown: false, title: null }, 'force cannot expose future releases');
    assert.equal(await page.evaluate(() => window.tour.open()), false, 'manual open cannot expose a future release either');
  });
  await withTour({ appVersion: '3.6.3', content: [v4] }, async page => {
    assert.equal(await page.evaluate(() => window.tour.open()), false, 'manual open under the current 3.x app cannot expose a V4-only catalog');
  });
  await withTour({ appVersion: 'v4.0.0-rc.1', seen: [[1, '3.3.0']] }, async page => {
    assert.deepEqual(await shownVersion(page), { shown: true, title: v4.content.en.title }, 'canonical version normalization still supports prerelease clients');
  });
  const unordered = [testRelease('3.9.0'), testRelease('5.0.0'), testRelease('3.10.0'), testRelease('4.0.0'), testRelease('3.3.0')];
  await withTour({ appVersion: '3.11.0', content: unordered }, async page => {
    assert.deepEqual(await shownVersion(page), { shown: true, title: '3.10.0' }, 'carry-forward uses numeric version ordering, not file or lexical ordering');
  });
  await withTour({ appVersion: '4.1.0', content: [...releases].reverse(), seen: [[1, v4Version]] }, async page => {
    assert.deepEqual(await shownVersion(page), { shown: false, title: null }, 'a completed carried tour never exposes an older unseen tour');
    assert.equal(await page.evaluate(() => window.tour.open()), true, 'manual open can reopen a completed carried release');
    assert.equal(await page.locator('#whats-new-title').textContent(), v4.content.en.title);
  });
  const alias = testRelease('4.0.0', { appVersions: ['4.0.1'], carryForward: false, title: 'Aliased current tour' });
  await withTour({ appVersion: '4.0.1', content: [testRelease('3.9.0'), alias] }, async page => {
    assert.deepEqual(await shownVersion(page), { shown: true, title: 'Aliased current tour' }, 'explicit appVersions aliases remain supported without carry-forward');
  });
  await withTour({ appVersion: '3.6.3', content: [testRelease('4.0.0', { appVersions: ['3.6.3'] })] }, async page => {
    assert.deepEqual(await shownVersion(page, true), { shown: false, title: null }, 'aliases cannot leak future release content into an older app');
  });
  await withTour({ appVersion: '4.1.0', content: [testRelease('3.3.0'), testRelease('4.0.0', { carryForward: false })], seen: [[1, '4.0.0']] }, async page => {
    assert.deepEqual(await shownVersion(page), { shown: false, title: null }, 'an older carry-forward campaign cannot reappear below a completed newer exact-only tour');
  });
  await withTour({ appVersion: '4.0.0', content: [testRelease('4.0.0', { carryForward: false })] }, async page => {
    assert.deepEqual(await shownVersion(page), { shown: true, title: '4.0.0' }, 'exact releases do not require carry-forward');
    await page.locator('[data-whats-new-action="dismiss"]').last().click();
    await page.locator('#whats-new-modal').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => localStorage.getItem('nia-whats-new:1:4.0.0')), null, 'dismissal does not complete a tour');
    assert.equal((await shownVersion(page)).shown, true);
    await page.locator('[data-whats-new-action="done"]').click();
    await page.locator('#whats-new-modal').waitFor({ state: 'hidden' });
    await page.evaluate(() => { window.tourUser = { id: 2 }; });
    assert.equal((await shownVersion(page)).shown, true, 'completion is scoped to each user on this browser');
  });
  await withTour({ appVersion: '4.0.0', language: 'cs', content: [testRelease('4.0.0', { title: 'English fallback' })] }, async page => {
    assert.deepEqual(await shownVersion(page), { shown: true, title: 'English fallback' });
  });
  const germanOnly = { version: '4.0.0', content: { de: { title: 'Deutsche Ersatzsprache', intro: 'Fixture', slides: [{ title: 'Fixture', body: 'Fixture' }] } } };
  await withTour({ appVersion: '4.0.0', content: [germanOnly] }, async page => {
    assert.deepEqual(await shownVersion(page), { shown: true, title: 'Deutsche Ersatzsprache' });
  });
  await withTour({ appVersion: 'invalid', content: unordered }, async page => {
    assert.deepEqual(await shownVersion(page, true), { shown: false, title: null }, 'unknown app versions fail closed');
  });

} finally {
  await browser.close();
}

console.log('✅ Historical and V4 tours, twelve locales, responsive rendering, future guards, version ordering, completion and manual reopen passed');

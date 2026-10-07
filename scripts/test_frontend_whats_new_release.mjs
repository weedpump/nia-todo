#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

console.log('🆕 Running 3.3.0 what\'s new content test...');

const releases = JSON.parse(readFileSync(new URL('../web/static/content/whats-new.json', import.meta.url), 'utf8')).releases;
const rendererSource = readFileSync(new URL('../web/static/js/features/whats-new.js', import.meta.url), 'utf8');
const tourCss = readFileSync(new URL('../web/static/css/74-whats-new.css', import.meta.url), 'utf8');
const expectedLanguages = ['de', 'en', 'cs', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'ru', 'sv', 'es', 'zh-CN'];

assert.equal(releases.length, 1, 'only the current 3.3.0 tour should be shipped');
const release = releases[0];
assert.equal(release.version, '3.3.0');
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

console.log('✅ 3.3.0 what\'s new content is complete in all supported languages');

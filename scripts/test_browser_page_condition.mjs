#!/usr/bin/env node
/** Real browser polling semantics; no application, service, network or DB. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { waitForPageCondition } from './browser_page_condition.mjs';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>Browser predicate polling</title>');

  await page.evaluate(() => { window.attempts = 0; });
  const falseStart = performance.now();
  await assert.rejects(waitForPageCondition(page, async () => {
    window.attempts += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    return false;
  }, null, { timeout: 350 }), { name: 'TimeoutError' });
  assert.ok(performance.now() - falseStart >= 300, 'An async false predicate must keep waiting');
  assert.ok(await page.evaluate(() => window.attempts >= 2), 'False results must be evaluated again');

  await page.evaluate(() => { window.attempts = 0; });
  const expected = { title: 'Expected browser value', count: 3 };
  const result = await waitForPageCondition(page, async value => {
    await new Promise(resolve => setTimeout(resolve, 5));
    window.attempts += 1;
    return window.attempts >= value.count ? value : false;
  }, expected, { timeout: 3000 });
  assert.deepEqual(result, expected, 'Arguments and the eventual truthy value must survive evaluation');

  await page.evaluate(() => { window.attempts = 0; });
  assert.equal(await waitForPageCondition(page, () => {
    window.attempts += 1;
    return [undefined, null, 0, 'ready'][window.attempts - 1];
  }, null, { timeout: 3000 }), 'ready', 'Existing falsy browser predicates must continue polling');

  const stalledStart = performance.now();
  await assert.rejects(waitForPageCondition(page, async () => new Promise(() => {}), null, { timeout: 150 }), { name: 'TimeoutError' });
  assert.ok(performance.now() - stalledStart < 3000, 'A stalled evaluation must respect the total deadline');

  await page.evaluate(() => { window.attempts = 0; });
  await assert.rejects(waitForPageCondition(page, async () => {
    window.attempts += 1;
    throw new Error('Predicate failure must propagate');
  }, null, { timeout: 3000 }), /Predicate failure must propagate/);
  assert.equal(await page.evaluate(() => window.attempts), 1, 'Rejected predicates must not be retried');
  console.log('✅ Browser conditions await results, retry falsy values, preserve arguments and enforce total deadlines');
} finally {
  await browser.close();
}

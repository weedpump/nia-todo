#!/usr/bin/env node
// Input-language examples are test data, never runtime dictionaries.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runMatchingFixtures } from './test_routing_memory_matching.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/routing_memory_base_recognition.json',import.meta.url),'utf8'));
assert.equal(fixture.locales.length,12);
for(const locale of fixture.locales) for(const moduleId of ['tasks','shopping']) {
  const rows=fixture.vectors.filter(row=>row.locale===locale && row.module===moduleId);
  assert.ok(rows.some(row=>row.expected!==null),`${moduleId}/${locale}: learned phrase positive`);
  assert.ok(rows.some(row=>row.expected===null),`${moduleId}/${locale}: unrelated input abstains`);
}
runMatchingFixtures(fixture,'language-independent learned-phrase fixtures (12 locales)');

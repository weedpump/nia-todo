#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../web/static/js/features/braindump-live.js', import.meta.url), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const applyIndex = source.indexOf('applyCandidates(candidates);');
const clearIndex = source.indexOf("state.error = '';", applyIndex);
const catchIndex = source.indexOf('} catch (error) {', applyIndex);

assert(applyIndex >= 0, 'BrainDump must apply candidates from a successful segment');
assert(clearIndex > applyIndex, 'a successful newer segment must clear an older segment error');
assert(catchIndex > clearIndex, 'the stale error must be cleared only on the successful processing path');

console.log('✅ Successful BrainDump segments clear stale earlier segment errors');

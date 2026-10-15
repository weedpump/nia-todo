#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../web/static/js/features/braindump-live.js', import.meta.url), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(source.includes('requestControllers: new Set()'), 'BrainDump must track active transcription and extraction requests');
assert(source.includes('function abortPendingRequests()'), 'BrainDump must provide one cancellation path for active requests');
assert(source.includes('for (const controller of state.requestControllers) controller.abort()'), 'closing must abort every active BrainDump request');
assert(source.includes('state.startToken += 1'), 'closing must invalidate callbacks from the cancelled session');
assert(source.includes('abortPendingRequests();'), 'session cancellation must abort pending network work');
assert(source.includes('cancelSession();'), 'closing must cancel the complete BrainDump session');
assert(source.includes('const stopToken = state.startToken'), 'delayed stop callbacks must belong to the active session');
assert(source.includes('if (stopToken !== state.startToken) return'), 'closing must invalidate delayed no-audio callbacks');
assert(source.includes('if (sessionToken !== state.startToken) return'), 'stale processing results must not mutate a reopened session');

console.log('✅ Closing BrainDump aborts and invalidates the complete active session');

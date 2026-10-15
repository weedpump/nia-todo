#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../web/static/js/features/braindump-live.js', import.meta.url), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(source.includes('const NATIVE_VOICE_LEVEL'), 'native voice detection must use a dedicated, less sensitive threshold');
assert(source.includes('const WEB_VOICE_CONFIRM_MS = 120'), 'browser and desktop voice detection must accept sustained quiet speech after 120 ms');
assert(source.includes('const NATIVE_VOICE_CONFIRM_MS = 240'), 'native Android peak detection must retain stronger 240 ms filtering');
assert(source.includes('const confirmMs = native ? NATIVE_VOICE_CONFIRM_MS : WEB_VOICE_CONFIRM_MS'), 'voice confirmation duration must depend on the capture path');
assert(source.includes('voiceStartedAt'), 'voice detection must track when a possible speech interval started');
assert(source.includes('now - state.voiceStartedAt < confirmMs'), 'movement spikes must not immediately refresh lastVoiceAt');
assert(source.includes('function updateVoiceActivity(level, now, native = false)'), 'voice activity detection must share one state transition helper');
assert(source.includes('state.voiceStartedAt = 0'), 'voice confirmation state must reset after silence');
assert(source.includes('updateVoiceActivity(state.level, now, true)'), 'native meter must use filtered voice activity detection');
assert(source.includes('updateVoiceActivity(state.level, now)'), 'browser and desktop meters must use filtered voice activity detection');
assert(source.includes('const SILENCE_HINT_DELAY_MS'), 'pause hint must wait until speech has actually stopped');
assert(source.includes('performance.now() - state.lastVoiceAt >= SILENCE_HINT_DELAY_MS'), 'pause hint must disappear while speech refreshes lastVoiceAt');
assert(source.includes('const voiceLevel = native ? NATIVE_VOICE_LEVEL : SILENCE_LEVEL'), 'browser voice detection must keep its existing threshold');

console.log('✅ BrainDump native silence detection filters transient amplitude spikes');

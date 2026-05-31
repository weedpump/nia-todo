import { API } from '../core/config.js';
import { getAuthHeaders, getAuthToken } from '../api/http.js';
import { escapeHtml, formatDate } from '../core/utils.js';
import { iconSvg } from '../icons/lucide-icons.js';
import { t } from '../i18n/index.js';
import { createNativeBridge } from './native-bridge.js';

const SILENCE_LEVEL = 0.035;
const SILENCE_STOP_MS = 3200;
const MIN_RECORDING_MS = 1600;
const SNAPSHOT_INTERVAL_MS = 3000;
const RECORDER_TIMESLICE_MS = 1000;
const MIN_AUDIO_CHUNK_BYTES = 96;

export function createBrainDumpLiveDebugFeature() {
  const nativeBridge = createNativeBridge();
  const state = {
    accessChecked: false,
    enabled: false,
    recorder: null,
    stream: null,
    audioContext: null,
    analyser: null,
    analyserData: null,
    levelTimer: null,
    renderTimer: null,
    requestTimer: null,
    recording: false,
    nativeRecording: false,
    processing: false,
    processingPhase: '',
    startedAt: 0,
    stoppedAt: 0,
    lastVoiceAt: 0,
    hasVoice: false,
    level: 0,
    peak: 0,
    segmentId: 0,
    active: 0,
    queue: [],
    audioChunks: [],
    lastSnapshotChunkCount: 0,
    latestQueuedSegmentId: 0,
    latestAppliedSegmentId: 0,
    finalSegmentId: 0,
    finalProcessed: false,
    candidates: [],
    selectedCandidateKeys: new Set(),
    creating: false,
    createMessage: '',
    error: '',
    transcript: '',
    candidateRenderSignature: '',
    initAttempts: 0,
  };

  async function init() {
    const app = document.getElementById('app');
    if (!app || document.getElementById('braindump-modal')) return;
    const loginOverlay = document.getElementById('login-overlay');
    const loginVisible = loginOverlay && window.getComputedStyle(loginOverlay).display !== 'none';
    if (loginVisible || !getAuthToken()) return scheduleInitRetry();
    await checkAccess();
    if (!state.enabled) return;
    injectLauncher();
    injectModal();
    window.openBrainDump = open;
  }

  function scheduleInitRetry() {
    if (state.initAttempts >= 8 || document.getElementById('braindump-modal')) return;
    state.initAttempts += 1;
    setTimeout(init, 1500);
  }

  async function checkAccess() {
    if (state.accessChecked) return;
    state.accessChecked = true;
    try {
      const response = await fetch(`${API}/api/braindump/v2/access`, {
        headers: getAuthHeaders(),
        credentials: 'include',
      });
      if (!response.ok) return;
      const data = await response.json();
      state.enabled = Boolean(data.enabled);
    } catch {
      state.enabled = false;
    }
  }

  function injectLauncher() {
    if (document.getElementById('braindump-fab')) return;
    const fab = document.createElement('button');
    fab.id = 'braindump-fab';
    fab.className = 'braindump-fab';
    fab.type = 'button';
    updateLauncherLabel(fab);
    fab.innerHTML = iconSvg('mic');
    fab.addEventListener('click', open);
    document.body.appendChild(fab);
  }

  function updateLauncherLabel(fab = document.getElementById('braindump-fab')) {
    if (!fab) return;
    fab.title = t('braindump.open');
    fab.setAttribute('aria-label', t('braindump.open'));
  }

  function injectModal() {
    if (document.getElementById('braindump-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'braindump-modal';
    modal.className = 'modal braindump-modal';
    modal.innerHTML = `
      <div class="modal-overlay" id="braindump-overlay"></div>
      <div class="modal-content braindump-modal-content" role="dialog" aria-modal="true" aria-labelledby="braindump-title">
        <div class="braindump-hero">
          <div class="braindump-orb" id="braindump-orb">${iconSvg('mic')}</div>
          <div>
            <h3 id="braindump-title">${t('braindump.title')}</h3>
            <p id="braindump-subtitle">${t('braindump.subtitle')}</p>
          </div>
          <button class="modal-close-x braindump-close" id="braindump-close" type="button" aria-label="${escapeHtml(t('common.close'))}" title="${escapeHtml(t('common.close'))}">${iconSvg('x')}</button>
        </div>
        <div class="modal-body braindump-body">
          <div class="braindump-stage" id="braindump-stage">
            <div class="braindump-wave" id="braindump-wave" aria-hidden="true">${Array.from({ length: 24 }, (_, index) => `<span style="--i:${index}"></span>`).join('')}</div>
            <div class="braindump-status" id="braindump-status">${t('braindump.status.ready')}</div>
            <div class="braindump-processing" id="braindump-processing" hidden><span class="braindump-spinner" aria-hidden="true"></span><span id="braindump-processing-text">${t('braindump.processing.transcribing')}</span></div>
            <div class="braindump-hint" id="braindump-hint">${t('braindump.hint.idle')}</div>
            <div class="braindump-transcript" id="braindump-transcript" hidden></div>
          </div>
          <div class="braindump-error" id="braindump-error" hidden></div>
          <div class="braindump-results" id="braindump-results" hidden>
            <div class="braindump-results-head">
              <div>
                <strong>${t('braindump.results.title')}</strong>
                <span id="braindump-results-subtitle">${t('braindump.results.subtitle')}</span>
              </div>
              <button type="button" class="btn btn-secondary btn-sm" id="braindump-select-all">${t('braindump.selectAll')}</button>
            </div>
            <div class="braindump-candidates" id="braindump-candidates"></div>
            <div class="braindump-create-status" id="braindump-create-status"></div>
          </div>
        </div>
        <div class="modal-actions braindump-actions">
          <button type="button" class="btn btn-secondary" id="braindump-cancel">${t('common.close')}</button>
          <button type="button" class="btn btn-secondary" id="braindump-retry" hidden>${t('braindump.retry')}</button>
          <button type="button" class="btn btn-primary" id="braindump-record">${t('braindump.record.start')}</button>
          <button type="button" class="btn btn-primary" id="braindump-create" hidden disabled>${t('braindump.create')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('braindump-overlay')?.addEventListener('click', close);
    document.getElementById('braindump-close')?.addEventListener('click', close);
    document.getElementById('braindump-cancel')?.addEventListener('click', close);
    document.getElementById('braindump-record')?.addEventListener('click', () => (state.recording ? stop('manual') : start()));
    document.getElementById('braindump-retry')?.addEventListener('click', start);
    document.getElementById('braindump-create')?.addEventListener('click', createSelectedTodos);
    document.getElementById('braindump-select-all')?.addEventListener('click', toggleAllCandidates);
    window.addEventListener('nia-language-change', () => {
      updateLauncherLabel();
      updateStaticLabels();
      render();
    });
    modal.addEventListener('change', (event) => {
      const box = event.target?.closest?.('[data-bd-candidate-key]');
      if (!box) return;
      const key = box.getAttribute('data-bd-candidate-key');
      if (!key) return;
      if (box.checked) state.selectedCandidateKeys.add(key);
      else state.selectedCandidateKeys.delete(key);
      render();
    });
  }

  function updateStaticLabels() {
    updateLauncherLabel();
    const title = document.getElementById('braindump-title');
    const subtitle = document.getElementById('braindump-subtitle');
    const closeBtn = document.getElementById('braindump-close');
    const cancelBtn = document.getElementById('braindump-cancel');
    const retryBtn = document.getElementById('braindump-retry');
    const resultsTitle = document.querySelector('.braindump-results-head strong');
    if (title) title.textContent = t('braindump.title');
    if (subtitle) subtitle.textContent = t('braindump.subtitle');
    if (closeBtn) {
      closeBtn.setAttribute('aria-label', t('common.close'));
      closeBtn.setAttribute('title', t('common.close'));
    }
    if (cancelBtn) cancelBtn.textContent = t('common.close');
    if (retryBtn) retryBtn.textContent = t('braindump.retry');
    if (resultsTitle) resultsTitle.textContent = t('braindump.results.title');
  }

  function open() {
    injectModal();
    updateStaticLabels();
    document.getElementById('braindump-modal')?.classList.add('active');
    render();
  }

  async function close() {
    if (state.recording) await stop('close');
    document.getElementById('braindump-modal')?.classList.remove('active');
  }

  function resetSession() {
    state.segmentId = 0;
    state.active = 0;
    state.queue = [];
    state.audioChunks = [];
    state.lastSnapshotChunkCount = 0;
    state.latestQueuedSegmentId = 0;
    state.latestAppliedSegmentId = 0;
    state.finalSegmentId = 0;
    state.finalProcessed = false;
    state.candidates = [];
    state.selectedCandidateKeys.clear();
    state.createMessage = '';
    state.error = '';
    state.transcript = '';
    state.processingPhase = '';
    state.candidateRenderSignature = '';
    state.level = 0;
    state.peak = 0;
    state.startedAt = 0;
    state.stoppedAt = 0;
    state.lastVoiceAt = 0;
    state.hasVoice = false;
  }

  function hasNativeAudioBridge() {
    return nativeBridge.supportsAudioRecording();
  }

  function blobFromBase64(base64, mime) {
    const binary = atob(base64 || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'audio/mp4' });
  }

  function startNativeAudioRecording() {
    const result = nativeBridge.startAudioRecording();
    if (!result.ok) throw new Error(result.error || 'Native audio recording failed');
    state.nativeRecording = true;
    state.recording = true;
    state.processing = false;
    state.processingPhase = '';
    state.startedAt = performance.now();
    state.lastVoiceAt = state.startedAt;
    if (state.levelTimer) clearInterval(state.levelTimer);
    state.levelTimer = setInterval(updateNativeAudioLevel, 80);
    state.renderTimer = setInterval(render, 120);
    render();
  }

  async function getMicrophoneStream() {
    const enhancedConstraints = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
    try {
      return await navigator.mediaDevices.getUserMedia(enhancedConstraints);
    } catch (error) {
      const message = String(error?.message || error || '').toLowerCase();
      const name = String(error?.name || '').toLowerCase();
      const shouldRetryMinimal = name === 'notreadableerror' || message.includes('could not start audio source');
      if (!shouldRetryMinimal) throw error;
      console.warn('[BrainDump] enhanced microphone constraints failed; retrying with minimal audio constraints', error);
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
  }

  async function start() {
    if (state.recording) return;
    const canUseWebRecorder = Boolean(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
    if (!canUseWebRecorder && !hasNativeAudioBridge()) {
      state.error = t('braindump.error.unsupported');
      render();
      return;
    }
    resetSession();
    try {
      if (!canUseWebRecorder) {
        startNativeAudioRecording();
        return;
      }
      try {
        state.stream = await getMicrophoneStream();
      } catch (error) {
        if (!hasNativeAudioBridge()) throw error;
        console.warn('[BrainDump] WebView microphone capture failed; using native Android recorder', error);
        startNativeAudioRecording();
        return;
      }
      setupAudioMeter();
      const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
      const mimeType = mimeCandidates.find((value) => {
        try { return MediaRecorder.isTypeSupported(value); } catch { return false; }
      }) || '';
      state.recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
      state.recorder.addEventListener('dataavailable', onChunk);
      state.recorder.addEventListener('error', (event) => {
        state.error = String(event.error?.message || event.error || 'MediaRecorder error');
        render();
      });
      state.recorder.addEventListener('stop', cleanupRecordingHandles);
      state.recording = true;
      state.processing = false;
      state.processingPhase = '';
      state.startedAt = performance.now();
      state.lastVoiceAt = state.startedAt;
      // A timeslice makes desktop WebViews emit real audio chunks while recording instead of
      // relying on a final requestData() race at stop time. Browsers that ignore it still emit
      // the final chunk on stop.
      state.recorder.start(RECORDER_TIMESLICE_MS);
      state.requestTimer = setInterval(() => requestRecorderData(), SNAPSHOT_INTERVAL_MS);
      state.renderTimer = setInterval(render, 120);
      render();
    } catch (error) {
      state.error = String(error?.message || error);
      state.recording = false;
      cleanupRecordingHandles();
      render();
    }
  }

  async function stop(reason = 'manual') {
    if (!state.recording) return;
    state.recording = false;
    state.processing = true;
    state.processingPhase = 'transcribing';
    state.stoppedAt = performance.now();
    if (state.requestTimer) clearInterval(state.requestTimer);
    state.requestTimer = null;
    if (state.nativeRecording) {
      queueNativeAudioRecording();
      cleanupRecordingHandles();
    } else {
      requestRecorderData();
      try { state.recorder?.stop(); } catch {}
    }
    setTimeout(() => {
      if (!state.audioChunks.length && state.active === 0 && !state.queue.length) {
        state.error = reason === 'auto' ? t('braindump.error.noVoice') : t('braindump.error.noAudio');
        state.processing = false;
        state.processingPhase = '';
        render();
      }
    }, 700);
    render();
  }

  function setupAudioMeter() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      state.audioContext = new AudioCtx();
      const source = state.audioContext.createMediaStreamSource(state.stream);
      state.analyser = state.audioContext.createAnalyser();
      state.analyser.fftSize = 512;
      state.analyser.smoothingTimeConstant = 0.72;
      source.connect(state.analyser);
      state.analyserData = new Uint8Array(state.analyser.frequencyBinCount);
      state.levelTimer = setInterval(updateAudioLevel, 80);
    } catch (error) {
      console.warn('[BrainDump] audio meter unavailable', error);
    }
  }

  function updateNativeAudioLevel() {
    if (!state.nativeRecording || !state.recording) return;
    try {
      const amplitude = Number(nativeBridge.audioAmplitude() || 0);
      const normalized = Math.max(0, Math.min(1, amplitude / 32767));
      state.level = Math.min(1, normalized * 3.2);
      state.peak = Math.max(state.level, state.peak * 0.92);
      const now = performance.now();
      if (state.level > SILENCE_LEVEL) {
        state.hasVoice = true;
        state.lastVoiceAt = now;
      }
      if (state.hasVoice && now - state.startedAt > MIN_RECORDING_MS && now - state.lastVoiceAt > SILENCE_STOP_MS) {
        stop('auto');
      }
    } catch (error) {
      console.warn('[BrainDump] native audio level unavailable', error);
    }
  }

  function updateAudioLevel() {
    if (!state.analyser || !state.analyserData || !state.recording) return;
    state.analyser.getByteTimeDomainData(state.analyserData);
    let sum = 0;
    for (const value of state.analyserData) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / state.analyserData.length);
    state.level = Math.min(1, rms * 5.5);
    state.peak = Math.max(state.level, state.peak * 0.92);
    const now = performance.now();
    if (state.level > SILENCE_LEVEL) {
      state.hasVoice = true;
      state.lastVoiceAt = now;
    }
    if (state.hasVoice && now - state.startedAt > MIN_RECORDING_MS && now - state.lastVoiceAt > SILENCE_STOP_MS) {
      stop('auto');
    }
  }

  function cleanupRecordingHandles() {
    state.nativeRecording = false;
    state.recorder = null;
    state.stream?.getTracks().forEach((track) => track.stop());
    state.stream = null;
    if (state.levelTimer) clearInterval(state.levelTimer);
    state.levelTimer = null;
    if (state.requestTimer) clearInterval(state.requestTimer);
    state.requestTimer = null;
    stopRenderTimerIfIdle();
    try { state.audioContext?.close?.(); } catch {}
    state.audioContext = null;
    state.analyser = null;
    state.analyserData = null;
    render();
  }

  function stopRenderTimerIfIdle() {
    if (!state.renderTimer || state.recording || state.processing || state.active || state.queue.length) return;
    clearInterval(state.renderTimer);
    state.renderTimer = null;
  }

  function requestRecorderData() {
    try {
      if (state.recorder?.state === 'recording') state.recorder.requestData();
    } catch (error) {
      console.warn('[BrainDump] requestData failed', error);
    }
  }

  function queueNativeAudioRecording() {
    try {
      const result = nativeBridge.stopAudioRecording();
      if (!result.ok) throw new Error(result.error || 'Native audio recording failed');
      const blob = blobFromBase64(result.base64, result.mime || 'audio/mp4');
      if (blob.size < MIN_AUDIO_CHUNK_BYTES) throw new Error(t('braindump.error.noAudio'));
      state.audioChunks.push(blob);
      const audioEndMs = Math.round((state.stoppedAt || performance.now()) - state.startedAt);
      queueAccumulatedSnapshot(audioEndMs, 'final');
    } catch (error) {
      state.error = String(error?.message || error);
      state.processing = false;
      state.processingPhase = '';
    }
  }

  function onChunk(event) {
    const size = event.data?.size || 0;
    if (!event.data || size < MIN_AUDIO_CHUNK_BYTES) return;
    state.audioChunks.push(event.data);
    const audioEndMs = Math.round((performance.now() || 0) - state.startedAt);
    queueAccumulatedSnapshot(audioEndMs, state.stoppedAt ? 'final' : 'snapshot');
    render();
  }

  function queueAccumulatedSnapshot(audioEndMs, reason) {
    if (!state.audioChunks.length) return;
    if (!state.stoppedAt && state.audioChunks.length === state.lastSnapshotChunkCount) return;
    state.lastSnapshotChunkCount = state.audioChunks.length;
    const type = state.audioChunks[0]?.type || state.recorder?.mimeType || 'audio/webm';
    const blob = new Blob(state.audioChunks, { type });
    const item = {
      segmentId: ++state.segmentId,
      audioStartMs: 0,
      audioEndMs,
      kind: reason,
    };
    state.latestQueuedSegmentId = item.segmentId;
    if (state.stoppedAt) {
      state.finalSegmentId = item.segmentId;
      state.finalProcessed = false;
    }
    pumpItem(item, blob);
  }

  function pumpItem(item, blob) {
    for (const pending of state.queue) pending.stale = true;
    state.queue = [{ item, blob }];
    pump();
  }

  function pump() {
    while (state.active < 1 && state.queue.length) {
      const job = state.queue.shift();
      state.active += 1;
      processSegment(job).finally(() => {
        state.active -= 1;
        if (state.stoppedAt && state.active === 0 && state.queue.length === 0) {
          state.processing = false;
          state.processingPhase = '';
        }
        pump();
        render();
        stopRenderTimerIfIdle();
      });
    }
  }

  async function fetchWithTimeout(url, options, timeoutMs = 60_000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function processSegment({ item, blob }) {
    const params = new URLSearchParams({
      segment_id: String(item.segmentId),
      audio_start_ms: String(item.audioStartMs),
      audio_end_ms: String(item.audioEndMs),
      model: 'small',
    });
    try {
      state.processingPhase = 'transcribing';
      render();
      const transcribeHeaders = getAuthHeaders();
      transcribeHeaders['Content-Type'] = blob.type || 'application/octet-stream';
      const transcribeResponse = await fetchWithTimeout(`${API}/api/braindump/v2/live/audio-segment/transcribe?${params}`, {
        method: 'POST',
        headers: transcribeHeaders,
        credentials: 'include',
        body: blob,
      });
      if (!transcribeResponse.ok) throw new Error(await transcribeResponse.text());
      const transcribed = await transcribeResponse.json();
      if (state.stoppedAt && item.segmentId < state.finalSegmentId) return;
      if (!state.stoppedAt && item.segmentId < state.latestQueuedSegmentId) return;
      state.transcript = transcribed.transcript || state.transcript || '';
      state.processingPhase = 'extracting';
      render();

      const extractResponse = await fetchWithTimeout(`${API}/api/braindump/v2/live/text-segment/extract`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          transcript: state.transcript,
          segment_id: item.segmentId,
          audio_start_ms: item.audioStartMs,
          audio_end_ms: item.audioEndMs,
        }),
      });
      if (!extractResponse.ok) throw new Error(await extractResponse.text());
      const data = await extractResponse.json();
      if (state.stoppedAt && item.segmentId < state.finalSegmentId) return;
      if (!state.stoppedAt && item.segmentId < state.latestQueuedSegmentId) return;
      const candidates = Array.isArray(data.json?.candidates) ? data.json.candidates : [];
      state.latestAppliedSegmentId = Math.max(state.latestAppliedSegmentId, item.segmentId);
      applyCandidates(candidates);
      if (state.stoppedAt && item.segmentId === state.finalSegmentId) state.finalProcessed = true;
    } catch (error) {
      state.error = String(error?.message || error);
      state.processing = false;
      state.processingPhase = '';
    }
  }

  function candidateKey(candidate) {
    return [candidate.title, candidate.project_name, candidate.section_name, candidate.deadline, candidate.reminder, candidate.kind].map((value) => String(value || '').trim()).join('|');
  }

  function applyCandidates(candidates) {
    const nextCandidates = Array.isArray(candidates) ? candidates : [];
    const previousSelected = state.selectedCandidateKeys;
    state.candidates = nextCandidates;
    state.selectedCandidateKeys = new Set(nextCandidates.map((candidate) => {
      const key = candidateKey(candidate);
      return previousSelected.size === 0 || previousSelected.has(key) ? key : null;
    }).filter(Boolean));
    state.candidateRenderSignature = '';
  }

  function selectedCandidates() {
    return state.candidates.filter((candidate) => state.selectedCandidateKeys.has(candidateKey(candidate)));
  }

  function toggleAllCandidates() {
    const allSelected = state.candidates.length && selectedCandidates().length === state.candidates.length;
    state.selectedCandidateKeys = allSelected ? new Set() : new Set(state.candidates.map(candidateKey));
    render();
  }

  async function createSelectedTodos() {
    const candidates = selectedCandidates();
    if (!candidates.length || state.creating) return;
    state.creating = true;
    state.createMessage = '';
    render();
    try {
      const response = await fetch(`${API}/api/braindump/v2/todos`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ candidates }),
      });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      const count = Array.isArray(data.todos) ? data.todos.length : 0;
      state.createMessage = t(count === 1 ? 'braindump.created.one' : 'braindump.created.many', { count });
      state.selectedCandidateKeys.clear();
      if (typeof window.refreshFromServer === 'function') await window.refreshFromServer();
      setTimeout(close, 850);
    } catch (error) {
      state.createMessage = t('common.error') + ': ' + String(error?.message || error);
    } finally {
      state.creating = false;
      render();
    }
  }

  function render() {
    const modal = document.getElementById('braindump-modal');
    if (!modal) return;
    const elapsed = state.recording ? (performance.now() - state.startedAt) / 1000 : (state.startedAt && state.stoppedAt ? (state.stoppedAt - state.startedAt) / 1000 : 0);
    const status = document.getElementById('braindump-status');
    const hint = document.getElementById('braindump-hint');
    const recordBtn = document.getElementById('braindump-record');
    const retryBtn = document.getElementById('braindump-retry');
    const createBtn = document.getElementById('braindump-create');
    const results = document.getElementById('braindump-results');
    const error = document.getElementById('braindump-error');
    const transcript = document.getElementById('braindump-transcript');
    const stage = document.getElementById('braindump-stage');
    const processing = document.getElementById('braindump-processing');
    const processingText = document.getElementById('braindump-processing-text');
    const orb = document.getElementById('braindump-orb');
    const wave = document.getElementById('braindump-wave');
    const selectedCount = selectedCandidates().length;
    modal.classList.toggle('is-recording', state.recording);
    modal.classList.toggle('is-processing', state.processing || state.active > 0 || state.queue.length > 0);
    stage?.style.setProperty('--bd-level', String(Math.max(0.08, state.level)));
    stage?.style.setProperty('--bd-peak', String(Math.max(0.10, state.peak)));
    if (wave) {
      Array.from(wave.children).forEach((bar, index) => {
        const wobble = 0.25 + Math.abs(Math.sin((performance.now() / 180) + index * 0.7)) * 0.75;
        bar.style.setProperty('--h', String(12 + Math.round(64 * Math.max(state.level, 0.04) * wobble)));
      });
    }
    if (status) {
      status.textContent = state.recording
        ? t('braindump.status.listening', { seconds: elapsed.toFixed(1) })
        : state.processing || state.active || state.queue.length
          ? t('braindump.status.processing')
          : state.candidates.length
            ? t('braindump.status.readyWithCandidates')
            : t('braindump.status.ready');
    }
    const isBusy = state.processing || state.active || state.queue.length;
    if (processing) processing.hidden = !isBusy || state.recording;
    if (processingText) {
      processingText.textContent = state.transcript
        ? t('braindump.processing.extracting')
        : t('braindump.processing.transcribing');
    }
    if (hint) {
      const silenceLeft = state.recording && state.hasVoice ? Math.max(0, (SILENCE_STOP_MS - (performance.now() - state.lastVoiceAt)) / 1000) : null;
      hint.textContent = state.recording
        ? (silenceLeft == null ? t('braindump.hint.recording') : t('braindump.hint.silence', { seconds: silenceLeft.toFixed(1) }))
        : isBusy
          ? t('braindump.hint.processing')
          : t('braindump.hint.idle');
    }
    if (orb) orb.innerHTML = state.processing || state.active ? iconSvg('sparkles') : iconSvg(state.recording ? 'mic' : 'mic');
    if (recordBtn) {
      recordBtn.hidden = state.processing || state.candidates.length > 0;
      recordBtn.textContent = state.recording ? t('braindump.record.finish') : t('braindump.record.start');
    }
    if (retryBtn) retryBtn.hidden = state.recording || state.processing || (!state.candidates.length && !state.error && !state.transcript);
    if (createBtn) {
      createBtn.hidden = false;
      createBtn.disabled = state.creating || state.recording || state.processing || !selectedCount;
      createBtn.classList.toggle('is-muted', createBtn.disabled || !selectedCount);
      createBtn.textContent = state.creating ? t('braindump.create.busy') : t('braindump.create.count', { count: selectedCount });
    }
    if (results) results.hidden = !state.candidates.length;
    if (error) {
      error.hidden = !state.error;
      error.textContent = state.error;
    }
    if (transcript) {
      transcript.hidden = !state.transcript;
      transcript.textContent = state.transcript;
    }
    renderCandidates();
  }

  function renderCandidates() {
    const container = document.getElementById('braindump-candidates');
    const subtitle = document.getElementById('braindump-results-subtitle');
    const selectAll = document.getElementById('braindump-select-all');
    const status = document.getElementById('braindump-create-status');
    if (!container) return;
    if (subtitle) subtitle.textContent = t(state.candidates.length === 1 ? 'braindump.results.count.one' : 'braindump.results.count.many', { count: state.candidates.length });
    if (selectAll) selectAll.textContent = selectedCandidates().length === state.candidates.length ? t('braindump.selectNone') : t('braindump.selectAll');
    if (status) status.textContent = state.createMessage || '';
    const signature = JSON.stringify({
      candidates: state.candidates.map(candidateKey),
      selected: Array.from(state.selectedCandidateKeys).sort(),
      language: document.documentElement.lang || '',
    });
    if (signature === state.candidateRenderSignature) return;
    state.candidateRenderSignature = signature;
    container.innerHTML = state.candidates.map((candidate, index) => renderCandidate(candidate, index)).join('');
  }

  function renderCandidate(candidate, index) {
    const key = candidateKey(candidate);
    const checked = state.selectedCandidateKeys.has(key) ? 'checked' : '';
    const route = [candidate.project_name, candidate.section_name].filter(Boolean).join(' / ') || t('braindump.route.inbox');
    const due = candidate.deadline ? formatDate(candidate.deadline) : '';
    const reminder = candidate.reminder ? formatDate(candidate.reminder) : '';
    const kind = candidate.kind || 'todo';
    const meta = [route, due ? t('braindump.meta.due', { date: due }) : '', reminder ? t('braindump.meta.reminder', { date: reminder }) : '', kind !== 'todo' ? t(`braindump.kind.${kind}`) : ''].filter(Boolean).join(' · ');
    return `
      <label class="braindump-candidate-card todo-item" style="--bd-delay:${Math.min(index, 8) * 55}ms">
        <input type="checkbox" data-bd-candidate-key="${escapeHtml(key)}" ${checked}>
        <span class="todo-check braindump-check">${checked ? iconSvg('check') : ''}</span>
        <span class="todo-body has-meta">
          <span class="todo-main">
            <span class="todo-prio priority-dot"></span>
            <span class="todo-title">${escapeHtml(candidate.title || '')}</span>
          </span>
          <span class="todo-meta-row"><span class="todo-desc-preview">${escapeHtml(meta)}</span></span>
        </span>
      </label>
    `;
  }

  return { init, open };
}

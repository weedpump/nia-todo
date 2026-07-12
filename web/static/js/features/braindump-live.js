import { API } from '../core/config.js';
import { getAuthHeaders, getAuthToken } from '../api/http.js';
import { escapeHtml, escapeHtmlAttr, formatDate } from '../core/utils.js';
import { hydrateIcons, iconSvg } from '../icons/lucide-icons.js';
import { t } from '../i18n/index.js';
import { closeOpenDropdown, hydrateSelect, refreshSelect } from '../ui/dropdowns.js';
import { createNativeBridge } from './native-bridge.js';

const SILENCE_LEVEL = 0.035;
const SILENCE_STOP_MS = 3200;
const MIN_RECORDING_MS = 1600;
const SNAPSHOT_INTERVAL_MS = 3000;
const RECORDER_TIMESLICE_MS = 1000;
const MIN_AUDIO_CHUNK_BYTES = 96;

function recurringLabel(rule) {
  if (!rule || typeof rule !== 'object') return '';
  const frequency = String(rule.frequency || '').toLowerCase();
  const interval = Number.parseInt(rule.interval || 1, 10) || 1;
  const key = `todo.recurring.label.${frequency}`;
  const label = t(key, { interval });
  return label === key ? '' : label;
}

function isoToDateTimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function dateTimeLocalToIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeRecurringRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const frequency = String(rule.frequency || 'none').toLowerCase();
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(frequency)) return null;
  const interval = Math.max(1, Math.min(999, Number.parseInt(rule.interval || 1, 10) || 1));
  return { frequency, interval, preserve_time: true };
}

export function createBrainDumpLiveFeature(options = {}) {
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
    starting: false,
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
    startToken: 0,
    candidateIdCounter: 0,
    editingCandidateKey: '',
    workspaceId: null,
    savedPlaces: [],
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
    modal.className = 'modal braindump-modal ui-detail-modal ui-detail-view';
    modal.innerHTML = `
      <div class="modal-overlay" id="braindump-overlay"></div>
      <div class="modal-content braindump-modal-content ui-detail-modal-content" role="dialog" aria-modal="true" aria-labelledby="braindump-title">
        <div class="braindump-hero ui-detail-modal-header">
          <div class="braindump-orb ui-detail-title-icon" id="braindump-orb">${iconSvg('sparkles')}</div>
          <div>
            <h3 id="braindump-title">${t('braindump.title')}</h3>
            <p id="braindump-subtitle">${t('braindump.subtitle')}</p>
          </div>
          <button class="modal-close-x braindump-close" id="braindump-close" type="button" aria-label="${escapeHtml(t('common.close'))}" title="${escapeHtml(t('common.close'))}">${iconSvg('x')}</button>
        </div>
        <div class="modal-body braindump-body ui-detail-modal-body">
          <div class="braindump-shell ui-detail-shell">
            <section class="ui-section-card ui-detail-section braindump-stage-section" id="braindump-stage">
              <div class="ui-section-heading ui-detail-section-heading braindump-section-heading">
                <div class="ui-section-icon ui-detail-section-icon" data-icon="mic"></div>
                <div>
                  <h4 id="braindump-recording-section-title">${t('braindump.section.recording')}</h4>
                  <p><span id="braindump-status">${t('braindump.status.ready')}</span> · <span id="braindump-hint">${t('braindump.hint.idle')}</span></p>
                </div>
              </div>
              <div class="braindump-wave" id="braindump-wave" aria-hidden="true">${Array.from({ length: 24 }, (_, index) => `<span style="--i:${index}"></span>`).join('')}</div>
              <div class="braindump-processing" id="braindump-processing" hidden><span class="braindump-spinner" aria-hidden="true"></span><span id="braindump-processing-text">${t('braindump.processing.transcribing')}</span></div>
            </section>
            <section class="ui-section-card ui-detail-section braindump-transcript-section" id="braindump-transcript-section" hidden>
              <div class="ui-section-heading ui-detail-section-heading braindump-section-heading">
                <div class="ui-section-icon ui-detail-section-icon" data-icon="file-text"></div>
                <div>
                  <h4 id="braindump-transcript-section-title">${t('braindump.section.transcript')}</h4>
                  <p id="braindump-transcript-section-hint">${t('braindump.section.transcriptHint')}</p>
                </div>
              </div>
              <div class="braindump-transcript" id="braindump-transcript"></div>
            </section>
            <section class="ui-section-card ui-detail-section braindump-results" id="braindump-results" hidden>
              <div class="ui-section-heading ui-detail-section-heading braindump-results-head">
                <div class="ui-section-icon ui-detail-section-icon" data-icon="list-todo"></div>
                <div>
                  <h4>${t('braindump.results.title')}</h4>
                  <p id="braindump-results-subtitle">${t('braindump.results.subtitle')}</p>
                </div>
                <button type="button" class="btn btn-secondary btn-sm" id="braindump-select-all">${t('braindump.selectAll')}</button>
              </div>
              <div class="braindump-candidates" id="braindump-candidates"></div>
              <div class="braindump-create-status" id="braindump-create-status"></div>
            </section>
            <div class="braindump-error" id="braindump-error" hidden></div>
          </div>
        </div>
        <div class="modal-actions braindump-actions">
          <button type="button" class="btn btn-secondary" id="braindump-cancel">${t('common.close')}</button>
          <button type="button" class="btn btn-secondary" id="braindump-retry" hidden>${t('braindump.retry')}</button>
          <button type="button" class="btn btn-primary" id="braindump-record" hidden>${t('braindump.record.finish')}</button>
          <button type="button" class="btn btn-primary" id="braindump-create" hidden disabled>${t('braindump.create')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    hydrateIcons(modal);
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
    window.addEventListener('nia:saved-places-updated', (event) => {
      state.savedPlaces = Array.isArray(event.detail?.places) ? event.detail.places : [];
      state.candidateRenderSignature = '';
      render();
    });
    modal.addEventListener('change', (event) => {
      const checkbox = event.target?.closest?.('input[type="checkbox"][data-bd-candidate-key]');
      if (checkbox) {
        const key = checkbox.getAttribute('data-bd-candidate-key');
        if (!key) return;
        if (checkbox.checked) state.selectedCandidateKeys.add(key);
        else state.selectedCandidateKeys.delete(key);
        render();
        return;
      }
      const field = event.target?.closest?.('[data-bd-field]');
      if (field) {
        updateCandidateField(field);
        if (field.tagName === 'SELECT') refreshSelect(field);
      }
    });
    modal.addEventListener('input', (event) => {
      const field = event.target?.closest?.('input[data-bd-field]');
      if (field) updateCandidateField(field, { rerender: false });
    });
    modal.addEventListener('click', (event) => {
      const action = event.target?.closest?.('[data-bd-action]');
      if (!action) return;
      if (action.getAttribute('data-bd-action') === 'edit') toggleCandidateEditor(action.getAttribute('data-bd-candidate-key'));
    });
  }

  function updateStaticLabels() {
    updateLauncherLabel();
    const title = document.getElementById('braindump-title');
    const subtitle = document.getElementById('braindump-subtitle');
    const closeBtn = document.getElementById('braindump-close');
    const cancelBtn = document.getElementById('braindump-cancel');
    const retryBtn = document.getElementById('braindump-retry');
    const resultsTitle = document.querySelector('.braindump-results-head h4');
    const recordingSectionTitle = document.getElementById('braindump-recording-section-title');
    const transcriptSectionTitle = document.getElementById('braindump-transcript-section-title');
    const transcriptSectionHint = document.getElementById('braindump-transcript-section-hint');
    if (title) title.textContent = t('braindump.title');
    if (subtitle) subtitle.textContent = t('braindump.subtitle');
    if (closeBtn) {
      closeBtn.setAttribute('aria-label', t('common.close'));
      closeBtn.setAttribute('title', t('common.close'));
    }
    if (cancelBtn) cancelBtn.textContent = t('common.close');
    if (retryBtn) retryBtn.textContent = t('braindump.retry');
    if (recordingSectionTitle) recordingSectionTitle.textContent = t('braindump.section.recording');
    if (transcriptSectionTitle) transcriptSectionTitle.textContent = t('braindump.section.transcript');
    if (transcriptSectionHint) transcriptSectionHint.textContent = t('braindump.section.transcriptHint');
    if (resultsTitle) resultsTitle.textContent = t('braindump.results.title');
  }

  function open() {
    injectModal();
    updateStaticLabels();
    document.getElementById('braindump-modal')?.classList.add('active');
    render();
    void loadSavedPlaces();
    if (!state.recording && !state.starting && !state.processing && !state.active && !state.queue.length && !state.creating) {
      void start();
    }
  }

  async function close() {
    if (state.starting) {
      state.startToken += 1;
      state.starting = false;
      cleanupRecordingHandles();
      resetSession();
    } else if (state.recording) {
      cancelRecording();
    }
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
    state.starting = false;
    state.level = 0;
    state.peak = 0;
    state.startedAt = 0;
    state.stoppedAt = 0;
    state.lastVoiceAt = 0;
    state.hasVoice = false;
    state.workspaceId = null;
  }

  async function loadSavedPlaces() {
    if (!options.placesApi?.list) return state.savedPlaces;
    try {
      const data = await options.placesApi.list();
      state.savedPlaces = Array.isArray(data.places) ? data.places : [];
      state.candidateRenderSignature = '';
      render();
    } catch (error) {
      console.warn('[BrainDump] failed to load saved places', error);
    }
    return state.savedPlaces;
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
    state.starting = false;
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
    if (state.recording || state.starting || state.processing || state.active || state.queue.length || state.creating) return;
    const canUseWebRecorder = Boolean(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
    if (!canUseWebRecorder && !hasNativeAudioBridge()) {
      state.error = t('braindump.error.unsupported');
      render();
      return;
    }
    resetSession();
    state.workspaceId = currentWorkspaceId();
    const startToken = state.startToken + 1;
    state.startToken = startToken;
    state.starting = true;
    render();
    try {
      if (!canUseWebRecorder) {
        startNativeAudioRecording();
        return;
      }
      try {
        const stream = await getMicrophoneStream();
        const modalActive = document.getElementById('braindump-modal')?.classList.contains('active');
        if (startToken !== state.startToken || !state.starting || !modalActive) {
          stream?.getTracks?.().forEach((track) => track.stop());
          return;
        }
        state.stream = stream;
      } catch (error) {
        if (!hasNativeAudioBridge()) throw error;
        const modalActive = document.getElementById('braindump-modal')?.classList.contains('active');
        if (startToken !== state.startToken || !state.starting || !modalActive) return;
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
      state.starting = false;
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
      state.starting = false;
      state.recording = false;
      cleanupRecordingHandles();
      render();
    }
  }

  function cancelRecording() {
    if (!state.recording) return;
    state.recording = false;
    state.starting = false;
    state.processing = false;
    state.processingPhase = '';
    if (state.requestTimer) clearInterval(state.requestTimer);
    state.requestTimer = null;
    if (state.nativeRecording) {
      try { nativeBridge.stopAudioRecording(); } catch {}
    } else {
      try { state.recorder?.removeEventListener('dataavailable', onChunk); } catch {}
      try { state.recorder?.removeEventListener('stop', cleanupRecordingHandles); } catch {}
      try { state.recorder?.stop(); } catch {}
    }
    cleanupRecordingHandles();
    resetSession();
    render();
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

  function currentWorkspaceId() {
    return typeof options.getCurrentWorkspaceId === 'function' ? options.getCurrentWorkspaceId() : null;
  }

  function activeWorkspaceId() {
    return state.workspaceId || currentWorkspaceId();
  }

  async function processSegment({ item, blob }) {
    const workspaceId = activeWorkspaceId();
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
          workspace_id: workspaceId ? Number(workspaceId) : null,
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

  function rawCandidateKey(candidate) {
    return [candidate.title, candidate.project_name, candidate.section_name, candidate.deadline, candidate.reminder, JSON.stringify(candidate.recurring_rule || null), JSON.stringify(candidate.location_reminder || null)].map((value) => String(value || '').trim()).join('|');
  }

  function candidateKey(candidate) {
    if (!candidate._bdId) {
      state.candidateIdCounter += 1;
      candidate._bdId = `bd-${state.candidateIdCounter}`;
    }
    return candidate._bdId;
  }

  function applyCandidates(candidates) {
    const previousByRawKey = new Map(state.candidates.map(candidate => [rawCandidateKey(candidate), candidate]));
    const nextCandidates = (Array.isArray(candidates) ? candidates : []).map((candidate) => {
      const next = { ...candidate };
      const previous = previousByRawKey.get(rawCandidateKey(candidate));
      if (previous?._bdId) next._bdId = previous._bdId;
      next.original_project_name = previous?.original_project_name ?? next.project_name ?? null;
      next.original_section_name = previous?.original_section_name ?? next.section_name ?? null;
      next.original_route_present = true;
      candidateKey(next);
      return next;
    });
    const previousSelected = state.selectedCandidateKeys;
    state.candidates = nextCandidates;
    state.selectedCandidateKeys = new Set(nextCandidates.map((candidate) => {
      const key = candidateKey(candidate);
      return previousSelected.size === 0 || previousSelected.has(key) ? key : null;
    }).filter(Boolean));
    state.candidateRenderSignature = '';
  }

  function candidateForCreate(candidate) {
    const { _bdId, ...clean } = candidate;
    if (clean.location_reminder) {
      const location = clean.location_reminder;
      clean.location_reminder = {
        trigger_type: location.trigger_type === 'departure' ? 'departure' : 'arrival',
        place_id: location.place_id || null,
        place_name: location.place_name || null,
      };
    }
    return clean;
  }

  function selectedCandidates() {
    return state.candidates
      .filter((candidate) => state.selectedCandidateKeys.has(candidateKey(candidate)))
      .map(candidateForCreate);
  }

  function toggleAllCandidates() {
    const allSelected = state.candidates.length && selectedCandidates().length === state.candidates.length;
    state.selectedCandidateKeys = allSelected ? new Set() : new Set(state.candidates.map(candidateKey));
    render();
  }

  function findCandidate(key) {
    return state.candidates.find(candidate => candidateKey(candidate) === key);
  }

  function updateCandidateField(field, { rerender = true } = {}) {
    const candidate = findCandidate(field.getAttribute('data-bd-candidate-key'));
    const name = field.getAttribute('data-bd-field');
    if (!candidate || !name) return;
    if (name === 'deadline' || name === 'reminder') {
      candidate[name] = dateTimeLocalToIso(field.value);
    } else if (name === 'recurring_frequency') {
      const frequency = field.value || 'none';
      candidate.recurring_rule = frequency === 'none' ? null : normalizeRecurringRule({
        ...(candidate.recurring_rule || {}),
        frequency,
        interval: candidate.recurring_rule?.interval || 1,
      });
    } else if (name === 'recurring_interval') {
      const interval = Math.max(1, Math.min(999, Number.parseInt(field.value || '1', 10) || 1));
      field.value = String(interval);
      const frequency = candidate.recurring_rule?.frequency || 'daily';
      candidate.recurring_rule = normalizeRecurringRule({ frequency, interval });
    } else if (name === 'location_place_id') {
      const placeId = field.value || '';
      if (!placeId) {
        candidate.location_reminder = null;
      } else {
        const place = state.savedPlaces.find(item => String(item.id) === String(placeId));
        candidate.location_reminder = {
          ...(candidate.location_reminder || {}),
          trigger_type: candidate.location_reminder?.trigger_type || 'arrival',
          place_id: place ? Number(place.id) : Number(placeId),
          place_name: place?.name || candidate.location_reminder?.place_name || null,
          enabled: true,
          source: 'braindump',
        };
      }
    } else if (name === 'location_trigger_type') {
      if (!candidate.location_reminder) candidate.location_reminder = { trigger_type: 'arrival', enabled: true, source: 'braindump' };
      candidate.location_reminder.trigger_type = field.value === 'departure' ? 'departure' : 'arrival';
    } else {
      candidate[name] = field.value || null;
    }
    if (name === 'project_name') candidate.section_name = null;
    state.candidateRenderSignature = '';
    if (rerender) render();
  }

  function toggleCandidateEditor(key) {
    closeOpenDropdown('braindump-edit-toggle');
    state.editingCandidateKey = state.editingCandidateKey === key ? '' : (key || '');
    state.candidateRenderSignature = '';
    render();
  }

  async function createSelectedTodos() {
    closeOpenDropdown('braindump-create');
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
        body: JSON.stringify({ candidates, workspace_id: activeWorkspaceId() ? Number(activeWorkspaceId()) : null }),
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
    const transcriptSection = document.getElementById('braindump-transcript-section');
    const stage = document.getElementById('braindump-stage');
    const processing = document.getElementById('braindump-processing');
    const processingText = document.getElementById('braindump-processing-text');
    const orb = document.getElementById('braindump-orb');
    const wave = document.getElementById('braindump-wave');
    const selectedCount = selectedCandidates().length;
    const isBusy = state.processing || state.active || state.queue.length;
    const visualLevel = state.recording ? Math.max(0.08, state.level) : (isBusy ? 0.16 : 0.08);
    const visualPeak = state.recording ? Math.max(0.10, state.peak) : (isBusy ? 0.18 : 0.10);
    modal.classList.toggle('is-recording', state.recording);
    modal.classList.toggle('is-starting', state.starting);
    modal.classList.toggle('is-processing', isBusy);
    stage?.style.setProperty('--bd-level', String(visualLevel));
    stage?.style.setProperty('--bd-peak', String(visualPeak));
    if (wave) {
      Array.from(wave.children).forEach((bar, index) => {
        const phase = (performance.now() / (isBusy && !state.recording ? 260 : 180)) + index * 0.7;
        const wobble = isBusy && !state.recording
          ? 0.55 + Math.abs(Math.sin(phase)) * 0.45
          : 0.25 + Math.abs(Math.sin(phase)) * 0.75;
        const baseHeight = isBusy && !state.recording ? 14 : 12;
        const range = isBusy && !state.recording ? 28 : 64;
        bar.style.setProperty('--h', String(baseHeight + Math.round(range * visualLevel * wobble)));
      });
    }
    if (status) {
      status.textContent = state.starting
        ? t('braindump.status.starting')
        : state.recording
          ? t('braindump.status.listening', { seconds: elapsed.toFixed(1) })
          : state.processing || state.active || state.queue.length
            ? t('braindump.status.processing')
            : state.candidates.length
              ? t('braindump.status.readyWithCandidates')
              : t('braindump.status.ready');
    }
    if (processing) processing.hidden = !isBusy || state.recording;
    if (processingText) {
      processingText.textContent = state.transcript
        ? t('braindump.processing.extracting')
        : t('braindump.processing.transcribing');
    }
    if (hint) {
      const silenceLeft = state.recording && state.hasVoice ? Math.max(0, (SILENCE_STOP_MS - (performance.now() - state.lastVoiceAt)) / 1000) : null;
      hint.textContent = state.starting
        ? t('braindump.hint.starting')
        : state.recording
          ? (silenceLeft == null ? t('braindump.hint.recording') : t('braindump.hint.silence', { seconds: silenceLeft.toFixed(1) }))
          : isBusy
            ? t('braindump.hint.processing')
            : t('braindump.hint.idle');
    }
    if (orb && !orb.innerHTML.trim()) orb.innerHTML = iconSvg('sparkles');
    if (recordBtn) {
      recordBtn.hidden = state.starting || !state.recording || state.processing || state.candidates.length > 0;
      recordBtn.textContent = t('braindump.record.finish');
    }
    if (retryBtn) retryBtn.hidden = state.starting || state.recording || state.processing || (!state.candidates.length && !state.error && !state.transcript);
    if (createBtn) {
      createBtn.hidden = !state.candidates.length;
      createBtn.disabled = state.creating || state.starting || state.recording || state.processing || !selectedCount;
      createBtn.classList.toggle('is-muted', createBtn.disabled || !selectedCount);
      createBtn.textContent = state.creating ? t('braindump.create.busy') : t('braindump.create.count', { count: selectedCount });
    }
    if (results) results.hidden = !state.candidates.length;
    if (error) {
      error.hidden = !state.error;
      error.textContent = state.error;
    }
    if (transcriptSection) transcriptSection.hidden = !state.transcript;
    if (transcript) {
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
      candidates: state.candidates.map(candidate => [candidateKey(candidate), rawCandidateKey(candidate)].join(':')),
      selected: Array.from(state.selectedCandidateKeys).sort(),
      projectOptions: getProjectOptions().map(project => `${project.id}:${project.name}`).join('|'),
      sectionOptions: (typeof options.getSections === 'function' ? options.getSections() : []).map(section => `${section.project_id}:${section.name}`).join('|'),
      places: state.savedPlaces.map(place => `${place.id}:${place.name}`).join('|'),
      editing: state.editingCandidateKey,
      language: document.documentElement.lang || '',
    });
    if (signature === state.candidateRenderSignature) return;
    state.candidateRenderSignature = signature;
    container.innerHTML = renderCandidateGroups();
    hydrateCandidateSelects(container);
  }

  function hydrateCandidateSelects(container) {
    container.querySelectorAll('select[data-bd-field]').forEach(select => {
      const projectSelect = select.matches('[data-project-select]');
      hydrateSelect(select, {
        className: projectSelect ? 'braindump-ui-select project-ui-select' : 'braindump-ui-select',
        menuClassName: projectSelect ? 'braindump-ui-select-menu project-ui-select-menu' : 'braindump-ui-select-menu',
        ...(projectSelect ? { searchPlaceholder: t('focus.projects.search'), searchLabel: t('focus.projects.search'), emptyText: t('focus.projects.noMatches') } : {}),
      });
      refreshSelect(select);
    });
  }

  function getProjectOptions() {
    const workspaceId = activeWorkspaceId();
    const projects = (typeof options.getProjects === 'function' ? options.getProjects() : [])
      .filter(project => project && !project.archived)
      .filter(project => !workspaceId || String(project.workspace_id || '') === String(workspaceId));
    const projectMap = new Map();
    projects.forEach(project => projectMap.set(project.id, { ...project, children: [] }));
    const roots = [];
    projectMap.forEach(project => {
      const parent = projectMap.get(project.parent_id);
      if (parent && !project.is_shared) parent.children.push(project);
      else roots.push(project);
    });
    const sortProjects = (a, b) => {
      if (Boolean(a.is_inbox) !== Boolean(b.is_inbox)) return a.is_inbox ? 1 : -1;
      return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
    };
    const flattened = [];
    function addProject(project, depth = 0) {
      flattened.push({ ...project, _bdDepth: depth });
      project.children.sort(sortProjects).forEach(child => addProject(child, depth + 1));
    }
    roots.sort(sortProjects).forEach(project => addProject(project));
    return flattened;
  }

  function getProjectByName(name) {
    const normalized = String(name || '').trim().toLowerCase();
    if (!normalized) return null;
    return getProjectOptions().find(project => String(project.name || '').trim().toLowerCase() === normalized) || null;
  }

  function getSectionOptionsForProject(projectName) {
    const sections = typeof options.getSections === 'function' ? options.getSections() : [];
    const project = getProjectByName(projectName);
    if (!project) return [];
    return sections
      .filter(section => String(section.project_id || '') === String(project.id))
      .slice()
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
  }

  function candidateProjectLabel(candidate) {
    return candidate.project_name || t('braindump.route.inbox');
  }

  function groupedCandidates() {
    const byProject = new Map();
    state.candidates.forEach((candidate, index) => {
      const project = candidateProjectLabel(candidate);
      if (!byProject.has(project)) byProject.set(project, { project, inbox: !candidate.project_name, items: [] });
      byProject.get(project).items.push({ candidate, index });
    });
    return Array.from(byProject.values()).sort((a, b) => {
      if (a.inbox !== b.inbox) return a.inbox ? 1 : -1;
      return a.project.localeCompare(b.project, undefined, { sensitivity: 'base' });
    }).map(group => ({
      ...group,
      items: group.items.slice().sort((a, b) => {
        const sectionCompare = String(a.candidate.section_name || '').localeCompare(String(b.candidate.section_name || ''), undefined, { sensitivity: 'base' });
        return sectionCompare || a.index - b.index;
      }),
    }));
  }

  function renderCandidateGroups() {
    return groupedCandidates().map(group => `
      <section class="braindump-candidate-group" aria-label="${escapeHtmlAttr(group.project)}">
        <div class="braindump-candidate-group-head">
          <span>${escapeHtml(group.project)}</span>
          <small>${t(group.items.length === 1 ? 'braindump.group.count.one' : 'braindump.group.count.many', { count: group.items.length })}</small>
        </div>
        <div class="braindump-candidate-group-items">
          ${group.items.map(({ candidate, index }) => renderCandidate(candidate, index)).join('')}
        </div>
      </section>
    `).join('');
  }

  function renderProjectOptions(selectedName) {
    const selected = String(selectedName || '');
    const optionsHtml = [`<option value="">${escapeHtml(t('braindump.route.inbox'))}</option>`];
    getProjectOptions().forEach(project => {
      const name = String(project.name || '');
      const depth = Number(project._bdDepth || 0);
      optionsHtml.push(`<option value="${escapeHtmlAttr(name)}" data-depth="${depth}" data-project-color="${escapeHtmlAttr(project.color || '#6366f1')}" data-project-icon="${escapeHtmlAttr(project.icon || '')}" ${name === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`);
    });
    if (selected && !getProjectByName(selected)) optionsHtml.push(`<option value="${escapeHtmlAttr(selected)}" selected>${escapeHtml(selected)}</option>`);
    return optionsHtml.join('');
  }

  function renderSectionOptions(candidate) {
    const selected = String(candidate.section_name || '');
    const sections = getSectionOptionsForProject(candidate.project_name);
    const optionsHtml = [`<option value="">${escapeHtml(t('braindump.quickfix.noSection'))}</option>`];
    sections.forEach(section => {
      const name = String(section.name || '');
      optionsHtml.push(`<option value="${escapeHtmlAttr(name)}" ${name === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`);
    });
    if (selected && !sections.some(section => String(section.name || '') === selected)) optionsHtml.push(`<option value="${escapeHtmlAttr(selected)}" selected>${escapeHtml(selected)}</option>`);
    return optionsHtml.join('');
  }

  function renderRecurringOptions(candidate) {
    const selected = normalizeRecurringRule(candidate.recurring_rule)?.frequency || 'none';
    return ['none', 'daily', 'weekly', 'monthly', 'yearly'].map(frequency => {
      const label = frequency === 'none' ? t('todo.recurring.none') : t(`todo.recurring.${frequency}`);
      return `<option value="${frequency}" ${frequency === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
  }

  function locationReminderLabel(locationReminder) {
    if (!locationReminder) return '';
    const triggerKey = locationReminder.trigger_type === 'departure' ? 'todo.location.departureShort' : 'todo.location.arrivalShort';
    const savedPlace = state.savedPlaces.find(place => String(place.id || '') === String(locationReminder.place_id || ''));
    const place = locationReminder.place_name || savedPlace?.name || locationReminder.address || t('todo.location.title');
    return `${t(triggerKey)}: ${place}`;
  }

  function renderCandidateMetaChips({ route, due, reminder, recurrence, location }) {
    return [
      route ? `<span class="todo-meta-chip braindump-route">${iconSvg('folder')} ${escapeHtml(route)}</span>` : '',
      due ? `<span class="todo-meta-chip todo-due">${iconSvg('calendar')} ${escapeHtml(t('braindump.meta.due', { date: due }))}</span>` : '',
      reminder ? `<span class="todo-meta-chip todo-reminder">${iconSvg('bell')} ${escapeHtml(t('braindump.meta.reminder', { date: reminder }))}</span>` : '',
      recurrence ? `<span class="todo-meta-chip todo-recurring">${iconSvg('repeat')} ${escapeHtml(recurrence)}</span>` : '',
      location ? `<span class="todo-meta-chip todo-location" title="${escapeHtmlAttr(t('todo.location.androidOnlyPillTitle'))}">${iconSvg('map-pin')} ${escapeHtml(location)}</span>` : '',
    ].filter(Boolean).join('');
  }

  function renderLocationPlaceOptions(candidate) {
    const selected = String(candidate.location_reminder?.place_id || '');
    const optionsHtml = [`<option value="">${escapeHtml(t('braindump.location.none'))}</option>`];
    state.savedPlaces.forEach(place => {
      const id = String(place.id || '');
      optionsHtml.push(`<option value="${escapeHtmlAttr(id)}" ${id === selected ? 'selected' : ''}>${escapeHtml(place.name || '')}</option>`);
    });
    if (selected && !state.savedPlaces.some(place => String(place.id || '') === selected)) {
      optionsHtml.push(`<option value="${escapeHtmlAttr(selected)}" selected>${escapeHtml(candidate.location_reminder?.place_name || selected)}</option>`);
    }
    return optionsHtml.join('');
  }

  function renderLocationTriggerOptions(candidate) {
    const selected = candidate.location_reminder?.trigger_type === 'departure' ? 'departure' : 'arrival';
    return ['arrival', 'departure'].map(trigger => `<option value="${trigger}" ${trigger === selected ? 'selected' : ''}>${escapeHtml(t(`todo.location.${trigger}`))}</option>`).join('');
  }

  function renderCandidate(candidate, index) {
    const key = candidateKey(candidate);
    const checked = state.selectedCandidateKeys.has(key) ? 'checked' : '';
    const isEditing = state.editingCandidateKey === key;
    const checkboxId = `braindump-candidate-${key}`;
    const route = [candidate.project_name, candidate.section_name].filter(Boolean).join(' / ') || t('braindump.route.inbox');
    const due = candidate.deadline ? formatDate(candidate.deadline) : '';
    const reminder = candidate.reminder ? formatDate(candidate.reminder) : '';
    const recurrence = recurringLabel(candidate.recurring_rule);
    const location = locationReminderLabel(candidate.location_reminder);
    const meta = renderCandidateMetaChips({ route, due, reminder, recurrence, location });
    return `
      <div class="braindump-candidate-card todo-item ${isEditing ? 'is-editing' : ''}" style="--bd-delay:${Math.min(index, 8) * 55}ms">
        <input id="${escapeHtmlAttr(checkboxId)}" type="checkbox" data-bd-candidate-key="${escapeHtmlAttr(key)}" ${checked}>
        <label class="todo-check braindump-check" for="${escapeHtmlAttr(checkboxId)}">${checked ? iconSvg('check') : ''}</label>
        <span class="todo-body has-meta">
          <span class="todo-main">
            <span class="todo-title">${escapeHtml(candidate.title || '')}</span>
            <button class="braindump-edit-candidate" type="button" data-bd-action="edit" data-bd-candidate-key="${escapeHtmlAttr(key)}" aria-expanded="${isEditing ? 'true' : 'false'}" aria-label="${escapeHtmlAttr(t(isEditing ? 'braindump.quickfix.done' : 'braindump.quickfix.edit'))}" title="${escapeHtmlAttr(t(isEditing ? 'braindump.quickfix.done' : 'braindump.quickfix.edit'))}">${iconSvg('edit-3')}</button>
          </span>
          ${meta ? `<span class="todo-meta-row braindump-meta-row">${meta}</span>` : ''}
          ${isEditing ? `
            <span class="braindump-quickfix-panel">
              <label class="braindump-quickfix-field braindump-quickfix-title-field">
                <span>${escapeHtml(t('braindump.quickfix.title'))}</span>
                <input class="braindump-title-input" type="text" value="${escapeHtmlAttr(candidate.title || '')}" data-bd-candidate-key="${escapeHtmlAttr(key)}" data-bd-field="title">
              </label>
              <div class="braindump-quickfix-field">
                <span id="braindump-project-label-${escapeHtmlAttr(key)}">${escapeHtml(t('braindump.quickfix.project'))}</span>
                <select data-ui-select data-project-select class="braindump-field" data-bd-candidate-key="${escapeHtmlAttr(key)}" data-bd-field="project_name" aria-labelledby="braindump-project-label-${escapeHtmlAttr(key)}">${renderProjectOptions(candidate.project_name)}</select>
              </div>
              <div class="braindump-quickfix-field">
                <span id="braindump-section-label-${escapeHtmlAttr(key)}">${escapeHtml(t('braindump.quickfix.section'))}</span>
                <select data-ui-select class="braindump-field" data-bd-candidate-key="${escapeHtmlAttr(key)}" data-bd-field="section_name" aria-labelledby="braindump-section-label-${escapeHtmlAttr(key)}" ${candidate.project_name ? '' : 'disabled'}>${renderSectionOptions(candidate)}</select>
              </div>
              <label class="braindump-quickfix-field">
                <span>${escapeHtml(t('todo.deadline'))}</span>
                <input class="braindump-field" type="datetime-local" value="${escapeHtmlAttr(isoToDateTimeLocal(candidate.deadline))}" data-bd-candidate-key="${escapeHtmlAttr(key)}" data-bd-field="deadline">
              </label>
              <label class="braindump-quickfix-field">
                <span>${escapeHtml(t('todo.reminder'))}</span>
                <input class="braindump-field" type="datetime-local" value="${escapeHtmlAttr(isoToDateTimeLocal(candidate.reminder))}" data-bd-candidate-key="${escapeHtmlAttr(key)}" data-bd-field="reminder">
              </label>
              <div class="braindump-quickfix-field">
                <span id="braindump-recurring-label-${escapeHtmlAttr(key)}">${escapeHtml(t('todo.recurring'))}</span>
                <select data-ui-select class="braindump-field" data-bd-candidate-key="${escapeHtmlAttr(key)}" data-bd-field="recurring_frequency" aria-labelledby="braindump-recurring-label-${escapeHtmlAttr(key)}">${renderRecurringOptions(candidate)}</select>
              </div>
              <label class="braindump-quickfix-field ${candidate.recurring_rule ? '' : 'is-disabled'}">
                <span>${escapeHtml(t('todo.recurring.interval'))}</span>
                <input class="braindump-field" type="number" min="1" max="999" step="1" value="${escapeHtmlAttr(normalizeRecurringRule(candidate.recurring_rule)?.interval || 1)}" data-bd-candidate-key="${escapeHtmlAttr(key)}" data-bd-field="recurring_interval" ${candidate.recurring_rule ? '' : 'disabled'}>
              </label>
              <div class="braindump-quickfix-field">
                <span id="braindump-location-place-label-${escapeHtmlAttr(key)}">${escapeHtml(t('braindump.location.place'))}</span>
                <select data-ui-select class="braindump-field" data-bd-candidate-key="${escapeHtmlAttr(key)}" data-bd-field="location_place_id" aria-labelledby="braindump-location-place-label-${escapeHtmlAttr(key)}">${renderLocationPlaceOptions(candidate)}</select>
              </div>
              <div class="braindump-quickfix-field ${candidate.location_reminder ? '' : 'is-disabled'}">
                <span id="braindump-location-trigger-label-${escapeHtmlAttr(key)}">${escapeHtml(t('todo.location.trigger'))}</span>
                <select data-ui-select class="braindump-field" data-bd-candidate-key="${escapeHtmlAttr(key)}" data-bd-field="location_trigger_type" aria-labelledby="braindump-location-trigger-label-${escapeHtmlAttr(key)}" ${candidate.location_reminder ? '' : 'disabled'}>${renderLocationTriggerOptions(candidate)}</select>
              </div>
            </span>
          ` : ''}
        </span>
      </div>
    `;
  }

  return { init, open };
}

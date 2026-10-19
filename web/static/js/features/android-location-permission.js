export function createAndroidLocationPermissionFlow({ nativeBridge, promptUser, cancelPrompt = () => {} }) {
  let promptInFlight = null;
  let permissionGeneration = 0;

  async function ensurePermission(required = false) {
    if (!required) return true;
    const generation = permissionGeneration;
    const state = String(await nativeBridge?.locationPermissionGuidanceState?.() || 'unsupported');
    if (generation !== permissionGeneration) return false;
    if (state === 'granted') return true;
    if (state === 'declined' || state === 'unsupported') return false;
    if (promptInFlight) return promptInFlight;

    promptInFlight = (async () => {
      const optionLabel = String(await nativeBridge?.backgroundLocationPermissionOptionLabel?.() || '');
      if (generation !== permissionGeneration) return false;
      const mode = String(await nativeBridge?.backgroundLocationPermissionMode?.() || 'unsupported');
      if (generation !== permissionGeneration) return false;
      const choice = await promptUser(state, optionLabel, mode);
      if (generation !== permissionGeneration) return false;
      if (choice !== 'continue') {
        await nativeBridge?.declineLocationPermissionGuidance?.();
        return false;
      }
      const requested = String(await nativeBridge?.requestLocationPermission?.() || state);
      return generation === permissionGeneration && requested === 'granted';
    })().finally(() => {
      promptInFlight = null;
    });

    return promptInFlight;
  }

  function cancelPending() {
    permissionGeneration += 1;
    cancelPrompt();
  }

  return { ensurePermission, cancelPending };
}

export function createNativeReminderSnapshotState() {
  let accepted = false;
  let latestTodos = [];

  function accept(todos, { authoritative = true } = {}) {
    const normalized = Array.isArray(todos) ? todos : [];
    if (!authoritative && normalized.length === 0) return false;
    latestTodos = normalized;
    accepted = true;
    return true;
  }

  return {
    accept,
    hasSnapshot: () => accepted,
    todos: () => latestTodos,
  };
}

export async function scheduleAndroidLocationReminders({
  nativeBridge,
  reminders,
  ensurePermission,
  isCurrent = () => true,
  warn = console.warn,
}) {
  const schedules = Array.isArray(reminders) ? reminders : [];
  if (!isCurrent()) return 0;
  let count = Number(await nativeBridge?.scheduleLocationReminders?.(schedules)) || 0;
  if (!isCurrent()) return count;
  if (!schedules.length) return count;
  const granted = await ensurePermission(true);
  if (!isCurrent()) return count;
  if (!granted || count >= schedules.length) return count;
  count = Number(await nativeBridge?.scheduleLocationReminders?.(schedules)) || 0;
  if (!isCurrent()) return count;
  if (count < schedules.length) {
    warn('[Native] Some location reminders were not scheduled', { scheduledLocations: count, expected: schedules.length });
  }
  return count;
}

export function createAndroidLocationPermissionPrompt({
  document = globalThis.document,
  translate,
  openLayer,
  registerLayer,
  requestCloseLayer,
}) {
  const layerId = 'android-location-permission-modal';
  let pendingResolve = null;
  let bound = false;

  function settle(choice = 'decline') {
    const modal = document?.getElementById?.(layerId);
    modal?.classList?.remove?.('active');
    modal?.setAttribute?.('aria-hidden', 'true');
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve?.(choice);
  }

  function close(choice = 'decline') {
    if (!pendingResolve) return;
    const requested = requestCloseLayer?.(layerId, { reason: 'permission-choice', choice });
    if (!requested) settle(choice);
  }

  function bind() {
    if (bound) return;
    bound = true;
    registerLayer?.(layerId, payload => settle(payload?.choice || 'decline'));
    document?.getElementById?.('android-location-permission-decline')?.addEventListener?.('click', () => close('decline'));
    document?.getElementById?.('android-location-permission-continue')?.addEventListener?.('click', () => close('continue'));
    document?.getElementById?.(layerId)?.querySelector?.('.modal-overlay')?.addEventListener?.('click', () => close('decline'));
    document?.addEventListener?.('keydown', (event) => {
      if (event.key !== 'Escape' || !pendingResolve) return;
      event.preventDefault?.();
      close('decline');
    });
  }

  function show(state, nativeOptionLabel = '', mode = 'settings') {
    if (pendingResolve) return Promise.resolve('decline');
    const modal = document?.getElementById?.(layerId);
    const message = document?.getElementById?.('android-location-permission-message');
    const continueButton = document?.getElementById?.('android-location-permission-continue');
    if (!modal || !message || !continueButton) return Promise.resolve('decline');
    bind();
    const option = nativeOptionLabel || translate('todo.location.permission.optionLabel');
    let messageKey = 'todo.location.permission.body';
    if (mode === 'runtime_prompt') {
      messageKey = state === 'foreground_only'
        ? 'todo.location.permission.runtimeBody'
        : 'todo.location.permission.bodyRuntime';
    } else if (mode === 'legacy') {
      messageKey = 'todo.location.permission.bodyLegacy';
    } else if (state === 'foreground_only') {
      messageKey = 'todo.location.permission.backgroundBody';
    }
    message.textContent = translate(messageKey, { option });
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    openLayer?.(layerId);
    continueButton.focus();
    return new Promise((resolve) => { pendingResolve = resolve; });
  }

  return { bind, show, close };
}

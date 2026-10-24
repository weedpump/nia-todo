export function createAndroidLocationPermissionFlow({ nativeBridge, promptUser, declinePermission }) {
  let promptInFlight = null;

  async function ensurePermission(required = false) {
    if (!required) return true;
    const state = String(await nativeBridge?.locationPermissionGuidanceState?.() || 'unsupported');
    if (state === 'granted') return true;
    if (state === 'unsupported') return false;
    if (promptInFlight) return promptInFlight;

    promptInFlight = (async () => {
      const optionLabel = String(await nativeBridge?.backgroundLocationPermissionOptionLabel?.() || '');
      const mode = String(await nativeBridge?.backgroundLocationPermissionMode?.() || 'unsupported');
      const choice = await promptUser(state, optionLabel, mode);
      if (choice !== 'continue') {
        if (choice !== 'decline') return false;
        await declinePermission?.();
        return false;
      }
      const requested = String(await nativeBridge?.requestLocationPermission?.() || state);
      return requested === 'granted';
    })().finally(() => {
      promptInFlight = null;
    });

    return promptInFlight;
  }

  return { ensurePermission };
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
  warn = console.warn,
}) {
  const schedules = Array.isArray(reminders) ? reminders : [];
  let count = Number(await nativeBridge?.scheduleLocationReminders?.(schedules)) || 0;
  if (!schedules.length) return count;
  const granted = await ensurePermission(true);
  if (!granted || count >= schedules.length) return count;
  count = Number(await nativeBridge?.scheduleLocationReminders?.(schedules)) || 0;
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

  function settle(choice = 'dismiss') {
    const modal = document?.getElementById?.(layerId);
    modal?.classList?.remove?.('active');
    modal?.setAttribute?.('aria-hidden', 'true');
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve?.(choice);
  }

  function close(choice = 'dismiss') {
    if (!pendingResolve) return;
    const requested = requestCloseLayer?.(layerId, { reason: 'permission-choice', choice });
    if (!requested) settle(choice);
  }

  function bind() {
    if (bound) return;
    bound = true;
    registerLayer?.(layerId, payload => settle(payload?.choice || 'dismiss'));
    document?.getElementById?.('android-location-permission-decline')?.addEventListener?.('click', () => close('decline'));
    document?.getElementById?.('android-location-permission-continue')?.addEventListener?.('click', () => close('continue'));
    document?.getElementById?.(layerId)?.querySelector?.('.modal-overlay')?.addEventListener?.('click', () => close('dismiss'));
    document?.addEventListener?.('keydown', (event) => {
      if (event.key !== 'Escape' || !pendingResolve) return;
      event.preventDefault?.();
      close('dismiss');
    });
  }

  function show(state, nativeOptionLabel = '', mode = 'settings') {
    if (pendingResolve) return Promise.resolve('dismiss');
    const modal = document?.getElementById?.(layerId);
    const message = document?.getElementById?.('android-location-permission-message');
    const continueButton = document?.getElementById?.('android-location-permission-continue');
    if (!modal || !message || !continueButton) return Promise.resolve('dismiss');
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

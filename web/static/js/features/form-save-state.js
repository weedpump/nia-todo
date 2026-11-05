function snapshot(value) {
  return JSON.stringify(value);
}

export function createFormSaveState({ form, button, readState, isValid = () => true, canSubmit = () => true, isActive = () => true } = {}) {
  if (!form || !button || typeof readState !== 'function') {
    throw new TypeError('form, button and readState are required');
  }
  let baseline = null;

  function canSave() {
    if (!isActive()) return false;
    const state = readState();
    return Boolean(canSubmit(state)) && Boolean(isValid(state)) && baseline !== snapshot(state);
  }

  function refresh() {
    if (!isActive()) return false;
    const enabled = canSave();
    button.hidden = !enabled;
    button.disabled = !enabled;
    return enabled;
  }

  function reset() {
    baseline = snapshot(readState());
    refresh();
  }

  function handleChange() {
    refresh();
  }

  form.addEventListener('input', handleChange);
  form.addEventListener('change', handleChange);

  return {
    button,
    canSave,
    refresh,
    reset,
    destroy() {
      form.removeEventListener('input', handleChange);
      form.removeEventListener('change', handleChange);
    },
  };
}

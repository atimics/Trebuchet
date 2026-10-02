function notify(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  $('#toastStack').appendChild(toast);
  setTimeout(() => toast.remove(), 2600);
}

function updateResultLabel(result = state.updateCheck.lastResult) {
  if (state.updateCheck.checking) return { label: 'Checking', className: 'warn' };
  if (!result) return { label: state.updateCheck.available ? 'Ready' : 'Local app', className: state.updateCheck.available ? '' : 'warn' };
  if (result.status === 'available') return { label: 'Update', className: 'warn' };
  if (result.status === 'current') return { label: 'Current', className: '' };
  if (result.status === 'no-asset') return { label: 'Manual', className: 'warn' };
  if (result.status === 'error') return { label: 'Failed', className: 'danger' };
  return { label: 'Review', className: 'warn' };
}

function updateResultDetail(result = state.updateCheck.lastResult) {
  if (state.updateCheck.checking) return 'Checking for a newer version…';
  if (!result) {
    return state.updateCheck.available
      ? 'Not checked yet.'
      : 'Update checks need the Trebuchet desktop app.';
  }
  if (result.status === 'available') {
    return `Version v${result.latest || '?'} is available${result.downloadFilename ? ` / ${result.downloadFilename}` : ''}.`;
  }
  if (result.status === 'current') return `You're running the latest version: v${result.current || state.appVersion || '?'}.`;
  if (result.status === 'no-asset') return `Version v${result.latest || '?'} is available, but no matching installer was found for this machine.`;
  if (result.status === 'error') return result.message || 'Update check failed.';
  return 'Unexpected update-check response; use the release page for manual verification.';
}

function releaseTrustSummary(trust = state.releaseTrust) {
  const record = trust && typeof trust === 'object' ? trust : {};
  const label = record.label || record.status || 'Signing unknown';
  const signing = record.signingStatus || 'unknown';
  const notarization = record.notarizationStatus || 'unknown';
  const unsafe = /unsigned|unknown/i.test(`${label} ${signing}`)
    || /not-notarized|unknown/i.test(String(notarization));
  return {
    label,
    detail: record.detail || 'Check the release notes before installing this build.',
    className: unsafe ? 'warn' : '',
  };
}

function applyUpdateResult(info = {}) {
  if (!info || typeof info !== 'object') return;
  state.updateCheck = {
    ...state.updateCheck,
    checking: false,
    lastResult: info,
    lastCheckedAt: new Date().toISOString(),
    error: info.status === 'error' ? info.message || 'Update check failed' : null,
  };
  if (typeof info.checkOnStartup === 'boolean') {
    state.prefs.checkForUpdatesOnStartup = info.checkOnStartup;
  }
  if (info.releaseUrl) state.releaseUrl = info.releaseUrl;
  if (state.activeView === 'settings') renderSettings();
  const label = updateResultLabel(info);
  notify(label.label === 'Update' ? 'Update available' : updateResultDetail(info));
}

window.__showUpdateResult = applyUpdateResult;

function applySecretPinStatus(status = {}) {
  state.secretPin = {
    configured: status.configured === true,
    damaged: status.damaged === true,
    unlocked: status.unlocked === true,
    locked: status.locked === true,
    version: status.version || null,
    kdf: status.kdf || null,
    deviceSecretProtected: status.deviceSecretProtected === true,
    deviceSecretAvailable: status.deviceSecretAvailable !== false,
    busy: null,
  };
}

const RECOVERY_PIN_DAMAGED_MESSAGE = 'The Recovery PIN file is damaged. Do not set a new PIN: it would replace the old one. A backup is at .secretPin.json.bak if present.';
const RECOVERY_PIN_DEVICE_SECRET_MESSAGE = "This computer's keychain no longer holds the key for your Recovery PIN. Unlocking again will not help.";

function recoveryPinFailureMessage(error) {
  if (error?.code === 'BAD_SECRET_PIN') return 'Incorrect PIN';
  if (error?.code === 'SECRET_PIN_DEVICE_SECRET_UNAVAILABLE') return RECOVERY_PIN_DEVICE_SECRET_MESSAGE;
  if (error?.code === 'SECRET_PIN_STATE_DAMAGED') return RECOVERY_PIN_DAMAGED_MESSAGE;
  return error?.message || 'PIN check failed';
}

function secretPinMeta() {
  if (state.apiStatus !== 'connected') {
    return {
      label: 'Preview',
      className: 'warn',
      detail: 'Open through the Trebuchet desktop app.',
      primaryAction: 'retry-local-api',
      primaryLabel: 'Local app',
      disabled: true,
    };
  }
  if (state.secretPin.damaged) {
    return {
      label: 'Damaged',
      className: 'danger',
      detail: RECOVERY_PIN_DAMAGED_MESSAGE,
      primaryAction: 'retry-local-api',
      primaryLabel: 'Recheck',
      disabled: false,
    };
  }
  if (!state.secretPin.configured) {
    return {
      label: 'Not set',
      className: 'warn',
      detail: 'Launch wallets are protected by this device only.',
      primaryAction: 'setup-secret-pin',
      primaryLabel: 'Set PIN',
      disabled: false,
    };
  }
  if (state.secretPin.locked) {
    return {
      label: 'Locked',
      className: 'danger',
      detail: 'Saved wallet and Vanity CA secrets need PIN unlock.',
      primaryAction: 'unlock-secret-pin',
      primaryLabel: 'Unlock',
      disabled: false,
    };
  }
  return {
    label: 'Unlocked',
    className: '',
    detail: state.secretPin.deviceSecretProtected
      ? 'PIN and device secret active.'
      : 'PIN active; device secret is using local fallback.',
    primaryAction: 'lock-secret-pin',
    primaryLabel: 'Lock',
    disabled: false,
  };
}

function operatorPromptControl() {
  if (operatorPromptConfig?.hideInput) return null;
  return operatorPromptConfig?.multiline ? $('#operatorPromptTextarea') : $('#operatorPromptInput');
}

function focusableDialogElements(root) {
  if (!root) return [];
  return $$('button:not([disabled]), input:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])', root)
    .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}

function trapDialogFocus(event, root) {
  if (event.key !== 'Tab') return false;
  const focusable = focusableDialogElements(root);
  if (!focusable.length) return false;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

function restoreDialogFocus(element) {
  if (element?.isConnected && typeof element.focus === 'function') {
    window.requestAnimationFrame(() => element.focus());
  }
}

function setOperatorPromptMessage(message, { error = false } = {}) {
  const messageNode = $('#operatorPromptMessage');
  if (messageNode) {
    messageNode.textContent = message || '';
    messageNode.classList.toggle('is-error', error);
  }
  const control = operatorPromptControl();
  if (error) control?.setAttribute('aria-invalid', 'true');
  else control?.removeAttribute('aria-invalid');
}

function closeOperatorPrompt(value = null) {
  const gate = $('#operatorPromptGate');
  if (gate) {
    gate.hidden = true;
    gate.setAttribute('aria-hidden', 'true');
    gate.removeAttribute('data-danger');
    gate.removeAttribute('data-readonly');
  }
  ['#operatorPromptInput', '#operatorPromptTextarea'].forEach((selector) => {
    const control = $(selector);
    if (!control) return;
    control.value = '';
    control.removeAttribute('aria-invalid');
  });
  document.body.classList.remove('operator-prompt-open');
  $('.operator-prompt-field')?.removeAttribute('hidden');
  const resolve = operatorPromptResolver;
  const returnFocus = operatorPromptReturnFocus;
  operatorPromptResolver = null;
  operatorPromptConfig = null;
  operatorPromptReturnFocus = null;
  if (resolve) resolve(value);
  restoreDialogFocus(returnFocus);
}

function submitOperatorPrompt() {
  const gate = $('#operatorPromptGate');
  if (!gate || gate.hidden || !operatorPromptConfig) return;
  const control = operatorPromptControl();
  const rawValue = String(control?.value || '');
  const value = operatorPromptConfig.trim === false ? rawValue : rawValue.trim();
  if (operatorPromptConfig.required !== false && !value) {
    setOperatorPromptMessage(operatorPromptConfig.emptyMessage || 'Enter a value to continue.', { error: true });
    control?.focus();
    return;
  }
  const validationMessage = typeof operatorPromptConfig.validate === 'function'
    ? operatorPromptConfig.validate(value)
    : null;
  if (validationMessage) {
    setOperatorPromptMessage(validationMessage, { error: true });
    control?.focus();
    return;
  }
  closeOperatorPrompt(value);
}

function openOperatorPrompt(options = {}) {
  const gate = $('#operatorPromptGate');
  if (!gate) return Promise.resolve(null);
  if (operatorPromptResolver) closeOperatorPrompt(null);

  operatorPromptConfig = {
    multiline: options.multiline === true,
    hideInput: options.hideInput === true,
    readOnly: options.readOnly === true,
    required: options.hideInput === true ? false : options.required !== false,
    trim: options.trim !== false,
    validate: options.validate,
    emptyMessage: options.emptyMessage,
    message: options.message || '',
  };

  $('#operatorPromptEyebrow').textContent = options.eyebrow || 'Operator confirmation';
  $('#operatorPromptTitle').textContent = options.title || 'Confirm action';
  $('#operatorPromptDetail').textContent = options.detail || 'Enter the requested value to continue.';
  $('#operatorPromptLabel').textContent = options.label || 'Value';
  $('#operatorPromptSubmitLabel').textContent = options.confirmLabel || (options.readOnly ? 'Done' : 'Continue');
  $('#operatorPromptCancel').textContent = options.cancelLabel || 'Cancel';

  const input = $('#operatorPromptInput');
  const textarea = $('#operatorPromptTextarea');
  const control = operatorPromptConfig.multiline ? textarea : input;
  const field = $('.operator-prompt-field');
  field.htmlFor = control.id;
  field.toggleAttribute('hidden', operatorPromptConfig.hideInput);
  input.hidden = operatorPromptConfig.hideInput || operatorPromptConfig.multiline;
  textarea.hidden = operatorPromptConfig.hideInput || !operatorPromptConfig.multiline;
  input.type = options.type === 'password' ? 'password' : 'text';
  input.inputMode = options.inputMode || 'text';
  input.removeAttribute('maxlength');
  if (Number(options.maxLength) > 0) input.maxLength = Number(options.maxLength);
  control.value = String(options.value || '');
  control.placeholder = options.placeholder || '';
  control.readOnly = operatorPromptConfig.readOnly;
  control.setAttribute('aria-label', options.label || 'Value');
  control.removeAttribute('aria-invalid');

  const submit = $('#operatorPromptSubmit');
  submit.classList.toggle('danger', options.danger === true);
  gate.dataset.danger = options.danger === true ? 'true' : 'false';
  gate.dataset.readonly = operatorPromptConfig.readOnly ? 'true' : 'false';
  setOperatorPromptMessage(operatorPromptConfig.message);
  gate.hidden = false;
  gate.setAttribute('aria-hidden', 'false');
  document.body.classList.add('operator-prompt-open');
  operatorPromptReturnFocus = document.activeElement;

  return new Promise((resolve) => {
    operatorPromptResolver = resolve;
    window.requestAnimationFrame(() => {
      const initialFocus = operatorPromptConfig?.hideInput ? submit : control;
      initialFocus.focus();
      if (!operatorPromptConfig?.hideInput && operatorPromptConfig?.readOnly) control.select();
    });
  });
}

async function confirmOperatorAction({
  title,
  detail,
  confirmLabel = 'Confirm',
  danger = false,
  confirmationText = null,
  message = 'Review the effect before continuing.',
} = {}) {
  const typed = typeof confirmationText === 'string' && confirmationText.length > 0;
  const result = await openOperatorPrompt({
    eyebrow: danger ? 'Irreversible action' : 'Operator confirmation',
    title,
    detail,
    label: typed ? `Type ${confirmationText}` : 'Confirmation',
    placeholder: typed ? confirmationText : '',
    confirmLabel,
    danger,
    hideInput: !typed,
    required: typed,
    message,
    validate: typed
      ? (value) => value === confirmationText ? null : `Type ${confirmationText} exactly to continue.`
      : undefined,
  });
  return result !== null;
}

function handleOperatorPromptInput(event) {
  if (!['operatorPromptInput', 'operatorPromptTextarea'].includes(event.target.id)) return false;
  if (!operatorPromptResolver) return true;
  setOperatorPromptMessage(operatorPromptConfig?.message);
  return true;
}

function requestRecoveryPin({ title, detail } = {}) {
  return openOperatorPrompt({
    eyebrow: 'Trebuchet security',
    title: title || 'Enter Recovery PIN',
    detail: detail || 'Enter the four-digit PIN that protects local launch wallets and saved secrets.',
    label: 'Four-digit Recovery PIN',
    type: 'password',
    inputMode: 'numeric',
    maxLength: 4,
    placeholder: '••••',
    confirmLabel: 'Continue',
    message: 'Verified locally. Never sent off this device.',
    emptyMessage: 'Enter all four Recovery PIN digits.',
    validate: (value) => /^\d{4}$/.test(value) ? null : 'Recovery PIN must be exactly four digits.',
  });
}

function recoveryPinGateCopy() {
  if (state.recoveryPinGate.reason === 'vanity') {
    return {
      eyebrow: 'Vanity CA security',
      title: 'Unlock to grind',
      detail: 'Your Vanity CA secret stays encrypted locally. Enter the Recovery PIN to continue the grind.',
    };
  }
  if (state.recoveryPinGate.reason === 'wallet') {
    return {
      eyebrow: 'Launch wallet',
      title: 'Enter Recovery PIN',
      detail: 'Unlock the selected launch wallet on this device.',
    };
  }
  return {
    eyebrow: 'Trebuchet security',
    title: 'Unlock Recovery PIN',
    detail: 'Enter the four-digit PIN that protects local launch wallets and saved secrets.',
  };
}

function renderRecoveryPinGate() {
  const gate = $('#recoveryPinGate');
  if (!gate) return;
  const open = state.recoveryPinGate.open === true;
  const status = state.recoveryPinGate.status || 'idle';
  const value = String(state.recoveryPinGate.value || '').slice(0, 4);
  const copy = recoveryPinGateCopy();

  gate.hidden = !open;
  gate.setAttribute('aria-hidden', open ? 'false' : 'true');
  gate.dataset.status = status;
  document.body.classList.toggle('recovery-pin-open', open);
  $('#recoveryPinEyebrow').textContent = copy.eyebrow;
  $('#recoveryPinTitle').textContent = status === 'success' ? 'PIN verified' : copy.title;
  $('#recoveryPinDetail').textContent = copy.detail;
  $('#recoveryPinMessage').textContent = state.recoveryPinGate.message || 'Enter your four-digit Recovery PIN.';

  $$('#recoveryPinBoxes span').forEach((box, index) => {
    const filled = index < value.length;
    box.classList.toggle('is-filled', filled);
    box.textContent = filled ? '•' : '';
  });

  const input = $('#recoveryPinInput');
  if (input) {
    if (input.value !== value) input.value = value;
    input.disabled = ['checking', 'success', 'error'].includes(status);
  }
  const cancel = $('#recoveryPinCancel');
  if (cancel) cancel.disabled = ['checking', 'success'].includes(status);
}

function focusRecoveryPinGate() {
  window.requestAnimationFrame?.(() => {
    const input = $('#recoveryPinInput');
    if (state.recoveryPinGate.open && input && !input.disabled) input.focus();
  });
}

function openRecoveryPinGate({ reason = 'unlock' } = {}) {
  if (recoveryPinGatePromise) {
    focusRecoveryPinGate();
    return recoveryPinGatePromise;
  }
  state.recoveryPinGate = {
    open: true,
    value: '',
    status: 'idle',
    message: 'Enter your four-digit Recovery PIN.',
    reason,
  };
  recoveryPinReturnFocus = document.activeElement;
  recoveryPinGatePromise = new Promise((resolve) => {
    recoveryPinGateResolve = resolve;
  });
  renderRecoveryPinGate();
  focusRecoveryPinGate();
  return recoveryPinGatePromise;
}

function settleRecoveryPinGate(unlocked) {
  if (recoveryPinGateTimer) {
    window.clearTimeout(recoveryPinGateTimer);
    recoveryPinGateTimer = null;
  }
  const resolve = recoveryPinGateResolve;
  recoveryPinGateResolve = null;
  recoveryPinGatePromise = null;
  state.recoveryPinGate = {
    open: false,
    value: '',
    status: 'idle',
    message: 'Enter your four-digit Recovery PIN.',
    reason: 'unlock',
  };
  const returnFocus = recoveryPinReturnFocus;
  recoveryPinReturnFocus = null;
  renderAll();
  if (resolve) resolve(unlocked === true);
  restoreDialogFocus(returnFocus);
}

function cancelRecoveryPinGate() {
  if (!state.recoveryPinGate.open || ['checking', 'success'].includes(state.recoveryPinGate.status)) return;
  settleRecoveryPinGate(false);
}

async function submitRecoveryPinGate() {
  if (!state.recoveryPinGate.open || state.recoveryPinGate.status !== 'idle') return;
  const pin = String(state.recoveryPinGate.value || '');
  if (!/^\d{4}$/.test(pin)) return;

  state.recoveryPinGate.status = 'checking';
  state.recoveryPinGate.message = 'Checking locally…';
  state.secretPin.busy = 'Unlocking';
  renderRecoveryPinGate();
  try {
    const status = await state.apiClient.unlockSecretPin(pin);
    applySecretPinStatus(status);
    await refreshSecretPinStatus({ reloadBoot: true });
    state.secretPin.busy = null;
    state.recoveryPinGate.status = 'success';
    state.recoveryPinGate.message = state.recoveryPinGate.reason === 'vanity'
      ? 'PIN verified. Starting the grinder…'
      : 'PIN verified. Trebuchet is unlocked.';
    renderRecoveryPinGate();
    recoveryPinGateTimer = window.setTimeout(() => settleRecoveryPinGate(true), 520);
  } catch (error) {
    state.secretPin.busy = null;
    state.recoveryPinGate.status = 'error';
    state.recoveryPinGate.message = recoveryPinFailureMessage(error);
    const retryable = !error?.code || error.code === 'BAD_SECRET_PIN';
    renderRecoveryPinGate();
    recoveryPinGateTimer = window.setTimeout(() => {
      recoveryPinGateTimer = null;
      if (!state.recoveryPinGate.open || state.recoveryPinGate.status !== 'error') return;
      if (!retryable) return;
      state.recoveryPinGate.value = '';
      state.recoveryPinGate.status = 'idle';
      state.recoveryPinGate.message = 'Try again. All four digits were cleared.';
      renderRecoveryPinGate();
      focusRecoveryPinGate();
    }, 720);
  }
}

function handleRecoveryPinInput(event) {
  if (event.target.id !== 'recoveryPinInput') return false;
  if (!state.recoveryPinGate.open || state.recoveryPinGate.status !== 'idle') return true;
  const digits = String(event.target.value || '').replace(/\D/g, '').slice(0, 4);
  state.recoveryPinGate.value = digits;
  event.target.value = digits;
  renderRecoveryPinGate();
  if (digits.length === 4) submitRecoveryPinGate().catch(() => null);
  return true;
}

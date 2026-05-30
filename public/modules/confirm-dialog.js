// ===========================================================================
// HTML confirm dialog
// ===========================================================================
//
// Drop-in replacement for window.confirm(). Returns a Promise<boolean>:
// resolves to true on OK, false on Cancel or Esc or background click.
//
// Why we have this: window.confirm() on Windows triggers a Chromium
// compositor hit-testing bug — after the dialog dismisses, text inputs
// in the app become un-clickable (single-clicks don't focus, double-
// clicks can still select) until the user switches windows away and
// back. HTML modals don't trigger the bug because they never leave
// Chromium's compositor — they're just DOM elements styled as a modal.
//
// The dialog uses Bulma's .modal classes the same way the existing
// cancelConfirmModal does. opts:
//   title         — header text (default: "Confirm")
//   body          — body content; can include <strong>, <p>, etc.
//   confirmLabel  — text on the OK button (default: "OK")
//   danger        — if true, OK button is styled red as is-danger
//                   instead of is-primary blue
//   hideCancel    — if true, the Cancel button is hidden so the
//                   modal acts as an info-only dialog with a single
//                   OK action. ESC / background click still resolve
//                   to false (treat as "dismiss"); for an info dialog
//                   callers usually ignore the return value.
async function confirmDialog(opts = {}) {
  const {
    title = 'Confirm',
    body = '',
    confirmLabel = 'OK',
    danger = false,
    hideCancel = false,
  } = opts;

  const modal     = document.getElementById('genericConfirmModal');
  const titleEl   = document.getElementById('genericConfirmTitle');
  const bodyEl    = document.getElementById('genericConfirmBody');
  const okBtn     = document.getElementById('genericConfirmOk');
  const cancelBtn = document.getElementById('genericConfirmCancel');
  const bgEl      = modal.querySelector('.modal-background');

  titleEl.textContent = title;
  // Use innerHTML so callers can pass <p>, <strong>, etc. Callers
  // are responsible for escaping any user-supplied data they
  // include — same trust model as the rest of the codebase.
  bodyEl.innerHTML = body;
  okBtn.textContent = confirmLabel;
  okBtn.classList.remove('is-primary', 'is-danger');
  okBtn.classList.add(danger ? 'is-danger' : 'is-primary');

  // Toggle Cancel visibility. Setting style.display directly (rather
  // than via a class) keeps this self-contained — we don't need to
  // remember to reset a class on every other code path.
  cancelBtn.style.display = hideCancel ? 'none' : '';

  modal.classList.add('is-active');
  okBtn.focus();

  return new Promise((resolve) => {
    const cleanup = (result) => {
      modal.classList.remove('is-active');
      // Restore the cancel button's display so the next caller starts
      // from a known state. Without this, a subsequent confirmDialog
      // without hideCancel would inherit the hidden cancel button.
      cancelBtn.style.display = '';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      bgEl.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onOk     = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onKey    = (e) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onOk();
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    bgEl.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}


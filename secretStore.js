// secretStore.js
//
// Thin wrapper around Electron's safeStorage API for encrypting wallet
// secrets before they go to disk. The encryption is delegated to
// safeStorage, which uses the OS keychain — Keychain Services on macOS,
// DPAPI on Windows, libsecret/kwallet on Linux — to derive a per-user,
// machine-bound encryption key. We never see or manage the key; that's
// the OS's job.
//
// Tokens look like:
//   'enc:<base64>'    — encrypted via safeStorage
//   'plain:<value>'   — fallback when safeStorage isn't available
//
// The fallback exists because:
//   * `npm run web` mode runs without Electron, so safeStorage is gone.
//   * Linux without a keyring backend can't encrypt either.
// In both cases we'd rather still write the recovery info (the safety
// net is more valuable than the encryption) and emit a loud warning
// than silently drop the data.

let _safeStorage = null;
let _warned = false;

// Called by main.js exactly once during Electron startup. Before this
// is called, encryptString falls through to the plaintext path.
export function setSafeStorage(safeStorage) {
  _safeStorage = safeStorage;

  // On Linux, isEncryptionAvailable returns true even when the actual
  // backend is `basic_text` (i.e. unencrypted). That's effectively a
  // false sense of security, so we sniff the backend explicitly and
  // warn if it's basic_text. macOS/Windows always use real OS-level
  // encryption when available.
  if (safeStorage && process.platform === 'linux') {
    try {
      const backend = safeStorage.getSelectedStorageBackend?.();
      if (backend === 'basic_text') {
        console.warn(
          'secretStore: Linux keyring backend is basic_text (no real ' +
          'encryption). Install gnome-keyring, kwallet, or another ' +
          'libsecret-compatible keyring for at-rest protection of ' +
          'wallet secrets.',
        );
      }
    } catch {
      // Older Electron versions don't expose getSelectedStorageBackend;
      // ignore and trust isEncryptionAvailable.
    }
  }
}

function isAvailable() {
  return !!(
    _safeStorage &&
    typeof _safeStorage.isEncryptionAvailable === 'function' &&
    _safeStorage.isEncryptionAvailable()
  );
}

function warnOnce() {
  if (_warned) return;
  _warned = true;
  console.warn(
    'secretStore: encryption unavailable, persisting wallet secrets in ' +
    'plaintext. This is the expected behaviour for `npm run web` mode ' +
    'and for Linux systems without a keyring; do not use this ' +
    'configuration for production launches.',
  );
}

// Encrypt a string and return a tagged token suitable for JSON storage.
export function encryptString(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('secretStore.encryptString expects a string');
  }
  if (!isAvailable()) {
    warnOnce();
    return 'plain:' + plaintext;
  }
  try {
    const buf = _safeStorage.encryptString(plaintext);
    return 'enc:' + buf.toString('base64');
  } catch (e) {
    // Defensive: if encryption throws for any reason (corrupted keyring,
    // OS API hiccup), fall back to plaintext rather than dropping the
    // recovery entry entirely.
    console.warn('secretStore: encryptString failed, using plaintext:', e.message);
    warnOnce();
    return 'plain:' + plaintext;
  }
}

// Decrypt a token previously produced by encryptString. Returns null
// on failure — the caller is expected to surface "decryption failed"
// to the user rather than crash, since the typical cause (keychain
// rotation, machine change) isn't recoverable from inside the app.
export function decryptString(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  if (token.startsWith('plain:')) return token.slice(6);
  if (token.startsWith('enc:')) {
    if (!isAvailable()) {
      console.warn(
        'secretStore: encrypted secret found but safeStorage is ' +
        'unavailable in this run mode. Use the desktop build to access it.',
      );
      return null;
    }
    try {
      const buf = Buffer.from(token.slice(4), 'base64');
      return _safeStorage.decryptString(buf);
    } catch (e) {
      console.warn('secretStore: decryptString failed:', e.message);
      return null;
    }
  }
  // No prefix at all — treat as a legacy plaintext value left over
  // from before this module existed. The next persist() call will
  // re-encode it with a proper tag.
  return token;
}

// True iff the current run mode is doing real encryption. Useful for
// status indicators in the UI ("encrypted at rest" / "stored in
// plaintext"). Not used by the core encrypt/decrypt path.
export function isEncrypting() {
  return isAvailable();
}

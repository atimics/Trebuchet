// The destructive Recovery PIN reset, with the safety steps in a fixed order:
//   1. refuse if the PIN is unlocked and a key that the reset would destroy can still be read
//   2. archive every encrypted secret file (if this fails, refuse: nothing is deleted)
//   3. only then remove the PIN-encrypted items and the PIN file
import * as secretStore from './secretStore.js';
import * as pendingWallets from './pendingWallets.js';
import * as vanityCaStore from './vanityCaStore.js';
import * as splitJobStore from './splitJobStore.js';
import { archiveSecrets } from './secretArchive.js';
import { secretInventory } from './secretInventory.js';

export const RESET_PHRASE = 'RESET RECOVERY PIN';

function refusal(message, code, statusCode, extra = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...extra });
}

/**
 * Returns { status, removed, archive }. Throws an error with statusCode and code
 * when the reset is refused. A refusal never deletes anything.
 */
export function resetWithArchive({ confirmReset, archive = archiveSecrets } = {}) {
  if (confirmReset !== RESET_PHRASE) {
    throw refusal(`Type ${RESET_PHRASE} to confirm the destructive reset.`, 'BAD_SECRET_PIN_RESET_CONFIRMATION', 400);
  }
  const inventory = secretInventory();
  if (!inventory.resetAllowed) {
    throw refusal(
      'Some keys can still be read. Change the PIN instead, or save them first.',
      'SECRET_PIN_RESET_KEYS_READABLE',
      409,
    );
  }
  const saved = archive();
  const removed = {
    pendingWallets: pendingWallets.removePinEncrypted(),
    vanityCAs: vanityCaStore.removePinEncrypted(),
    splitJobs: splitJobStore.removePinEncrypted(),
  };
  const status = secretStore.resetSecretPin();
  return {
    status,
    removed,
    archive: { path: saved.relativePath, files: saved.files.length },
  };
}

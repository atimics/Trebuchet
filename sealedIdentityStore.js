// sealedIdentityStore.js
//
// Holds a sealed launch's real identity (stamped logo, description) on this
// machine until the reveal. Nothing identifying is uploaded before then:
// anyone can read Irys uploads, and an early upload would link the token's
// name and art to its mint while liquidity is still unlocked.
//
// Keyed by mint. The entry is written before the mint exists, so a crash
// mid-launch still leaves everything the reveal needs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_VERSION = 1;

function configDir() {
  return process.env.TREBUCHET_CONFIG_DIR || __dirname;
}

function storeFile() {
  return path.join(configDir(), 'sealedIdentities.json');
}

function load() {
  try {
    if (!fs.existsSync(storeFile())) return { version: STORE_VERSION, identities: {} };
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    const identities = parsed?.identities && typeof parsed.identities === 'object' ? parsed.identities : {};
    return { version: STORE_VERSION, identities };
  } catch (error) {
    console.warn('sealedIdentityStore: failed to read, using an empty store:', error.message);
    return { version: STORE_VERSION, identities: {} };
  }
}

function persist(store) {
  fs.mkdirSync(configDir(), { recursive: true });
  const target = storeFile();
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function saveSealedIdentity(mint, identity) {
  const address = String(mint || '').trim();
  if (!address) throw new Error('A sealed identity needs its mint.');
  const store = load();
  store.identities[address] = { ...identity, mint: address, savedAt: new Date().toISOString() };
  persist(store);
}

export function getSealedIdentity(mint) {
  const entry = load().identities[String(mint || '').trim()];
  return entry ? { ...entry } : null;
}

export function removeSealedIdentity(mint) {
  const store = load();
  const address = String(mint || '').trim();
  if (!(address in store.identities)) return;
  delete store.identities[address];
  persist(store);
}

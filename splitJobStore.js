// splitJobStore.js
//
// Pending split-key vanity grinds. A job holds the customer's secret scalar
// `a` (encrypted with secretStore, like vanity CA keys) and the public point
// A = a*G that a grinder receives. When a grinder returns an offset k, the job
// is completed into a scalar vanity CA key (a + k) and removed. Jobs persist
// so a long grind (e.g. on rented machines) survives an app restart.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as secretStore from './secretStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function storeFile() {
  return path.join(process.env.TREBUCHET_CONFIG_DIR || __dirname, 'splitJobs.json');
}

function readRaw() {
  try {
    if (!fs.existsSync(storeFile())) return [];
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('splitJobStore: failed to read, treating as empty:', e.message);
    return [];
  }
}

function writeRaw(list) {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), `${JSON.stringify(list, null, 2)}\n`);
}

function publicFields(raw) {
  return {
    id: raw.id,
    publicPoint: raw.publicPoint,
    prefix: raw.prefix || null,
    suffix: raw.suffix || null,
    caseInsensitive: raw.caseInsensitive === true,
    addressLength: Number.isInteger(raw.addressLength) ? raw.addressLength : null,
    expectedAttempts: Number.isFinite(raw.expectedAttempts) ? raw.expectedAttempts : null,
    createdAt: raw.createdAt,
  };
}

export function create({ secretScalar, publicPoint, prefix, suffix, caseInsensitive, addressLength, expectedAttempts }) {
  if (!Array.isArray(secretScalar) || secretScalar.length !== 32) throw new TypeError('secretScalar must be 32 bytes');
  if (!/^[0-9a-f]{64}$/.test(String(publicPoint))) throw new TypeError('publicPoint must be 64 hex chars');
  const raw = {
    id: `split_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    publicPoint,
    secretEnc: secretStore.encryptString(JSON.stringify(secretScalar)),
    prefix: prefix || null,
    suffix: suffix || null,
    caseInsensitive: caseInsensitive === true,
    addressLength: Number.isInteger(addressLength) ? addressLength : null,
    expectedAttempts: Number.isFinite(expectedAttempts) ? expectedAttempts : null,
    createdAt: new Date().toISOString(),
  };
  writeRaw([...readRaw(), raw]);
  return publicFields(raw);
}

/** The job with its decrypted secret (server-side use only). */
export function getWithSecret(id) {
  const raw = readRaw().find((job) => job.id === id);
  if (!raw) return null;
  const json = secretStore.decryptString(raw.secretEnc);
  let secretScalar = null;
  try { secretScalar = json ? JSON.parse(json) : null; } catch { secretScalar = null; }
  return { ...publicFields(raw), secretScalar };
}

export function list() {
  return readRaw().map(publicFields);
}

export function remove(id) {
  const all = readRaw();
  const kept = all.filter((job) => job.id !== id);
  if (kept.length !== all.length) writeRaw(kept);
}

export function removePinEncrypted() {
  const all = readRaw();
  const kept = all.filter((job) => !secretStore.isSecretPinToken(job?.secretEnc));
  if (kept.length !== all.length) writeRaw(kept);
  return all.length - kept.length;
}

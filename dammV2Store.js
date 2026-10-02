// dammV2Store.js
//
// Local lean Meteora launches, one JSON file each:
//
//   dammLaunches/<id>.json   config, wallet, step results, events
//
// The position NFT's key is created and saved (encrypted, same wrapper as vanity
// CA keys) BEFORE the pool transaction is sent. If the app dies between sending
// and confirming, the run resumes with the same NFT instead of orphaning a
// permanently locked pool. The key never leaves the server in API output.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as secretStore from './secretStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ID_RE = /^damm_[0-9]+_[0-9a-f]{8}$/;
const MAX_EVENTS = 200;
export const STATUSES = Object.freeze(['draft', 'running', 'completed', 'failed']);

function rootDir() {
  return path.join(process.env.TREBUCHET_CONFIG_DIR || __dirname, 'dammLaunches');
}

function fileFor(id) {
  if (!ID_RE.test(String(id))) throw Object.assign(new Error('Unknown launch'), { statusCode: 404 });
  return path.join(rootDir(), `${id}.json`);
}

function read(id) {
  const file = fileFor(id);
  if (!fs.existsSync(file)) throw Object.assign(new Error('Unknown launch'), { statusCode: 404 });
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function write(record) {
  const file = fileFor(record.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const now = () => new Date().toISOString();

export function create({ config, walletPublicKey = null, logoDataUrl = null }) {
  const id = `damm_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const record = {
    id,
    createdAt: now(),
    updatedAt: now(),
    status: 'draft',
    config,
    walletPublicKey,
    logoDataUrl,
    solUsd: null,
    steps: { token: null, pool: null, keyTransfer: null },
    positionNftEnc: null,
    error: null,
    events: [],
  };
  write(record);
  return record;
}

export function get(id) {
  return read(id);
}

export function list() {
  const dir = rootDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return null; }
    })
    .filter((record) => record && ID_RE.test(record.id))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** Merge a patch into a record. Steps merge one level deep. */
export function update(id, patch = {}) {
  const record = read(id);
  const { steps, ...rest } = patch;
  Object.assign(record, rest);
  if (steps) record.steps = { ...record.steps, ...steps };
  record.updatedAt = now();
  write(record);
  return record;
}

export function appendEvent(id, event) {
  const record = read(id);
  record.events = [...(record.events || []), { at: now(), ...event }].slice(-MAX_EVENTS);
  record.updatedAt = now();
  write(record);
  return record;
}

export function remove(id) {
  const record = read(id);
  if (record.status !== 'draft') throw Object.assign(new Error('Only a draft can be removed.'), { statusCode: 409 });
  fs.rmSync(fileFor(id));
}

/** Save the position NFT key before the pool transaction is sent. */
export function savePositionNft(id, secretKey) {
  const enc = secretStore.encryptString(JSON.stringify(Array.from(secretKey)));
  return update(id, { positionNftEnc: enc });
}

export function loadPositionNft(id) {
  const record = read(id);
  if (!record.positionNftEnc) return null;
  const json = secretStore.decryptString(record.positionNftEnc);
  if (!json) return null;
  try {
    const bytes = JSON.parse(json);
    return Array.isArray(bytes) && bytes.length === 64 ? Uint8Array.from(bytes) : null;
  } catch {
    return null;
  }
}

/** The record without anything secret, for API output. */
export function publicView(record) {
  const { positionNftEnc, logoDataUrl, ...rest } = record;
  return { ...rest, hasLogo: Boolean(logoDataUrl), positionNftSaved: Boolean(positionNftEnc) };
}

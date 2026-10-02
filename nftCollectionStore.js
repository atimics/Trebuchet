// nftCollectionStore.js
//
// Local NFT collections. Each collection is a folder under the config dir:
//
//   nftCollections/<id>/collection.json   config, items, keys, run journal
//   nftCollections/<id>/images/<n>.<ext>  item images as imported
//   nftCollections/<id>/images/cover.<ext>
//
// Asset and collection keys are raw Ed25519 scalars from split-key grinding
// (packages/core/src/split-key.js). They are encrypted with secretStore, the
// same wrapper as vanity CA keys, and never leave the server in API output.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as secretStore from './secretStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ID_RE = /^nft_[0-9]+_[0-9a-f]{8}$/;
const IMAGE_TYPES = new Set(['png', 'jpeg', 'gif', 'webp']);

function rootDir() {
  return path.join(process.env.TREBUCHET_CONFIG_DIR || __dirname, 'nftCollections');
}

function collectionDir(id) {
  if (!ID_RE.test(String(id))) throw Object.assign(new Error('Unknown collection'), { statusCode: 404 });
  return path.join(rootDir(), id);
}

function recordFile(id) {
  return path.join(collectionDir(id), 'collection.json');
}

function readRecord(id) {
  const file = recordFile(id);
  if (!fs.existsSync(file)) throw Object.assign(new Error('Unknown collection'), { statusCode: 404 });
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeRecord(record) {
  const file = recordFile(record.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function encryptScalar(scalar) {
  return secretStore.encryptString(JSON.stringify(Array.from(scalar)));
}

function decryptScalar(token) {
  const json = secretStore.decryptString(token);
  if (!json) return null;
  try {
    const bytes = JSON.parse(json);
    return Array.isArray(bytes) && bytes.length === 32 ? Uint8Array.from(bytes) : null;
  } catch {
    return null;
  }
}

function publicKeyInfo(key) {
  if (!key) return null;
  return {
    address: key.address,
    attempts: key.attempts ?? null,
    elapsedSec: key.elapsedSec ?? null,
    pattern: key.pattern ?? null,
    createdAt: key.createdAt,
  };
}

function publicItem(item) {
  const { key, ...rest } = item;
  return { ...rest, address: key?.address || null, key: publicKeyInfo(key) };
}

/** A collection with every secret removed: safe to send to the renderer. */
export function publicView(record) {
  const { collectionKey, items, ...rest } = record;
  return {
    ...rest,
    collectionKey: publicKeyInfo(collectionKey),
    items: items.map(publicItem),
  };
}

export function create(config) {
  const now = new Date().toISOString();
  const record = {
    id: `nft_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    createdAt: now,
    updatedAt: now,
    config,
    walletPublicKey: null,
    cover: null,
    items: [],
    collectionKey: null,
    collectionImageUri: null,
    collectionMetadataUri: null,
    collectionSignature: null,
    genesisHash: null,
    run: null,
    verification: null,
  };
  writeRecord(record);
  return record;
}

export function get(id) {
  return readRecord(id);
}

export function list() {
  if (!fs.existsSync(rootDir())) return [];
  return fs.readdirSync(rootDir())
    .filter((name) => ID_RE.test(name) && fs.existsSync(path.join(rootDir(), name, 'collection.json')))
    .map((name) => {
      try { return readRecord(name); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Read, change and write one collection. The mutator may return a new record. */
export function update(id, mutator) {
  const record = readRecord(id);
  const next = mutator(record) || record;
  next.updatedAt = new Date().toISOString();
  writeRecord(next);
  return next;
}

export function remove(id) {
  fs.rmSync(collectionDir(id), { recursive: true, force: true });
}

function imagePath(id, name, type) {
  if (!IMAGE_TYPES.has(type)) throw new Error(`Unsupported image type: ${type}`);
  if (!/^(cover|[0-9]{1,5})$/.test(String(name))) throw new Error('Bad image name');
  return path.join(collectionDir(id), 'images', `${name}.${type}`);
}

export function saveImage(id, name, type, bytes) {
  const file = imagePath(id, name, type);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const other of IMAGE_TYPES) {
    if (other !== type) fs.rmSync(imagePath(id, name, other), { force: true });
  }
  fs.writeFileSync(file, bytes);
  return { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

export function readImage(id, name, type) {
  const file = imagePath(id, name, type);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

export function hasImage(id, name, type) {
  return fs.existsSync(imagePath(id, name, type));
}

/** Key record for an asset or the collection; the scalar is encrypted. */
export function keyRecord({ scalar, address, attempts = null, elapsedSec = null, pattern = null }) {
  return {
    address,
    scalarEnc: encryptScalar(scalar),
    attempts,
    elapsedSec,
    pattern,
    createdAt: new Date().toISOString(),
  };
}

export function keyScalar(key) {
  return key?.scalarEnc ? decryptScalar(key.scalarEnc) : null;
}

/** Drop unused PIN-encrypted keys after a PIN reset. Minted keys are spent. */
export function removePinEncrypted() {
  let removed = 0;
  for (const record of list()) {
    update(record.id, (r) => {
      for (const item of r.items) {
        if (item.key && !item.mintSignature && secretStore.isSecretPinToken(item.key.scalarEnc)) {
          item.key = null;
          removed += 1;
        }
      }
      if (r.collectionKey && !r.collectionSignature && secretStore.isSecretPinToken(r.collectionKey.scalarEnc)) {
        r.collectionKey = null;
        removed += 1;
      }
      return r;
    });
  }
  return removed;
}

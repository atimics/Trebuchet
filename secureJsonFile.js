// secureJsonFile.js
//
// Small shared helpers for stores that keep encrypted secrets in a JSON array
// file. Two rules:
//   1. Never treat a damaged file as empty. Reading a file that exists but does
//      not parse throws, so a later write cannot overwrite the bytes.
//   2. Writes are atomic: temp file, fsync, rename, mode 0600. The previous
//      good file is kept as `<file>.bak` (one deep).

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class StoreFileError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'StoreFileError';
    this.code = 'STORE_FILE_UNREADABLE';
  }
}

/** Read a JSON array file. Missing file gives []. Damaged file throws and is left untouched. */
export function readJsonArrayStrict(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new StoreFileError(`${label} file could not be read. It was left unchanged.`, { cause: error });
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
    return parsed;
  } catch (error) {
    throw new StoreFileError(
      `${label} file is damaged and was left unchanged. Restore it from ${path.basename(file)}.bak or fix it by hand before continuing.`,
      { cause: error },
    );
  }
}

function syncDirectory(dir) {
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* directory sync is best effort */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function writeFileDurably(target, bytes) {
  const tmp = `${target}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* keep first error */ } }
    try { fs.unlinkSync(tmp); } catch { /* keep first error */ }
    throw error;
  }
}

/**
 * Write `value` as JSON to `file` atomically. If the current file parses as a
 * JSON array it is first saved as `<file>.bak`. If the current file exists but
 * is damaged, refuse to replace it.
 */
export function atomicWriteJson(file, value, label = 'Store') {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  readJsonArrayStrict(file, label); // throws on a damaged file
  if (fs.existsSync(file)) writeFileDurably(`${file}.bak`, fs.readFileSync(file));
  writeFileDurably(file, `${JSON.stringify(value, null, 2)}\n`);
  syncDirectory(dir);
}

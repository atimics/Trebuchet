// Encrypted-file archive taken before a destructive Recovery PIN reset.
//
// The files copied here are already encrypted on disk, so the archive adds no
// plaintext. Nothing is decrypted. Copies are byte for byte with mode 0600.
// If any step fails, the partial archive is removed and the error is thrown so
// the caller can refuse the reset.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function configDir() {
  return process.env.TREBUCHET_CONFIG_DIR || __dirname;
}

const FLAT_FILES = ['.secretPin.json', 'pendingWallets.json', 'vanityCAs.json', 'splitJobs.json'];

function archiveSources() {
  const root = configDir();
  const sources = FLAT_FILES.map((name) => ({ from: path.join(root, name), rel: name }));
  const nftRoot = path.join(root, 'nftCollections');
  let ids = [];
  try {
    ids = fs.readdirSync(nftRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const id of ids) {
    sources.push({
      from: path.join(nftRoot, id, 'collection.json'),
      rel: path.join('nftCollections', id, 'collection.json'),
    });
  }
  const dammRoot = path.join(root, 'dammLaunches');
  let dammFiles = [];
  try { dammFiles = fs.readdirSync(dammRoot); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const file of dammFiles.filter((name) => name.endsWith('.json'))) {
    sources.push({ from: path.join(dammRoot, file), rel: path.join('dammLaunches', file) });
  }
  return sources;
}

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
}

/**
 * Copy every encrypted secret file into <configDir>/secret-archive/reset-<time>/.
 * Returns { dir, relativePath, files }. `files` holds relative names only.
 */
export function archiveSecrets() {
  const archiveRoot = path.join(configDir(), 'secret-archive');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let dir = null;
  try {
    privateDir(archiveRoot);
    for (let n = 0; ; n += 1) {
      const candidate = path.join(archiveRoot, `reset-${stamp}${n ? `-${n}` : ''}`);
      try {
        fs.mkdirSync(candidate, { mode: 0o700 });
        dir = candidate;
        break;
      } catch (error) {
        if (error.code !== 'EEXIST' || n > 50) throw error;
      }
    }
    const files = [];
    for (const { from, rel } of archiveSources()) {
      let bytes;
      try {
        const stat = fs.lstatSync(from);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Cannot archive ${rel}: not a regular file`);
        bytes = fs.readFileSync(from);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const to = path.join(dir, rel);
      privateDir(path.dirname(to));
      const fd = fs.openSync(to, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (process.platform !== 'win32') fs.chmodSync(to, 0o600);
      if (!fs.readFileSync(to).equals(bytes)) throw new Error(`Archive copy of ${rel} did not verify`);
      files.push(rel);
    }
    return { dir, relativePath: path.join('secret-archive', path.basename(dir)), files };
  } catch (error) {
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* keep the original error */ }
    }
    throw Object.assign(new Error('Could not archive the encrypted keys, so nothing was reset.', { cause: error }), {
      statusCode: 500,
      code: 'SECRET_ARCHIVE_FAILED',
    });
  }
}

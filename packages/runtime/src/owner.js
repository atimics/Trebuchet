// The OS releases this SQLite write lock when the owner process exits.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function acquireProfileOwner(profileDir) {
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const profile = fs.realpathSync(profileDir);
  const lockPath = path.join(profile, 'runtime-owner.sqlite');
  if (fs.existsSync(lockPath) && fs.lstatSync(lockPath).isSymbolicLink()) throw new Error('Runtime lock must be a regular file');
  const db = new DatabaseSync(lockPath);
  fs.chmodSync(lockPath, 0o600);
  try {
    db.exec('PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL); BEGIN EXCLUSIVE; INSERT INTO owner VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET generation = generation + 1;');
  } catch (cause) {
    db.close();
    const busy = /locked|busy/i.test(cause.message);
    throw Object.assign(new Error(busy ? 'Another process owns this profile' : 'Profile ownership storage needs recovery', { cause }), { code: busy ? 'RUNTIME_OWNED' : 'RECOVERY_STORAGE_UNAVAILABLE' });
  }
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const descriptorPath = path.join(profile, 'runtime.json');
  let released = false;
  return {
    id, token, profile,
    publish(port) {
      if (released || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Runtime owner requires an active local port');
      const descriptor = { schema: 'trebuchet-runtime/v1', id, profile, pid: process.pid, url: `http://127.0.0.1:${port}`, token };
      const tmp = `${descriptorPath}.${id}.tmp`;
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(descriptor)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, descriptorPath);
      return descriptor;
    },
    release() {
      if (released) return;
      try {
        const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
        if (descriptor.id === id) fs.unlinkSync(descriptorPath);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      finally { released = true; db.exec('ROLLBACK'); db.close(); }
    },
  };
}

export function readRuntimeDescriptor(profileDir) {
  const profile = fs.realpathSync(profileDir);
  const file = path.join(profile, 'runtime.json');
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Runtime descriptor must be a regular file');
  const descriptor = JSON.parse(fs.readFileSync(file, 'utf8'));
  const url = new URL(descriptor.url);
  if (descriptor.schema !== 'trebuchet-runtime/v1' || descriptor.profile !== profile || !descriptor.id || !/^[A-Za-z0-9_-]{43}$/.test(descriptor.token || '')
    || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Runtime descriptor requires a valid local owner');
  }
  return descriptor;
}

// Parse and validate the complete packet before writing extracted files.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Parser } from 'tar';
import { TREBUCHET_PLAN_SCHEMA, buildV2LaunchPlan, verifyLaunchPlan } from '@trebuchet/core/launch-plan';

export const PACKET_MANIFEST_SCHEMA = 'trebuchet-launch-packet/v1';
export const PACKET_LIMITS = Object.freeze({ archiveBytes: 20 * 1024 * 1024, expandedBytes: 40 * 1024 * 1024, fileBytes: 10 * 1024 * 1024, entries: 256 });
export class PacketError extends Error {
  constructor(message, options) { super(message, options); this.name = 'PacketError'; }
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function packetRelativePath(value, { directory = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\\x00-\x1f:]/.test(value)) {
    throw new PacketError('Packet paths must be plain relative paths');
  }
  const name = directory ? value.replace(/\/$/, '') : value;
  const parts = name.split('/');
  if (path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || parts.length > 32
    || parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) {
    throw new PacketError(`Packet path escapes or aliases its root: ${value}`);
  }
  return parts.join('/');
}

// The gzip bound includes tar metadata and padding, including ignored entries.
// Parser resolves PAX/GNU paths; each resolved entry is checked before extraction.
export async function extractPacketArchive(archivePath, targetDir, limits = PACKET_LIMITS) {
  let entries;
  try {
    const archiveStat = await fsp.stat(archivePath);
    if (archiveStat.size > limits.archiveBytes) throw new PacketError('Packet archive exceeds its size limit');
    const raw = gunzipSync(await fsp.readFile(archivePath), { maxOutputLength: limits.expandedBytes });
    entries = await new Promise((resolve, reject) => {
      const files = [];
      const names = new Set();
      const parser = new Parser({ strict: true, maxMetaEntrySize: 16 * 1024 });
      parser.on('error', reject);
      parser.on('ignoredEntry', () => parser.abort(new PacketError('Unsupported archive entry')));
      parser.on('entry', (entry) => {
        try {
          if (!['File', 'OldFile', 'Directory'].includes(entry.type)) throw new PacketError('Packet archive must contain regular files and directories');
          const directory = entry.type === 'Directory';
          const name = packetRelativePath(entry.path, { directory });
          const portableName = name.toLowerCase();
          if (names.has(portableName)) throw new PacketError(`Duplicate archive path: ${name}`);
          names.add(portableName);
          if (names.size > limits.entries || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.fileBytes) {
            throw new PacketError('Packet archive exceeds entry limits');
          }
          if (directory && entry.size !== 0) throw new PacketError('Directory entry contains data');
          const chunks = [];
          entry.on('end', () => files.push({ name, directory, bytes: Buffer.concat(chunks) }));
          entry.on('data', (chunk) => chunks.push(chunk));
          entry.resume();
        } catch (error) { parser.abort(error); }
      });
      parser.on('end', () => resolve(files));
      parser.end(raw);
    });
  } catch (error) {
    throw error instanceof PacketError ? error : new PacketError(`Packet archive rejected: ${error.message}`, { cause: error });
  }
  const names = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]));
  for (const entry of entries) {
    const parts = entry.name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = names.get(parts.slice(0, i).join('/').toLowerCase());
      if (parent && !parent.directory) throw new PacketError('Archive file overlaps a directory');
    }
  }
  // A fresh private directory also keeps concurrent uploads and symlinks apart.
  await fsp.mkdir(targetDir, { mode: 0o700 });
  for (const entry of entries) {
    const dest = path.join(targetDir, entry.name);
    if (entry.directory) await fsp.mkdir(dest, { recursive: true, mode: 0o700 });
    else {
      await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await fsp.writeFile(dest, entry.bytes, { flag: 'wx', mode: 0o600 });
    }
  }
}

function regularFile(root, name) {
  const relative = packetRelativePath(name);
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new PacketError(`Packet input must be a regular file: ${name}`);
    }
  }
  return current;
}

export function locatePacketRoot(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.some((entry) => entry.name === 'manifest.json' && entry.isFile())) return dir;
  if (entries.length === 1 && entries[0].isDirectory()) {
    const nested = path.join(dir, entries[0].name);
    try { regularFile(nested, 'manifest.json'); return nested; } catch { /* report the packet layout */ }
  }
  throw new PacketError('Archive must contain one packet root with manifest.json');
}

export async function verifyPacketDir(dir) {
  const root = await fsp.realpath(dir);
  const loadFile = async (name) => {
    try {
      const file = regularFile(root, name);
      if (fs.statSync(file).size > PACKET_LIMITS.fileBytes) throw new PacketError('Packet file exceeds size limit');
      return await fsp.readFile(file);
    } catch (error) {
      throw error instanceof PacketError ? error : new PacketError(`Packet file missing: ${name}`, { cause: error });
    }
  };
  const parseJson = (bytes, name) => {
    try { return JSON.parse(bytes); } catch { throw new PacketError(`Packet JSON is invalid: ${name}`); }
  };
  const manifestBytes = await loadFile('manifest.json');
  const manifest = parseJson(manifestBytes, 'manifest.json');
  if (manifest?.schema !== PACKET_MANIFEST_SCHEMA) throw new PacketError('Unsupported packet manifest schema');
  if (!Array.isArray(manifest.files) || manifest.files.length < 2 || manifest.files.length > PACKET_LIMITS.entries) throw new PacketError('Manifest must list the required packet files');
  if (manifest.security?.containsPrivateKeys !== false) throw new PacketError('Manifest must declare private keys absent');
  if (!/^[a-f0-9]{64}$/.test(manifest.planDigest || '')) throw new PacketError('Manifest requires a plan digest');
  const seen = new Set();
  const contents = new Map();
  let totalBytes = manifestBytes.length;
  for (const entry of manifest.files) {
    const name = packetRelativePath(entry?.path);
    const portableName = name.toLowerCase();
    if (name === 'manifest.json' || seen.has(portableName)) throw new PacketError(`Duplicate or reserved manifest entry: ${name}`);
    seen.add(portableName);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > PACKET_LIMITS.fileBytes || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) {
      throw new PacketError(`Invalid manifest size or hash: ${name}`);
    }
    const bytes = await loadFile(name);
    totalBytes += bytes.length;
    if (totalBytes > PACKET_LIMITS.expandedBytes) throw new PacketError('Packet exceeds expanded size limit');
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new PacketError(`Packet file hash mismatch: ${name}`);
    contents.set(name, bytes);
  }
  for (const required of ['plan.json', 'launch.json']) {
    if (!contents.has(required)) throw new PacketError(`Manifest must cover ${required}`);
  }
  let entryCount = 0;
  const walk = (base, prefix = '') => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (++entryCount > PACKET_LIMITS.entries) throw new PacketError('Packet exceeds entry limit');
      const name = packetRelativePath(prefix + entry.name);
      if (entry.isDirectory()) walk(path.join(base, entry.name), name + '/');
      else if (!entry.isFile() || (name !== 'manifest.json' && !contents.has(name))) throw new PacketError(`Unlisted packet input: ${name}`);
    }
  };
  walk(root);
  const plan = parseJson(contents.get('plan.json'), 'plan.json');
  const launchConfig = parseJson(contents.get('launch.json'), 'launch.json');
  if (plan?.schema !== TREBUCHET_PLAN_SCHEMA) throw new PacketError('Unexpected launch plan schema');
  const verification = verifyLaunchPlan(plan);
  if (!verification.valid || verification.digest !== manifest.planDigest) throw new PacketError('Embedded launch plan failed integrity verification');
  let rebuilt;
  try { rebuilt = buildV2LaunchPlan(launchConfig, { now: plan.generatedAt, demoMode: plan.runtime === 'demo' }); }
  catch (error) { throw new PacketError(`Launch configuration is invalid: ${error.message}`); }
  if (rebuilt.integrity.digest !== verification.digest) throw new PacketError('Launch configuration differs from the verified plan');
  return { manifest, manifestDigest: sha256(manifestBytes), plan, launchConfig, digest: verification.digest, files: [...contents.keys()].sort() };
}

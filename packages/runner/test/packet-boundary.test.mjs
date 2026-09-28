import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { buildV2LaunchPlan } from '@trebuchet/core/launch-plan';
import { extractPacketArchive, PACKET_LIMITS, packetRelativePath, verifyPacketDir } from '../src/packet.js';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const intent = JSON.parse(fs.readFileSync(new URL('../../core/test/fixtures/guided-sol-plan.json', import.meta.url))).intent;
function work(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-packet-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function packet(t) {
  const root = work(t);
  const dir = path.join(root, 'packet');
  fs.mkdirSync(dir);
  const config = intent || { token: { name: 'Boundary', symbol: 'BNDR', supply: '1000000' } };
  const plan = buildV2LaunchPlan(config);
  const manifest = { schema: 'trebuchet-launch-packet/v1', planDigest: plan.integrity.digest, security: { containsPrivateKeys: false }, files: [] };
  for (const [name, value] of [['launch.json', config], ['plan.json', plan]]) {
    const bytes = Buffer.from(JSON.stringify(value));
    fs.writeFileSync(path.join(dir, name), bytes);
    manifest.files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const save = () => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  save();
  return { root, dir, manifest, save };
}
function archive(root, entries) {
  const parts = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.bytes || '');
    const header = new Header({ path: entry.path, type: entry.type || 'File', size: bytes.length, mode: 0o600, linkpath: entry.linkpath });
    header.encode();
    parts.push(header.block, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const file = path.join(root, 'packet.tar.gz');
  fs.writeFileSync(file, gzipSync(Buffer.concat(parts)));
  return file;
}

test('valid packets bind configuration and every input to the plan', async (t) => {
  const { dir, manifest } = packet(t);
  const verified = await verifyPacketDir(dir);
  assert.equal(verified.digest, manifest.planDigest);
  assert.match(verified.manifestDigest, /^[a-f0-9]{64}$/);
});

for (const name of ['../outside.txt', '/tmp/outside', 'a/../../outside', 'C:\\outside', 'a\\b', 'a/./b', 'a//b', 'NUL.txt', 'a:stream', 'a.']) {
  test(`path rejects ${JSON.stringify(name)}`, () => assert.throws(() => packetRelativePath(name)));
}

test('manifest parent traversal is rejected before reading the parent file', async (t) => {
  const { root, dir, manifest, save } = packet(t);
  const bytes = Buffer.from('review fixture');
  fs.writeFileSync(path.join(root, 'outside.txt'), bytes);
  manifest.files.push({ path: '../outside.txt', bytes: bytes.length, sha256: sha256(bytes) });
  save();
  await assert.rejects(verifyPacketDir(dir), /path/i);
});

test('required files, manifest digest, and config-plan agreement are enforced', async (t) => {
  const { dir, manifest, save } = packet(t);
  const original = structuredClone(manifest);
  manifest.files = manifest.files.filter((entry) => entry.path !== 'plan.json');
  save();
  await assert.rejects(verifyPacketDir(dir), /required/);
  Object.assign(manifest, structuredClone(original));
  delete manifest.planDigest;
  save();
  await assert.rejects(verifyPacketDir(dir), /plan digest/);
  Object.assign(manifest, original);
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'launch.json')));
  config.token.symbol = 'CHANGED';
  const bytes = Buffer.from(JSON.stringify(config));
  fs.writeFileSync(path.join(dir, 'launch.json'), bytes);
  Object.assign(manifest.files.find((entry) => entry.path === 'launch.json'), { bytes: bytes.length, sha256: sha256(bytes) });
  save();
  await assert.rejects(verifyPacketDir(dir), /differs/);
});

test('unlisted files and symlink inputs are rejected', async (t) => {
  const { dir, root } = packet(t);
  const extra = path.join(dir, 'extra');
  fs.writeFileSync(extra, 'unlisted');
  await assert.rejects(verifyPacketDir(dir), /Unlisted/);
  fs.unlinkSync(extra);
  fs.renameSync(path.join(dir, 'launch.json'), path.join(root, 'config.json'));
  fs.symlinkSync(path.join(root, 'config.json'), path.join(dir, 'launch.json'));
  await assert.rejects(verifyPacketDir(dir), /regular file/);
});

for (const entry of [
  { path: '../outside', bytes: 'escape' },
  { path: '/outside', bytes: 'escape' },
  { path: 'link', type: 'SymbolicLink', linkpath: '../outside' },
  { path: 'link', type: 'Link', linkpath: '../outside' },
  { path: 'fifo', type: 'FIFO' },
]) {
  test(`unsafe archive ${entry.type || entry.path} is rejected before extraction`, async (t) => {
    const root = work(t);
    const target = path.join(root, 'out');
    await assert.rejects(extractPacketArchive(archive(root, [entry]), target));
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(path.join(root, 'outside')), false);
  });
}

test('duplicate entries and expanded archives are rejected before extraction', async (t) => {
  const root = work(t);
  const target = path.join(root, 'out');
  await assert.rejects(extractPacketArchive(archive(root, [{ path: 'a' }, { path: 'A' }]), target), /Duplicate/);
  const compressed = archive(root, [{ path: 'large', bytes: 'x'.repeat(16 * 1024) }]);
  await assert.rejects(extractPacketArchive(compressed, target, { ...PACKET_LIMITS, expandedBytes: 1024 }), /rejected/);
  assert.equal(fs.existsSync(target), false);
});

test('regular archive extraction preserves exact file contents', async (t) => {
  const root = work(t);
  const target = path.join(root, 'out');
  await extractPacketArchive(archive(root, [{ path: 'packet/', type: 'Directory' }, { path: 'packet/input', bytes: 'exact bytes' }]), target);
  assert.equal(fs.readFileSync(path.join(target, 'packet/input'), 'utf8'), 'exact bytes');
});

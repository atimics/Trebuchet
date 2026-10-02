import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as secretStore from '../secretStore.js';

let importCounter = 0;

function makeTempConfigDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trebuchet-keep-ciphertext-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function importFresh(file, configDir) {
  process.env.TREBUCHET_CONFIG_DIR = configDir;
  return import(new URL(`../${file}?case=${++importCounter}`, import.meta.url));
}

// A device key whose ciphertext only opens under the same key id.
function keyedSafeStorage(keyId) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => Buffer.from(`${keyId}:${plaintext}`, 'utf8'),
    decryptString: (buffer) => {
      const text = buffer.toString('utf8');
      if (!text.startsWith(`${keyId}:`)) throw new Error('wrong data key');
      return text.slice(keyId.length + 1);
    },
  };
}

async function quiet(fn) {
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  try { return await fn(); } finally { console.warn = warn; console.error = error; }
}

const vanityFile = (dir) => path.join(dir, 'vanityCAs.json');
const splitFile = (dir) => path.join(dir, 'splitJobs.json');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const pk = (n) => `Vanity${String(n).padStart(2, '0')}`.padEnd(40, '1');

// Writes `count` entries under key k1, then switches to key k2 so they cannot be decrypted.
async function seedUnderKeyOne(t, count) {
  const dir = makeTempConfigDir(t);
  secretStore.lockSecretPin();
  secretStore.setSafeStorage(keyedSafeStorage('k1'));
  const store = await importFresh('vanityCaStore.js', dir);
  for (let i = 0; i < count; i += 1) store.add({ publicKey: pk(i), secretKey: [i, i + 1, i + 2] });
  const originals = new Map(readJson(vanityFile(dir)).map((r) => [r.publicKey, r.secretKeyEnc]));
  assert.equal(originals.size, count);
  secretStore.setSafeStorage(keyedSafeStorage('k2'));
  return { dir, store, originals };
}

function encOf(dir, publicKey) {
  return readJson(vanityFile(dir)).find((r) => r.publicKey === publicKey)?.secretKeyEnc;
}

test('vanity: add and remove under a wrong data key keep other entries ciphertext byte for byte', async (t) => {
  await quiet(async () => {
    const { dir, store, originals } = await seedUnderKeyOne(t, 4);
    assert.equal(store.listMetadata().every((m) => m.decryptionFailed), true);

    store.add({ publicKey: 'NewEntry'.padEnd(40, '1'), secretKey: [9, 9, 9] });
    for (const [key, enc] of originals) assert.equal(encOf(dir, key), enc);

    store.remove(pk(1));
    assert.equal(encOf(dir, pk(1)), undefined);
    for (const [key, enc] of originals) if (key !== pk(1)) assert.equal(encOf(dir, key), enc);
    assert.equal(readJson(vanityFile(dir)).length, 4);

    // The new entry is readable under k2, the old ones are still "unreadable" but present.
    assert.deepEqual(store.get('NewEntry'.padEnd(40, '1')).secretKey, [9, 9, 9]);
    assert.equal(store.listMetadata().find((m) => m.publicKey === pk(0)).decryptionFailed, true);

    // Back under k1 the original secrets still open.
    secretStore.setSafeStorage(keyedSafeStorage('k1'));
    assert.deepEqual(store.get(pk(0)).secretKey, [0, 1, 2]);
  });
});

test('vanity: a locked Recovery PIN does not cost any entry its ciphertext', async (t) => {
  await quiet(async () => {
    const dir = makeTempConfigDir(t);
    process.env.TREBUCHET_CONFIG_DIR = dir;
    secretStore.setSafeStorage(null);
    secretStore.setupSecretPin('2468');
    t.after(() => secretStore.lockSecretPin());
    const store = await importFresh('vanityCaStore.js', dir);
    store.add({ publicKey: pk(1), secretKey: [1, 2, 3] });
    store.add({ publicKey: pk(2), secretKey: [4, 5, 6] });
    const before = readJson(vanityFile(dir));
    assert.match(before[0].secretKeyEnc, /^pin:/);

    secretStore.lockSecretPin();
    assert.equal(store.list().length, 2); // listing and migration paths
    store.listMetadata();
    store.remove(pk(1));
    assert.deepEqual(readJson(vanityFile(dir)), [before[1]]);
    store.remove('NotThere');
    assert.deepEqual(readJson(vanityFile(dir)), [before[1]]);
  });
});

test('vanity: legacy plaintext secrets are kept when the entry cannot be migrated', async (t) => {
  await quiet(async () => {
    const dir = makeTempConfigDir(t);
    secretStore.lockSecretPin();
    secretStore.setSafeStorage(keyedSafeStorage('k2'));
    const stuck = { publicKey: pk(1), createdAt: 'x', secretKeyEnc: 'enc:' + Buffer.from('k1:[1]').toString('base64'), extraField: 'keep' };
    const legacy = { publicKey: pk(2), createdAt: 'y', secretKey: [7, 8, 9] };
    writeFileSync(vanityFile(dir), JSON.stringify([stuck, legacy]) + '\n');
    const store = await importFresh('vanityCaStore.js', dir);
    store.list(); // triggers migration of the legacy entry
    const disk = readJson(vanityFile(dir));
    assert.equal(disk.find((r) => r.publicKey === pk(1)).secretKeyEnc, stuck.secretKeyEnc);
    assert.equal(disk.find((r) => r.publicKey === pk(1)).extraField, 'keep');
    assert.match(disk.find((r) => r.publicKey === pk(2)).secretKeyEnc, /^enc:/);
    assert.equal(disk.find((r) => r.publicKey === pk(2)).secretKey, undefined);
  });
});

test('vanity: random add/remove/list under a wrong key never shrinks untouched ciphertext', async (t) => {
  await quiet(async () => {
    const { dir, store, originals } = await seedUnderKeyOne(t, 8);
    const untouched = new Map(originals);
    let seed = 12345;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    let added = 0;
    for (let step = 0; step < 120; step += 1) {
      const op = rand(4);
      if (op === 0) {
        added += 1;
        store.add({ publicKey: `Added${added}`.padEnd(40, '1'), secretKey: [added] });
      } else if (op === 1 && untouched.size > 0) {
        const keys = [...untouched.keys()];
        const victim = keys[rand(keys.length)];
        untouched.delete(victim); // removed on purpose, no longer expected
        store.remove(victim);
      } else if (op === 2) {
        store.list();
      } else {
        store.listMetadata();
      }
      for (const [key, enc] of untouched) assert.equal(encOf(dir, key), enc, `step ${step}`);
    }
  });
});

test('vanity: a truncated or garbage file fails clearly and its bytes are unchanged', async (t) => {
  await quiet(async () => {
    for (const bytes of ['[{"publicKey":"abc","secretKeyEnc":"enc:AAAA"', 'not json at all', '{"a":1}']) {
      const dir = makeTempConfigDir(t);
      secretStore.lockSecretPin();
      secretStore.setSafeStorage(null);
      writeFileSync(vanityFile(dir), bytes);
      const store = await importFresh('vanityCaStore.js', dir);
      assert.throws(() => store.add({ publicKey: pk(1), secretKey: [1] }), /damaged/);
      assert.throws(() => store.remove(pk(1)), /damaged/);
      assert.throws(() => store.list(), /damaged/);
      assert.throws(() => store.listMetadata(), /damaged/);
      assert.throws(() => store.removePinEncrypted(), /damaged/);
      assert.equal(readFileSync(vanityFile(dir), 'utf8'), bytes);
      assert.equal(existsSync(`${vanityFile(dir)}.bak`), false);
      assert.deepEqual(readdirSync(dir), ['vanityCAs.json']);
    }
  });
});

test('vanity: .bak holds the previous good file, and writes keep mode 0600 with no temp files', async (t) => {
  await quiet(async () => {
    const dir = makeTempConfigDir(t);
    secretStore.lockSecretPin();
    secretStore.setSafeStorage(null);
    const store = await importFresh('vanityCaStore.js', dir);
    store.add({ publicKey: pk(1), secretKey: [1] });
    assert.equal(existsSync(`${vanityFile(dir)}.bak`), false); // nothing to back up yet
    const afterFirst = readFileSync(vanityFile(dir), 'utf8');
    store.add({ publicKey: pk(2), secretKey: [2] });
    assert.equal(readFileSync(`${vanityFile(dir)}.bak`, 'utf8'), afterFirst);
    const afterSecond = readFileSync(vanityFile(dir), 'utf8');
    store.remove(pk(1));
    assert.equal(readFileSync(`${vanityFile(dir)}.bak`, 'utf8'), afterSecond);
    assert.deepEqual(readdirSync(dir).sort(), ['vanityCAs.json', 'vanityCAs.json.bak']);
    if (process.platform !== 'win32') {
      assert.equal(statSync(vanityFile(dir)).mode & 0o777, 0o600);
      assert.equal(statSync(`${vanityFile(dir)}.bak`).mode & 0o777, 0o600);
    }
  });
});

// ---- splitJobStore ----

const scalar = (n) => Array.from({ length: 32 }, () => n);
const point = (c) => c.repeat(64);

test('split jobs: removing and creating jobs keeps unreadable ciphertext of other jobs', async (t) => {
  await quiet(async () => {
    const dir = makeTempConfigDir(t);
    secretStore.lockSecretPin();
    secretStore.setSafeStorage(keyedSafeStorage('k1'));
    const jobs = await importFresh('splitJobStore.js', dir);
    const a = jobs.create({ secretScalar: scalar(1), publicPoint: point('a') });
    const b = jobs.create({ secretScalar: scalar(2), publicPoint: point('b') });
    const originals = new Map(readJson(splitFile(dir)).map((r) => [r.id, r.secretEnc]));

    secretStore.setSafeStorage(keyedSafeStorage('k2'));
    assert.equal(jobs.getWithSecret(a.id).secretScalar, null);
    const c = jobs.create({ secretScalar: scalar(3), publicPoint: point('c') });
    jobs.remove(b.id);
    const disk = readJson(splitFile(dir));
    assert.equal(disk.length, 2);
    assert.equal(disk.find((r) => r.id === a.id).secretEnc, originals.get(a.id));
    assert.deepEqual(jobs.getWithSecret(c.id).secretScalar, scalar(3));
  });
});

test('split jobs: a damaged file fails clearly and its bytes are unchanged', async (t) => {
  await quiet(async () => {
    const dir = makeTempConfigDir(t);
    secretStore.lockSecretPin();
    secretStore.setSafeStorage(null);
    const bytes = '[{"id":"split_1","secretEnc":"plain:[1';
    writeFileSync(splitFile(dir), bytes);
    const jobs = await importFresh('splitJobStore.js', dir);
    assert.throws(() => jobs.create({ secretScalar: scalar(1), publicPoint: point('a') }), /damaged/);
    assert.throws(() => jobs.remove('split_1'), /damaged/);
    assert.throws(() => jobs.list(), /damaged/);
    assert.throws(() => jobs.removePinEncrypted(), /damaged/);
    assert.equal(readFileSync(splitFile(dir), 'utf8'), bytes);
    assert.deepEqual(readdirSync(dir), ['splitJobs.json']);
  });
});

test('split jobs: .bak holds the previous good file', async (t) => {
  await quiet(async () => {
    const dir = makeTempConfigDir(t);
    secretStore.lockSecretPin();
    secretStore.setSafeStorage(null);
    const jobs = await importFresh('splitJobStore.js', dir);
    const first = jobs.create({ secretScalar: scalar(1), publicPoint: point('a') });
    assert.equal(existsSync(`${splitFile(dir)}.bak`), false);
    const afterFirst = readFileSync(splitFile(dir), 'utf8');
    jobs.create({ secretScalar: scalar(2), publicPoint: point('b') });
    assert.equal(readFileSync(`${splitFile(dir)}.bak`, 'utf8'), afterFirst);
    const afterSecond = readFileSync(splitFile(dir), 'utf8');
    jobs.remove(first.id);
    assert.equal(readFileSync(`${splitFile(dir)}.bak`, 'utf8'), afterSecond);
    assert.deepEqual(readdirSync(dir).sort(), ['splitJobs.json', 'splitJobs.json.bak']);
    if (process.platform !== 'win32') assert.equal(statSync(splitFile(dir)).mode & 0o777, 0o600);
  });
});

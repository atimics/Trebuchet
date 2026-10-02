import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

// Every test uses a temp folder. Set it before the modules are used.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-reset-archive-'));
process.env.TREBUCHET_CONFIG_DIR = path.join(root, 'initial');

const secretPinStore = await import('../secretPinStore.js');
const secretStore = await import('../secretStore.js');
const pendingWallets = await import('../pendingWallets.js');
const vanityCaStore = await import('../vanityCaStore.js');
const splitJobStore = await import('../splitJobStore.js');
const nftCollectionStore = await import('../nftCollectionStore.js');
const { archiveSecrets } = await import('../secretArchive.js');
const { secretInventory } = await import('../secretInventory.js');
const { resetWithArchive, RESET_PHRASE } = await import('../secretReset.js');

const PIN = '4821';
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const bytes = (n) => Array.from(crypto.randomBytes(n));

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function freshConfig(t) {
  const dir = fs.mkdtempSync(path.join(root, 'cfg-'));
  process.env.TREBUCHET_CONFIG_DIR = dir;
  secretPinStore.lock();
  secretStore.setSafeStorage({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`wrapped:${text}`, 'utf8'),
    decryptString: (buffer) => buffer.toString('utf8').replace(/^wrapped:/, ''),
  });
  t.after(() => { secretPinStore.lock(); secretStore.setSafeStorage(null); });
  return dir;
}

/** A PIN, two wallets, a seed and a scalar vanity key, a split job and an NFT key. */
function seed(dir) {
  secretPinStore.setPin(PIN);
  const secrets = {
    walletKey: bytes(64),
    walletKey2: bytes(64),
    mnemonic: 'test seed words alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima',
    vanitySeed: bytes(64),
    vanityScalar: bytes(32),
    split: bytes(32),
    nft: bytes(32),
  };
  pendingWallets.add('WalletAAAA1111', secrets.walletKey, secrets.mnemonic);
  pendingWallets.add('WalletBBBB2222', secrets.walletKey2, null);
  vanityCaStore.add({ publicKey: 'VanitySeed1111', secretKey: secrets.vanitySeed, attempts: 123456789, epochs: 3 });
  vanityCaStore.add({ publicKey: 'VanityScalar1111', keyType: 'scalar', scalar: secrets.vanityScalar, attempts: 987654321 });
  const job = splitJobStore.create({ secretScalar: secrets.split, publicPoint: 'ab'.repeat(32), prefix: 'AB' });
  const collection = nftCollectionStore.create({ name: 'Test' });
  nftCollectionStore.update(collection.id, (record) => {
    record.collectionKey = nftCollectionStore.keyRecord({ scalar: Uint8Array.from(secrets.nft), address: 'NftKeyAddr1111' });
    return record;
  });
  return { secrets, jobId: job.id, collectionId: collection.id, dir };
}

function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.name === 'secret-archive') continue;
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full);
    }
  };
  walk(dir);
  return out;
}

function assertSnapshotEqual(dir, before) {
  const after = snapshot(dir);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const [name, content] of Object.entries(before)) {
    assert.ok(after[name].equals(content), `${name} changed`);
  }
}

function collectSecretNeedles(dir, secrets) {
  const needles = [
    ...[secrets.walletKey, secrets.walletKey2, secrets.vanitySeed, secrets.vanityScalar, secrets.split, secrets.nft].map((a) => JSON.stringify(a)),
    secrets.mnemonic,
    PIN,
  ];
  // Ciphertext tokens must not be returned either.
  for (const content of Object.values(snapshot(dir))) {
    for (const match of content.toString('utf8').matchAll(/"((?:pin|enc|plain):[^"]+)"/g)) needles.push(match[1]);
  }
  return needles;
}

test('reset archives every encrypted file byte for byte, then removes the PIN', (t) => {
  const dir = freshConfig(t);
  const { secrets, collectionId } = seed(dir);
  secretPinStore.lock();
  const before = snapshot(dir);
  assert.ok(before['.secretPin.json']);

  const result = resetWithArchive({ confirmReset: RESET_PHRASE });
  assert.match(result.archive.path, /^secret-archive[\\/]reset-/);
  const archiveDir = path.join(dir, result.archive.path);
  assert.ok(fs.statSync(archiveDir).isDirectory());
  assert.ok(result.archive.files >= 5);
  assert.ok(fs.existsSync(path.join(archiveDir, '.secretPin.json')));

  for (const rel of ['.secretPin.json', 'pendingWallets.json', 'vanityCAs.json', 'splitJobs.json', path.join('nftCollections', collectionId, 'collection.json')]) {
    const copy = fs.readFileSync(path.join(archiveDir, rel));
    assert.ok(copy.equals(before[rel]), `${rel} is not byte-identical`);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(archiveDir, rel)).mode & 0o777, 0o600, `${rel} mode`);
  }
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(archiveDir).mode & 0o077, 0, 'archive dir is private');
  }
  // The reset really happened.
  assert.equal(fs.existsSync(path.join(dir, '.secretPin.json')), false);
  assert.equal(result.removed.pendingWallets, 2);
  assert.equal(result.removed.vanityCAs, 2);
  assert.equal(result.removed.splitJobs, 1);
  assert.equal(result.removed.nftKeys, 1);
  assert.ok(secrets);
});

test('a failed archive refuses the reset and deletes nothing', (t) => {
  const dir = freshConfig(t);
  seed(dir);
  secretPinStore.lock();
  const before = snapshot(dir);

  // Stubbed copy failure.
  assert.throws(
    () => resetWithArchive({ confirmReset: RESET_PHRASE, archive: () => { throw new Error('disk full'); } }),
    (error) => error.message === 'disk full',
  );
  assertSnapshotEqual(dir, before);

  // Real failure: the archive location cannot be created (a file sits in its place).
  const blocker = path.join(dir, 'secret-archive');
  fs.writeFileSync(blocker, 'not a folder');
  assert.throws(
    () => resetWithArchive({ confirmReset: RESET_PHRASE }),
    (error) => error.code === 'SECRET_ARCHIVE_FAILED' && error.statusCode === 500,
  );
  assert.equal(fs.readFileSync(blocker, 'utf8'), 'not a folder');
  assertSnapshotEqual(dir, before);
  assert.ok(fs.existsSync(path.join(dir, '.secretPin.json')));
});

test('the typed phrase is still required', (t) => {
  const dir = freshConfig(t);
  seed(dir);
  secretPinStore.lock();
  const before = snapshot(dir);
  assert.throws(() => resetWithArchive({ confirmReset: 'reset' }), (error) => error.statusCode === 400);
  assertSnapshotEqual(dir, before);
  assert.equal(fs.existsSync(path.join(dir, 'secret-archive')), false);
});

test('reset is refused with 409 while the PIN is unlocked and a key is readable', (t) => {
  const dir = freshConfig(t);
  seed(dir);
  assert.equal(secretPinStore.isUnlocked(), true);
  const before = snapshot(dir);
  assert.equal(secretInventory().resetAllowed, false);
  assert.throws(
    () => resetWithArchive({ confirmReset: RESET_PHRASE }),
    (error) => error.statusCode === 409 && error.code === 'SECRET_PIN_RESET_KEYS_READABLE',
  );
  assertSnapshotEqual(dir, before);
  assert.equal(fs.existsSync(path.join(dir, 'secret-archive')), false);
});

test('inventory classifies readable, locked, wrong-key and missing, and returns no secret', (t) => {
  const dir = freshConfig(t);
  const { secrets } = seed(dir);

  // Add a wrong-key wallet (tampered ciphertext) and a missing wallet (no secret field).
  const file = path.join(dir, 'pendingWallets.json');
  const records = JSON.parse(fs.readFileSync(file, 'utf8'));
  const donor = records[0].secretKeyEnc;
  const tampered = donor.slice(0, -6) + (donor.endsWith('AAAAAA') ? 'BBBBBB' : 'AAAAAA');
  records.push({ publicKey: 'WalletWrongKey3333', createdAt: '2026-01-01T00:00:00.000Z', secretKeyEnc: tampered });
  records.push({ publicKey: 'WalletMissing4444', createdAt: '2026-01-01T00:00:00.000Z' });
  fs.writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`);

  const needles = collectSecretNeedles(dir, secrets);
  const unlocked = secretInventory();
  const byKey = (inv, key) => inv.stores.pendingWallets.find((item) => item.publicKey === key);
  assert.equal(byKey(unlocked, 'WalletAAAA1111').state, 'readable');
  assert.equal(byKey(unlocked, 'WalletAAAA1111').hasMnemonic, true);
  assert.equal(byKey(unlocked, 'WalletBBBB2222').hasMnemonic, false);
  assert.equal(byKey(unlocked, 'WalletWrongKey3333').state, 'wrong-key');
  assert.equal(byKey(unlocked, 'WalletMissing4444').state, 'missing');
  assert.equal(byKey(unlocked, 'WalletMissing4444').wouldBeLostByReset, false);
  assert.equal(unlocked.stores.vanityCAs.find((i) => i.publicKey === 'VanityScalar1111').kind, 'vanity scalar key');
  assert.equal(unlocked.stores.vanityCAs.find((i) => i.publicKey === 'VanitySeed1111').attempts, 123456789);
  assert.equal(unlocked.stores.vanityCAs.find((i) => i.publicKey === 'VanitySeed1111').epochs, 3);
  assert.equal(unlocked.stores.splitJobs[0].state, 'readable');
  assert.equal(unlocked.stores.nftKeys[0].state, 'readable');
  assert.equal(unlocked.totals.missing, 1);

  secretPinStore.lock();
  const locked = secretInventory();
  assert.equal(byKey(locked, 'WalletAAAA1111').state, 'locked');
  assert.equal(locked.totals.readable, 0);
  assert.equal(locked.totals.locked >= 6, true);
  assert.equal(locked.totals.missing, 1);
  assert.equal(locked.resetAllowed, true);
  assert.ok(locked.wouldBeLostByReset.length >= 6);

  for (const inventory of [unlocked, locked]) {
    const json = JSON.stringify(inventory);
    for (const needle of needles) assert.equal(json.includes(needle), false, 'inventory leaked a secret or token');
    assert.doesNotMatch(json, /secretKey|scalarEnc|secretEnc|mnemonicEnc/);
  }
});

test('copying the archive back and unlocking with the original PIN restores every secret', (t) => {
  const dir = freshConfig(t);
  const { secrets, jobId, collectionId } = seed(dir);
  const expected = {
    wallet: sha(JSON.stringify(secrets.walletKey)),
    mnemonic: sha(secrets.mnemonic),
    vanity: sha(JSON.stringify(secrets.vanityScalar)),
    split: sha(JSON.stringify(secrets.split)),
    nft: sha(JSON.stringify(secrets.nft)),
  };
  secretPinStore.lock();
  const result = resetWithArchive({ confirmReset: RESET_PHRASE });
  assert.equal(pendingWallets.list().length, 0);

  const archiveDir = path.join(dir, result.archive.path);
  const copyBack = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const target = path.join(dir, path.relative(archiveDir, full));
      if (entry.isDirectory()) { fs.mkdirSync(target, { recursive: true }); copyBack(full); } else fs.copyFileSync(full, target);
    }
  };
  copyBack(archiveDir);

  assert.equal(secretPinStore.unlock(PIN), true);
  const wallet = pendingWallets.get('WalletAAAA1111');
  assert.equal(sha(JSON.stringify(wallet.secretKey)), expected.wallet);
  assert.equal(sha(wallet.mnemonic), expected.mnemonic);
  assert.equal(sha(JSON.stringify(vanityCaStore.get('VanityScalar1111').scalar)), expected.vanity);
  assert.equal(sha(JSON.stringify(splitJobStore.getWithSecret(jobId).secretScalar)), expected.split);
  const record = nftCollectionStore.get(collectionId);
  assert.equal(sha(JSON.stringify(Array.from(nftCollectionStore.keyScalar(record.collectionKey)))), expected.nft);
  assert.equal(secretInventory().totals.readable, secretInventory().totals.total);
});

test('archiveSecrets works with no files at all', (t) => {
  freshConfig(t);
  const result = archiveSecrets();
  assert.deepEqual(result.files, []);
});

test('server wires the reset and inventory routes to the tested functions', () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /resetWithArchive\(\{ confirmReset: req\.body\?\.confirmReset \}\)/);
  assert.match(server, /app\.get\('\/api\/secret-pin\/inventory'/);
});

test('walletSecretReason is honest about missing, wrong-key and locked keys', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL('../public/v2/runtime-state.js', import.meta.url), 'utf8'), sandbox);
  const { walletSecretReason: walletLockReason } = sandbox.window.TrebuchetV2RuntimeState;
  const missing = walletLockReason({ wallet: { secretState: 'missing', decryptionFailed: true }, secretPin: { locked: true } });
  assert.equal(missing.state, 'missing');
  assert.equal(missing.canUnlock, false);
  assert.equal(missing.canReset, false);
  assert.match(missing.detail, /gone from this computer\. Unlocking will not help\. Restore it from a backup, or create a new wallet\./);
  const wrong = walletLockReason({ wallet: { secretState: 'wrong-key' }, secretPin: { unlocked: true } });
  assert.equal(wrong.state, 'wrong-key');
  assert.equal(wrong.canUnlock, false);
  assert.match(wrong.detail, /different PIN/);
  const locked = walletLockReason({ wallet: { secretState: 'locked' }, secretPin: { locked: true } });
  assert.equal(locked.state, 'locked');
  assert.equal(locked.canUnlock, true);
  assert.equal(walletLockReason({ wallet: { secretState: 'readable', hasSecretKey: true }, secretPin: {} }).state, 'readable');
});

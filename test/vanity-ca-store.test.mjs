import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';

const vanity = Keypair.fromSeed(new Uint8Array(32).fill(12));
const vanityPublicKey = vanity.publicKey.toBase58();
const vanitySecret = Array.from(vanity.secretKey);

import * as secretStore from '../secretStore.js';

let importCounter = 0;

function makeTempConfigDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trebuchet-vanity-ca-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function importFreshStore(configDir) {
  process.env.TREBUCHET_CONFIG_DIR = configDir;
  return import(new URL(`../vanityCaStore.js?case=${++importCounter}`, import.meta.url));
}

function storeFile(configDir) {
  return path.join(configDir, 'vanityCAs.json');
}

async function withMutedConsole(fn) {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = originalWarn;
  }
}

test('persists vanity CA candidates without exposing secret metadata in listMetadata', async (t) => {
  await withMutedConsole(async () => {
    const configDir = makeTempConfigDir(t);
    secretStore.lockSecretPin();
    secretStore.setSafeStorage(null);
    const store = await importFreshStore(configDir);

    store.add({
      publicKey: vanityPublicKey,
      secretKey: vanitySecret,
      rarity: 'Common',
      attempts: 42,
      epochs: 0.7,
      target: 'Van...111',
      prefix: 'Van',
      suffix: '111',
      mode: 'both',
    });

    assert.deepEqual(store.get(vanityPublicKey).secretKey, vanitySecret);
    assert.deepEqual(store.listMetadata(), [
      {
        publicKey: vanityPublicKey,
        createdAt: store.list()[0].createdAt,
        rarity: 'Common',
        epochs: 0.7,
        attempts: 42,
        expectedAttempts: null,
        target: 'Van...111',
        prefix: 'Van',
        suffix: '111',
        mode: 'both',
        caseInsensitive: false,
        addressLength: null,
        keyType: 'seed',
        hasSecretKey: true,
        decryptionFailed: false,
        persisted: true,
      },
    ]);

    const disk = JSON.parse(readFileSync(storeFile(configDir), 'utf8'));
    assert.equal(disk[0].secretKey, undefined);
    assert.equal(disk[0].secretKeyEnc, `plain:${JSON.stringify(vanitySecret)}`);

    store.remove(vanityPublicKey);
    assert.deepEqual(store.list(), []);
  });
});

test('stores vanity CA secrets with the configured Recovery PIN', async (t) => {
  await withMutedConsole(async () => {
    const configDir = makeTempConfigDir(t);
    process.env.TREBUCHET_CONFIG_DIR = configDir;
    secretStore.setSafeStorage(null);
    secretStore.setupSecretPin('1357');
    t.after(() => secretStore.lockSecretPin());
    const store = await importFreshStore(configDir);

    store.add({
      publicKey: vanityPublicKey,
      secretKey: vanitySecret,
      rarity: 'Rare',
    });

    const disk = JSON.parse(readFileSync(storeFile(configDir), 'utf8'));
    assert.match(disk[0].secretKeyEnc, /^pin:/);
    assert.deepEqual(store.get(vanityPublicKey).secretKey, vanitySecret);

    secretStore.lockSecretPin();
    assert.equal(store.get(vanityPublicKey).secretKey, undefined);
    assert.equal(store.listMetadata()[0].decryptionFailed, true);

    assert.equal(secretStore.unlockSecretPin('1357'), true);
    assert.deepEqual(store.get(vanityPublicKey).secretKey, vanitySecret);
  });
});

test('removes only PIN-encrypted Vanity CAs during destructive PIN reset', async (t) => {
  await withMutedConsole(async () => {
    const configDir = makeTempConfigDir(t);
    secretStore.lockSecretPin();
    secretStore.setSafeStorage(null);
    writeFileSync(
      storeFile(configDir),
      JSON.stringify([
        {
          publicKey: 'PinVanity1111111111111111111111111111111',
          createdAt: '2026-01-02T03:04:05.000Z',
          rarity: 'Rare',
          secretKeyEnc: 'pin:discarded',
        },
        {
          publicKey: 'PlainVanity11111111111111111111111111111',
          createdAt: '2026-01-02T03:04:05.000Z',
          rarity: 'Common',
          secretKeyEnc: 'plain:[1,2,3]',
        },
      ]) + '\n',
    );

    const store = await importFreshStore(configDir);

    assert.equal(store.removePinEncrypted(), 1);
    assert.deepEqual(store.list().map((entry) => ({
      publicKey: entry.publicKey,
      secretKey: entry.secretKey,
      rarity: entry.rarity,
    })), [
      {
        publicKey: 'PlainVanity11111111111111111111111111111',
        secretKey: [1, 2, 3],
        rarity: 'Common',
      },
    ]);
  });
});

test('invalid imported keys leave saved candidates and ciphertext intact', async (t) => {
  await withMutedConsole(async () => {
    const configDir = makeTempConfigDir(t);
    secretStore.lockSecretPin();
    secretStore.setSafeStorage(null);
    const store = await importFreshStore(configDir);
    store.add({ publicKey: vanityPublicKey, secretKey: vanitySecret });
    const before = readFileSync(storeFile(configDir), 'utf8');
    for (const entry of [
      { publicKey: vanityPublicKey, secretKey: vanitySecret.slice(0, 32) },
      { publicKey: vanityPublicKey, secretKey: vanitySecret.map((byte) => byte + 256) },
      { publicKey: Keypair.generate().publicKey.toBase58(), secretKey: vanitySecret },
    ]) {
      assert.throws(() => store.add(entry), { code: 'INVALID_VANITY_KEY' });
      assert.equal(readFileSync(storeFile(configDir), 'utf8'), before);
    }
  });
});

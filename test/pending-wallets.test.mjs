import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as secretStore from '../secretStore.js';

let importCounter = 0;

function makeTempConfigDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trebuchet-pending-wallets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function importFreshPendingWallets(configDir) {
  process.env.TREBUCHET_CONFIG_DIR = configDir;
  return import(new URL(`../pendingWallets.js?case=${++importCounter}`, import.meta.url));
}

function pendingWalletFile(configDir) {
  return path.join(configDir, 'pendingWallets.json');
}

async function withMutedConsole(fn) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => Buffer.from(`wrapped:${plaintext}`, 'utf8'),
    decryptString: (buffer) => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('wrapped:')) throw new Error('bad ciphertext');
      return text.slice('wrapped:'.length);
    },
  };
}

test('adds pending wallets idempotently and removes them', async (t) => {
  await withMutedConsole(async () => {
    const configDir = makeTempConfigDir(t);
    secretStore.setSafeStorage(null);
    const pendingWallets = await importFreshPendingWallets(configDir);

    pendingWallets.add('Wallet1111111111111111111111111111111111', [1, 2, 3], 'alpha beta');
    pendingWallets.add('Wallet1111111111111111111111111111111111', [9, 9, 9], 'changed');

    const list = pendingWallets.list();
    assert.deepEqual(list, [
      {
        publicKey: 'Wallet1111111111111111111111111111111111',
        createdAt: list[0].createdAt,
        secretKey: [1, 2, 3],
        mnemonic: 'alpha beta',
      },
    ]);

    const disk = JSON.parse(readFileSync(pendingWalletFile(configDir), 'utf8'));
    assert.equal(disk.length, 1);
    assert.equal(disk[0].secretKey, undefined);
    assert.equal(disk[0].mnemonic, undefined);
    assert.equal(disk[0].secretKeyEnc, 'plain:[1,2,3]');
    assert.equal(disk[0].mnemonicEnc, 'plain:alpha beta');

    pendingWallets.remove('Wallet1111111111111111111111111111111111');
    assert.deepEqual(pendingWallets.list(), []);
  });
});

test('repairs an existing encrypted wallet through an available encrypted backend', async (t) => {
  await withMutedConsole(async () => {
    const configDir = makeTempConfigDir(t);
    secretStore.setSafeStorage(fakeSafeStorage());
    writeFileSync(
      pendingWalletFile(configDir),
      `${JSON.stringify([{
        publicKey: 'Repair111111111111111111111111111111111',
        createdAt: '2026-01-02T03:04:05.000Z',
        secretKeyEnc: 'enc:not-decryptable-here',
        mnemonicEnc: 'enc:not-decryptable-here',
      }], null, 2)}\n`,
    );
    const pendingWallets = await importFreshPendingWallets(configDir);

    const repaired = pendingWallets.add(
      'Repair111111111111111111111111111111111',
      [9, 8, 7],
      'replacement seed words',
    );

    assert.deepEqual(repaired.secretKey, [9, 8, 7]);
    assert.equal(repaired.mnemonic, 'replacement seed words');
    assert.deepEqual(
      pendingWallets.get('Repair111111111111111111111111111111111').secretKey,
      [9, 8, 7],
    );
  });
});

test('fails closed when a generated wallet cannot be persisted', async (t) => {
  await withMutedConsole(async () => {
    const root = makeTempConfigDir(t);
    const invalidConfigDir = path.join(root, 'not-a-directory');
    writeFileSync(invalidConfigDir, 'occupied');
    secretStore.setSafeStorage(null);
    const pendingWallets = await importFreshPendingWallets(invalidConfigDir);

    assert.throws(
      () => pendingWallets.add('Unsaved11111111111111111111111111111111', [1, 2, 3], 'seed words'),
      (error) => error?.code === 'RECOVERY_STORAGE_UNAVAILABLE' && error?.statusCode === 500,
    );
  });
});

test('persists non-secret vanity rarity metadata for wallet styling', async (t) => {
  await withMutedConsole(async () => {
    const configDir = makeTempConfigDir(t);
    secretStore.setSafeStorage(null);
    const pendingWallets = await importFreshPendingWallets(configDir);
    const publicKey = 'RareWallet1111111111111111111111111111111';

    pendingWallets.add(publicKey, [4, 5, 6], null, {
      rarity: 'Legendary',
      vanity: true,
    });

    assert.deepEqual(pendingWallets.list(), [
      {
        publicKey,
        createdAt: pendingWallets.list()[0].createdAt,
        rarity: 'Legendary',
        vanity: true,
        secretKey: [4, 5, 6],
      },
    ]);

    const disk = JSON.parse(readFileSync(pendingWalletFile(configDir), 'utf8'));
    assert.equal(disk[0].rarity, 'Legendary');
    assert.equal(disk[0].vanity, true);
    assert.equal(disk[0].secretKey, undefined);
    assert.equal(disk[0].secretKeyEnc, 'plain:[4,5,6]');
  });
});

test('migrates legacy plaintext entries when encryption is available', async (t) => {
  await withMutedConsole(async () => {
    const configDir = makeTempConfigDir(t);
    secretStore.setSafeStorage(fakeSafeStorage());
    writeFileSync(
      pendingWalletFile(configDir),
      JSON.stringify([
        {
          publicKey: 'Legacy111111111111111111111111111111111',
          createdAt: '2026-01-02T03:04:05.000Z',
          secretKey: [4, 5, 6],
          mnemonic: 'old seed words',
        },
      ]) + '\n',
    );

    const pendingWallets = await importFreshPendingWallets(configDir);

    assert.deepEqual(pendingWallets.list(), [
      {
        publicKey: 'Legacy111111111111111111111111111111111',
        createdAt: '2026-01-02T03:04:05.000Z',
        secretKey: [4, 5, 6],
        mnemonic: 'old seed words',
      },
    ]);

    const disk = JSON.parse(readFileSync(pendingWalletFile(configDir), 'utf8'));
    assert.equal(disk[0].secretKey, undefined);
    assert.equal(disk[0].mnemonic, undefined);
    assert.match(disk[0].secretKeyEnc, /^enc:/);
    assert.match(disk[0].mnemonicEnc, /^enc:/);
  });
});

test('preserves malformed pending-wallet bytes and requires recovery for reads and writes', async (t) => {
  await withMutedConsole(async () => {
    const configDir = makeTempConfigDir(t);
    secretStore.lockSecretPin();
    secretStore.setSafeStorage(null);
    writeFileSync(pendingWalletFile(configDir), '{not json');

    const pendingWallets = await importFreshPendingWallets(configDir);

    for (const action of [() => pendingWallets.list(), () => pendingWallets.add('new', [1, 2, 3]), () => pendingWallets.remove('old'), () => pendingWallets.removePinEncrypted()]) {
      assert.throws(action, { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
      assert.equal(readFileSync(pendingWalletFile(configDir), 'utf8'), '{not json');
    }
  });
});

test('stores pending wallet secrets with the configured Recovery PIN', async (t) => {
  await withMutedConsole(async () => {
    const configDir = makeTempConfigDir(t);
    process.env.TREBUCHET_CONFIG_DIR = configDir;
    secretStore.setSafeStorage(null);
    secretStore.setupSecretPin('2468');
    t.after(() => secretStore.lockSecretPin());

    const pendingWallets = await importFreshPendingWallets(configDir);
    pendingWallets.add('PinWallet11111111111111111111111111111111', [7, 8, 9], 'pin seed words');

    const disk = JSON.parse(readFileSync(pendingWalletFile(configDir), 'utf8'));
    assert.match(disk[0].secretKeyEnc, /^pin:/);
    assert.match(disk[0].mnemonicEnc, /^pin:/);
    assert.deepEqual(pendingWallets.get('PinWallet11111111111111111111111111111111').secretKey, [7, 8, 9]);

    secretStore.lockSecretPin();
    assert.equal(pendingWallets.get('PinWallet11111111111111111111111111111111').secretKey, undefined);

    assert.equal(secretStore.unlockSecretPin('2468'), true);
    assert.deepEqual(pendingWallets.get('PinWallet11111111111111111111111111111111').secretKey, [7, 8, 9]);
  });
});

test('removes only PIN-encrypted pending wallets during destructive PIN reset', async (t) => {
  await withMutedConsole(async () => {
    const configDir = makeTempConfigDir(t);
    secretStore.lockSecretPin();
    secretStore.setSafeStorage(null);
    writeFileSync(
      pendingWalletFile(configDir),
      JSON.stringify([
        {
          publicKey: 'PinWallet11111111111111111111111111111111',
          createdAt: '2026-01-02T03:04:05.000Z',
          secretKeyEnc: 'pin:discarded',
          mnemonicEnc: 'pin:discarded-mnemonic',
        },
        {
          publicKey: 'PlainWallet111111111111111111111111111111',
          createdAt: '2026-01-02T03:04:05.000Z',
          secretKeyEnc: 'plain:[1,2,3]',
          mnemonicEnc: 'plain:still recoverable',
        },
      ]) + '\n',
    );

    const pendingWallets = await importFreshPendingWallets(configDir);

    assert.equal(pendingWallets.removePinEncrypted(), 1);
    assert.deepEqual(pendingWallets.list(), [
      {
        publicKey: 'PlainWallet111111111111111111111111111111',
        createdAt: '2026-01-02T03:04:05.000Z',
        secretKey: [1, 2, 3],
        mnemonic: 'still recoverable',
      },
    ]);
  });
});

test('adding and removing another wallet preserves unreadable ciphertext and record metadata', async (t) => {
  await withMutedConsole(async () => {
    const configDir = makeTempConfigDir(t);
    secretStore.lockSecretPin();
    secretStore.setSafeStorage(null);
    const original = { publicKey: 'encrypted-wallet', createdAt: '2026-01-01T00:00:00Z', secretKeyEnc: 'enc:device-key', mnemonicEnc: 'enc:device-words', recoveryNote: 'Retain this record' };
    writeFileSync(pendingWalletFile(configDir), JSON.stringify([original]) + '\n');
    const pendingWallets = await importFreshPendingWallets(configDir);
    pendingWallets.add('new-wallet', [1, 2, 3]);
    assert.deepEqual(JSON.parse(readFileSync(pendingWalletFile(configDir)))[0], original);
    pendingWallets.remove('new-wallet');
    assert.deepEqual(JSON.parse(readFileSync(pendingWalletFile(configDir))), [original]);
    assert.equal(pendingWallets.get('encrypted-wallet').secretKey, undefined);
  });
});

test('migration retains exact original bytes and commits private encrypted records', async (t) => {
  await withMutedConsole(async () => {
    const configDir = makeTempConfigDir(t);
    secretStore.setSafeStorage(fakeSafeStorage());
    const source = '[ { "publicKey": "legacy", "secretKey": [4,5,6], "mnemonic": "original words" } ]\n';
    writeFileSync(pendingWalletFile(configDir), source);
    const pendingWallets = await importFreshPendingWallets(configDir);
    assert.deepEqual(pendingWallets.get('legacy').secretKey, [4, 5, 6]);
    const files = readdirSync(configDir);
    const backups = files.filter((name) => name.includes('.migration-'));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(path.join(configDir, backups[0]), 'utf8'), source);
    assert.match(JSON.parse(readFileSync(pendingWalletFile(configDir)))[0].secretKeyEnc, /^enc:/);
    if (process.platform !== 'win32') {
      assert.equal(statSync(pendingWalletFile(configDir)).mode & 0o777, 0o600);
      assert.equal(statSync(path.join(configDir, backups[0])).mode & 0o777, 0o600);
    }
    pendingWallets.list();
    assert.equal(readdirSync(configDir).filter((name) => name.includes('.migration-')).length, 1);
  });
});

test('a failed rename or sync preserves the previous wallet file and clears temporary files', async (t) => {
  const { default: fs } = await import('node:fs');
  for (const method of ['renameSync', 'fsyncSync']) {
    await withMutedConsole(async () => {
      const configDir = makeTempConfigDir(t);
      secretStore.setSafeStorage(null);
      const pendingWallets = await importFreshPendingWallets(configDir);
      pendingWallets.add('prior-wallet', [1, 2, 3]);
      const original = readFileSync(pendingWalletFile(configDir));
      const saved = fs[method];
      fs[method] = () => { throw new Error(`Interrupted ${method}`); };
      try {
        assert.throws(() => pendingWallets.add('new-wallet', [4, 5, 6]), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
      } finally { fs[method] = saved; }
      assert.deepEqual(readFileSync(pendingWalletFile(configDir)), original);
      assert.deepEqual(readdirSync(configDir), ['pendingWallets.json']);
      assert.deepEqual(pendingWallets.get('prior-wallet').secretKey, [1, 2, 3]);
    });
  }
});

test('migration backup failure preserves the original recovery file', async (t) => {
  await withMutedConsole(async () => {
    const { default: fs } = await import('node:fs');
    const configDir = makeTempConfigDir(t);
    secretStore.setSafeStorage(fakeSafeStorage());
    const original = '[{"publicKey":"legacy","secretKey":[1,2,3]}]\n';
    writeFileSync(pendingWalletFile(configDir), original);
    const pendingWallets = await importFreshPendingWallets(configDir);
    const saved = fs.fsyncSync;
    fs.fsyncSync = () => { throw new Error('Backup sync interrupted'); };
    try { assert.throws(() => pendingWallets.list(), { code: 'RECOVERY_STORAGE_UNAVAILABLE' }); }
    finally { fs.fsyncSync = saved; }
    assert.equal(readFileSync(pendingWalletFile(configDir), 'utf8'), original);
    assert.deepEqual(pendingWallets.list()[0].secretKey, [1, 2, 3]);
  });
});

test('an existing encrypted key requires encrypted custody for replacement', async (t) => {
  await withMutedConsole(async () => {
    const configDir = makeTempConfigDir(t);
    secretStore.setSafeStorage(null);
    const original = '[{"publicKey":"repair","secretKeyEnc":"enc:device-key"}]\n';
    writeFileSync(pendingWalletFile(configDir), original);
    const pendingWallets = await importFreshPendingWallets(configDir);
    assert.throws(() => pendingWallets.add('repair', [1, 2, 3]), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    assert.equal(readFileSync(pendingWalletFile(configDir), 'utf8'), original);
  });
});

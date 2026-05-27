import test from 'node:test';
import assert from 'node:assert/strict';

let importCounter = 0;

async function importFreshSecretStore() {
  return import(new URL(`../secretStore.js?case=${++importCounter}`, import.meta.url));
}

async function withMutedWarn(fn) {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = originalWarn;
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

test('falls back to tagged plaintext when safeStorage is unavailable', async () => {
  await withMutedWarn(async () => {
    const secretStore = await importFreshSecretStore();

    const token = secretStore.encryptString('launch wallet secret');

    assert.equal(token, 'plain:launch wallet secret');
    assert.equal(secretStore.decryptString(token), 'launch wallet secret');
    assert.equal(secretStore.decryptString('legacy plaintext'), 'legacy plaintext');
    assert.equal(secretStore.decryptString(''), null);
    assert.equal(secretStore.isEncrypting(), false);
  });
});

test('uses safeStorage when encryption is available', async () => {
  const secretStore = await importFreshSecretStore();
  secretStore.setSafeStorage(fakeSafeStorage());

  const token = secretStore.encryptString('launch wallet secret');

  assert.match(token, /^enc:/);
  assert.equal(secretStore.decryptString(token), 'launch wallet secret');
  assert.equal(secretStore.isEncrypting(), true);
});

test('returns null instead of throwing when encrypted tokens cannot be decrypted', async () => {
  await withMutedWarn(async () => {
    const secretStore = await importFreshSecretStore();
    secretStore.setSafeStorage(fakeSafeStorage());

    assert.equal(secretStore.decryptString('enc:' + Buffer.from('garbage').toString('base64')), null);
  });
});

test('validates plaintext type before encrypting', async () => {
  const secretStore = await importFreshSecretStore();

  assert.throws(() => secretStore.encryptString(null), /expects a string/);
});

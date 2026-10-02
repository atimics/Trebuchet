import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const route = server.slice(
  server.indexOf("app.post('/api/vanity-ca-candidates/import'"),
  server.indexOf('// SSE streaming endpoint for vanity CA grind progress'),
);

test('vanity import derives the public key from the secret and checks the pattern', () => {
  assert.ok(route.length > 0, 'import route exists');
  assert.match(route, /Keypair\.fromSecretKey\(bytes\)\.publicKey\.toBase58\(\)/);
  assert.doesNotMatch(route, /req\.body\?\.publicKey/, 'the request cannot choose the public key');
  assert.match(route, /does not match the requested pattern/);
  assert.match(route, /rejectIfSecretPinLocked/);
});

test('vanity import responds with metadata only', () => {
  assert.match(route, /vanityCaStore\.listMetadata\(\)/);
  assert.doesNotMatch(route, /res\.json\(\{[^}]*secretKey/);
});

test('the grinder has a libsodium backend that replaces tweetnacl', () => {
  const c = fs.readFileSync(new URL('../c/vanity_keygen/vanity_keygen.c', import.meta.url), 'utf8');
  assert.match(c, /crypto_sign_seed_keypair\(pk, sk, seed\)/);
  assert.match(c, /#ifndef TREBUCHET_SODIUM\n#include "tweetnacl.h"/);
  assert.match(c, /sodium_init\(\) < 0/);
});

test('vanity import accepts a split-key scalar and derives the address from it', () => {
  assert.match(route, /scalarPublicKey\(scalarBytes\)/);
  assert.match(route, /scalar must be a 32-byte array/);
  assert.match(route, /keyType: 'scalar', scalar: Array\.from\(scalarBytes\)/);
  assert.doesNotMatch(route, /req\.body\?\.publicKey/);
});

test('a scalar imported through the store round-trips to the same address', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-scalar-import-'));
  const previous = process.env.TREBUCHET_CONFIG_DIR;
  process.env.TREBUCHET_CONFIG_DIR = dir;
  try {
    const { createSplitSecret, scalarPublicKey } = await import('@trebuchet/core/split-key');
    const { PublicKey } = await import('@solana/web3.js');
    const store = await import('../vanityCaStore.js');
    const { secretScalar } = createSplitSecret();
    const publicKey = new PublicKey(scalarPublicKey(secretScalar)).toBase58();
    store.add({ publicKey, keyType: 'scalar', scalar: Array.from(secretScalar), suffix: publicKey.slice(-3), mode: 'suffix' });
    const listed = store.listMetadata().find((item) => item.publicKey === publicKey);
    assert.equal(listed.keyType, 'scalar');
    assert.equal(listed.decryptionFailed, false);
    assert.equal(JSON.stringify(listed).includes(String(secretScalar[0] ?? '')) && 'scalar' in listed, false, 'metadata never includes the scalar');
  } finally {
    if (previous === undefined) delete process.env.TREBUCHET_CONFIG_DIR; else process.env.TREBUCHET_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

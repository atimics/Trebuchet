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

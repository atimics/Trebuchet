import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import {
  combineSplitKey,
  createSplitSecret,
  signWithScalar,
  splitResultAddress,
} from '../packages/core/src/split-key.js';

const binary = fileURLToPath(new URL('../c/build/vanity_keygen', import.meta.url));
const skip = existsSync(binary) ? false : 'vanity_keygen not built (npm run build:c)';
const hex = (bytes) => Buffer.from(bytes).toString('hex');

function grindSplit(publicPoint, args) {
  const out = execFileSync(binary, ['--split-point', hex(publicPoint), '--quiet', '--threads', '2', ...args]);
  return JSON.parse(out.toString());
}

test('split mode returns an offset whose A + k*G matches, and never a secret', { skip, timeout: 120000 }, () => {
  const { secretScalar, publicPoint } = createSplitSecret();
  const result = grindSplit(publicPoint, ['--suffix', 'ru']);
  assert.equal('secretKey' in result, false, 'no secret in grinder output');
  assert.match(result.offset, /^[0-9a-f]{64}$/);
  const offset = Buffer.from(result.offset, 'hex');
  // Anyone can check the result from public data.
  assert.equal(splitResultAddress(publicPoint, offset), result.publicKey);
  assert.ok(result.publicKey.endsWith('ru'));
  // Only the holder of the secret gets a working key.
  const key = combineSplitKey({ secretScalar, publicPoint, offset });
  assert.equal(key.address, result.publicKey);
  const message = new TextEncoder().encode('create mint');
  assert.ok(nacl.sign.detached.verify(message, signWithScalar(key.scalar, message), key.publicKey));
});

test('split mode honors prefix, length, and case-insensitive matching', { skip, timeout: 120000 }, () => {
  const { publicPoint } = createSplitSecret();
  const result = grindSplit(publicPoint, ['--prefix', 'ab', '--case-insensitive', '--length', '44']);
  const address = splitResultAddress(publicPoint, Buffer.from(result.offset, 'hex'));
  assert.equal(address, result.publicKey);
  assert.equal(address.slice(0, 2).toLowerCase(), 'ab');
  assert.equal(address.length, 44);
});

test('split mode rejects malformed or non-canonical points', { skip }, () => {
  for (const bad of ['zz', '00'.repeat(31), 'ff'.repeat(32)]) {
    const run = spawnSync(binary, ['--split-point', bad, '--prefix', 'A', '--quiet']);
    assert.notEqual(run.status, 0, `rejects ${bad.slice(0, 8)}...`);
  }
});

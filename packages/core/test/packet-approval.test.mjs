import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { signPacketApproval, verifyPacketApproval, solToLamports } from '../src/packet-approval.js';

const seed = randomBytes(32);
const input = {
  manifestDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64),
  walletPublicKey: '11111111111111111111111111111115', network: 'devnet',
  maxSpendLamports: '1000000001', expiresAt: '2027-01-01T00:00:00.000Z',
};
const approval = signPacketApproval(input, seed);
const now = new Date('2026-01-01T00:00:00.000Z');
const expected = { ...approval.payload };
const verify = (value = approval, options = {}) => verifyPacketApproval(value, { expected, now, ...options });

test('packet approval binds every input and the configured operator', () => {
  assert.equal(verify().valid, true);
  assert.equal(verify(signPacketApproval(input, randomBytes(32))).valid, false);
  for (const [key, value] of [
    ['manifestDigest', 'c'.repeat(64)], ['planDigest', 'c'.repeat(64)],
    ['operatorKey', 'c'.repeat(64)], ['walletPublicKey', '11111111111111111111111111111116'],
    ['network', 'mainnet'], ['maxSpendLamports', '2000000000'], ['expiresAt', '2028-01-01T00:00:00.000Z'],
  ]) {
    const changed = structuredClone(approval);
    changed.payload[key] = value;
    assert.equal(verify(changed).valid, false, key);
  }
  for (const key of ['manifestDigest', 'planDigest', 'operatorKey', 'walletPublicKey', 'network']) {
    const missing = { ...expected };
    delete missing[key];
    assert.equal(verify(approval, { expected: missing }).valid, false, key);
  }
  assert.equal(verify(approval, { expected: undefined }).valid, false);
});

test('approval expiry and integer spending ceilings hold at their boundaries', () => {
  assert.equal(verify(approval, { spendLamports: '1000000001' }).valid, true);
  assert.equal(verify(approval, { spendLamports: '1000000002' }).valid, false);
  assert.equal(verify(approval, { spendLamports: '-1' }).valid, false);
  assert.equal(verify(approval, { now: new Date(input.expiresAt) }).valid, false);
  assert.equal(verify(approval, { now: new Date('invalid') }).valid, false);
  assert.equal(solToLamports('1.000000001'), '1000000001');
  assert.equal(solToLamports('0.29'), '290000000');
  for (const value of ['1e3', '1.0000000001', '-1', 'Infinity']) assert.throws(() => solToLamports(value));
});

test('approval rejects ambiguous and extra fields', () => {
  for (const patch of [{ maxSpendLamports: 1000000001 }, { maxSpendLamports: '0' }, { walletPublicKey: null }, { network: 'local' }, { extra: true }]) {
    assert.throws(() => signPacketApproval({ ...input, ...patch }, seed));
  }
  for (const signature of [undefined, null, {}, '', approval.signature + '\n']) {
    assert.equal(verify({ ...approval, signature }).valid, false);
  }
  const changed = structuredClone(approval);
  changed.payload.extra = true;
  assert.equal(verify(changed).valid, false);
});

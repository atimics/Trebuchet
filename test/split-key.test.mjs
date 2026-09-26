import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { ed25519 } from '@noble/curves/ed25519';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  combineSplitKey,
  createSplitSecret,
  matchesVanityPattern,
  scalarPublicKey,
  signWithScalar,
  splitResultAddress,
} from '../packages/core/src/split-key.js';

function randomOffset() {
  return nacl.randomBytes(32);
}

// Walk offsets until the address starts with `prefix` (JS stand-in for the grinder).
function grind(publicPoint, prefix) {
  for (let i = 0; i < 5000; i++) {
    const offset = randomOffset();
    if (splitResultAddress(publicPoint, offset).startsWith(prefix)) return offset;
  }
  throw new Error('no match');
}

test('a customer secret and a grinder offset combine into a matching key', () => {
  const { secretScalar, publicPoint } = createSplitSecret();
  const offset = grind(publicPoint, 'A');
  const expectedAddress = splitResultAddress(publicPoint, offset);
  const combined = combineSplitKey({ secretScalar, publicPoint, offset });
  assert.equal(combined.address, expectedAddress);
  assert.ok(combined.address.startsWith('A'));
  assert.deepEqual(scalarPublicKey(combined.scalar), combined.publicKey);
  assert.ok(matchesVanityPattern(combined.address, { prefix: 'A' }));
});

test('the offset alone does not produce the key, and a wrong secret is refused', () => {
  const customer = createSplitSecret();
  const attacker = createSplitSecret();
  const offset = randomOffset();
  assert.throws(
    () => combineSplitKey({ secretScalar: attacker.secretScalar, publicPoint: customer.publicPoint, offset }),
    /does not match publicPoint/,
  );
  // Combining with the attacker's own point yields a different address.
  const theirs = combineSplitKey({ secretScalar: attacker.secretScalar, publicPoint: attacker.publicPoint, offset });
  assert.notEqual(theirs.address, splitResultAddress(customer.publicPoint, offset));
});

test('invalid customer points are rejected', () => {
  assert.throws(() => splitResultAddress(new Uint8Array(32), randomOffset()));
  // Identity point (y = 1) is small order.
  const identity = new Uint8Array(32); identity[0] = 1;
  assert.throws(() => splitResultAddress(identity, randomOffset()), /not a valid Ed25519 public key/);
});

test('signWithScalar produces standard Ed25519 signatures', () => {
  const { secretScalar, publicPoint } = createSplitSecret();
  const { scalar, publicKey } = combineSplitKey({ secretScalar, publicPoint, offset: randomOffset() });
  const message = new TextEncoder().encode('trebuchet mint signature');
  const signature = signWithScalar(scalar, message);
  assert.equal(signature.length, 64);
  assert.ok(nacl.sign.detached.verify(message, signature, publicKey), 'tweetnacl verifies');
  assert.ok(ed25519.verify(signature, message, publicKey, { zip215: false }), 'strict RFC 8032 verify');
  // Deterministic, and bound to the message.
  assert.deepEqual(signWithScalar(scalar, message), signature);
  assert.ok(!nacl.sign.detached.verify(new TextEncoder().encode('other'), signature, publicKey));
});

test('a Solana create-account transaction signed with the scalar key verifies', () => {
  const { secretScalar, publicPoint } = createSplitSecret();
  const mint = combineSplitKey({ secretScalar, publicPoint, offset: randomOffset() });
  const mintPubkey = new PublicKey(mint.publicKey);
  const payer = Keypair.generate();
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
  }).add(SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mintPubkey,
    lamports: 1_461_600,
    space: 82,
    programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
  }));
  tx.partialSign(payer);
  tx.addSignature(mintPubkey, Buffer.from(signWithScalar(mint.scalar, tx.serializeMessage())));
  assert.equal(tx.verifySignatures(), true);
  assert.ok(tx.serialize().length > 0);
});

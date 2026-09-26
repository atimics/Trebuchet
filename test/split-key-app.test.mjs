import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublicKey, SystemProgram, Transaction, Keypair } from '@solana/web3.js';
import { combineSplitKey, createSplitSecret } from '../packages/core/src/split-key.js';

process.env.TREBUCHET_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-split-'));
const vanityCaStore = await import('../vanityCaStore.js');
const splitJobStore = await import('../splitJobStore.js');

function splitKey() {
  const { secretScalar, publicPoint } = createSplitSecret();
  return combineSplitKey({ secretScalar, publicPoint, offset: new Uint8Array(32).fill(7) });
}

test('vanity store keeps scalar keys encrypted and lists metadata only', () => {
  const key = splitKey();
  vanityCaStore.add({ publicKey: key.address, keyType: 'scalar', scalar: Array.from(key.scalar), prefix: 'X' });
  const stored = vanityCaStore.get(key.address);
  assert.equal(stored.keyType, 'scalar');
  assert.deepEqual(stored.scalar, Array.from(key.scalar));
  assert.equal(stored.secretKey, undefined);
  const meta = vanityCaStore.listMetadata().find((item) => item.publicKey === key.address);
  assert.equal(meta.keyType, 'scalar');
  assert.equal(meta.hasSecretKey, true);
  assert.equal('scalar' in meta, false);
  const onDisk = fs.readFileSync(path.join(process.env.TREBUCHET_CONFIG_DIR, 'vanityCAs.json'), 'utf8');
  assert.doesNotMatch(onDisk, /"scalar"\s*:/, "no plaintext scalar field; the secret is only in secretKeyEnc");
  assert.throws(() => vanityCaStore.add({ publicKey: key.address, keyType: 'scalar', scalar: [1, 2, 3] }));
});

test('split jobs keep the secret encrypted and list public fields only', () => {
  const { secretScalar, publicPoint } = createSplitSecret();
  const job = splitJobStore.create({
    secretScalar: Array.from(secretScalar),
    publicPoint: Buffer.from(publicPoint).toString('hex'),
    prefix: 'RUG',
    suffix: 'RUG',
    expectedAttempts: 1,
  });
  assert.equal('secretScalar' in job, false);
  assert.equal(splitJobStore.list().some((item) => 'secretScalar' in item || 'secretEnc' in item), false);
  assert.deepEqual(splitJobStore.getWithSecret(job.id).secretScalar, Array.from(secretScalar));
  splitJobStore.remove(job.id);
  assert.equal(splitJobStore.getWithSecret(job.id), null);
});

test('the Token-2022 create-mint transaction verifies when signed with a scalar mint', async () => {
  const { scalarMintSigner, signWithScalarMint } = await import('../tokenService.js');
  const key = splitKey();
  const mint = scalarMintSigner(Array.from(key.scalar));
  assert.equal(mint.publicKey.toBase58(), key.address);
  const payer = Keypair.generate();
  const tx = new Transaction({ recentBlockhash: '11111111111111111111111111111111' }).add(SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mint.publicKey,
    space: 234,
    lamports: 2_500_000,
    programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
  }));
  signWithScalarMint(tx, payer, mint);
  assert.equal(tx.verifySignatures(), true);
});

test('launch refuses a split-key CA on the classic SPL path', () => {
  const source = fs.readFileSync(new URL('../tokenService.js', import.meta.url), 'utf8');
  assert.match(source, /Split-key vanity CAs need the Token-2022 mint format/);
});

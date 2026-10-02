import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';

process.env.TREBUCHET_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-dest-'));
const store = await import('../destinationProofStore.js');

function sign(keypair, message) {
  return Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey)).toString('base64');
}

test('a wallet that signs the challenge becomes a verified destination', () => {
  const wallet = Keypair.generate();
  const address = wallet.publicKey.toBase58();
  assert.equal(store.isSignedDestination(address), false);
  const challenge = store.issueChallenge(address);
  assert.match(challenge.message, new RegExp(address));
  const verified = store.verifyChallenge({ nonce: challenge.nonce, signature: sign(wallet, challenge.message) });
  assert.equal(verified.address, address);
  assert.equal(store.isSignedDestination(address), true);
  assert.ok(store.listSignedDestinations().some((entry) => entry.address === address));
});

test('a signature from another wallet is rejected', () => {
  const wallet = Keypair.generate();
  const impostor = Keypair.generate();
  const challenge = store.issueChallenge(wallet.publicKey.toBase58());
  assert.throws(
    () => store.verifyChallenge({ nonce: challenge.nonce, signature: sign(impostor, challenge.message) }),
    /does not match/,
  );
  assert.equal(store.isSignedDestination(wallet.publicKey.toBase58()), false);
});

test('a challenge works once and expires', () => {
  const wallet = Keypair.generate();
  const used = store.issueChallenge(wallet.publicKey.toBase58());
  store.verifyChallenge({ nonce: used.nonce, signature: sign(wallet, used.message) });
  assert.throws(() => store.verifyChallenge({ nonce: used.nonce, signature: sign(wallet, used.message) }), /expired or was already used/);

  const issuedAt = Date.now();
  const stale = store.issueChallenge(wallet.publicKey.toBase58(), issuedAt);
  assert.throws(
    () => store.verifyChallenge({ nonce: stale.nonce, signature: sign(wallet, stale.message) }, issuedAt + store.CHALLENGE_TTL_MS + 1),
    /expired/,
  );
});

test('typed addresses are never verified without a signature', () => {
  assert.equal(store.isSignedDestination('AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j'), false);
  assert.equal(store.isSignedDestination('not an address'), false);
  assert.throws(() => store.issueChallenge('not an address'), /valid Solana address/);
});

test('live sweep and Fee Key transfers require a proven destination', () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const services = fs.readFileSync(new URL('../launchExecution.js', import.meta.url), 'utf8');
  const sweep = services.slice(services.indexOf('async function transferAssets('), services.indexOf('const nftSweep = await sweepNftsToDestination'));
  assert.match(sweep, /unverifiedDestinationReason\(destinationWallet, walletPublicKey\)/);
  const createLp = services.slice(services.indexOf('async function createLiquidity('), services.indexOf('async function resumeLiquidity('));
  const guard = createLp.indexOf('Refusing to send Fee Keys');
  assert.ok(guard > 0 && guard < createLp.indexOf('claimLaunchOp(walletPublicKey'), 'Fee Key recipients are checked before liquidity work starts');
});

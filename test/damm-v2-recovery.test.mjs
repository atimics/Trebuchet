import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { normalizeDammV2Config } from '../packages/core/src/damm-v2-plan.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damm-recovery-'));
process.env.TREBUCHET_CONFIG_DIR = root;
const store = await import('../dammV2Store.js');
const { runLaunch } = await import('../dammV2Launch.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture() {
  const wallet = Keypair.generate();
  const config = normalizeDammV2Config({ token: { name: 'Recovery', symbol: 'REC', supply: '1000000000' } });
  const record = store.create({ config, walletPublicKey: wallet.publicKey.toBase58() });
  const minted = new Set();
  const deps = { solUsd: 118, connection: { getAccountInfo: async (key) => minted.has(key.toBase58()) ? {} : null },
    poolService: { findExistingPool: async () => { throw new Error('pool pause'); } } };
  return { wallet, record, minted, deps, run: () => runLaunch({ id: record.id, walletSecretKey: wallet.secretKey, deps }) };
}

test('a landed mint and supply resume the same token after a final read fails', async () => {
  const f = fixture();
  let creates = 0, finishes = 0;
  f.deps.createToken = async ({ vanityCAKeypair, onProgress }) => {
    creates += 1;
    const mint = Keypair.fromSecretKey(Uint8Array.from(vanityCAKeypair)).publicKey.toBase58();
    assert.equal(store.get(f.record.id).steps.token.mint, mint);
    onProgress({ stage: 'token_prepared', tokenMint: mint, metadataUri: 'https://example.test/token', metadataHash: 'a'.repeat(64) });
    f.minted.add(mint);
    onProgress({ stage: 'mint_created', tokenMint: mint });
    onProgress({ stage: 'supply_minted', tokenMint: mint });
    throw new Error('final read interrupted');
  };
  f.deps.finishToken = async (input) => {
    finishes += 1;
    assert.ok(f.minted.has(input.tokenMint));
    assert.equal(input.metadataUri, 'https://example.test/token');
    assert.equal(input.metadataHash, 'a'.repeat(64));
    return { isSafe: true, mintAuthorityRenounced: true, freezeAuthorityDisabled: true, updateAuthorityRevoked: true };
  };
  await assert.rejects(f.run, /final read interrupted/);
  const mint = store.get(f.record.id).steps.token.mint;
  await assert.rejects(f.run, /pool pause/);
  assert.equal(creates, 1); assert.equal(finishes, 1);
  assert.equal(store.get(f.record.id).steps.token.mint, mint);
  assert.equal(store.get(f.record.id).steps.token.complete, true);
  assert.equal(store.get(f.record.id).tokenMintKey, null);
});

test('a failure before the mint lands reuses the saved key', async () => {
  const f = fixture();
  const keys = [];
  f.deps.createToken = async ({ vanityCAKeypair }) => { keys.push(vanityCAKeypair); throw new Error('send interrupted'); };
  await assert.rejects(f.run, /send interrupted/);
  await assert.rejects(f.run, /send interrupted/);
  assert.deepEqual(keys[0], keys[1]);
  const view = store.publicView(store.get(f.record.id));
  assert.equal('tokenMintKey' in view, false);
  assert.equal(JSON.stringify(view).includes(JSON.stringify(keys[0])), false);
});

test('legacy mint events restore the original identity before retry', async () => {
  const f = fixture();
  const mint = Keypair.generate().publicKey.toBase58();
  f.minted.add(mint);
  store.appendEvent(f.record.id, { stage: 'mint_created', tokenMint: mint });
  f.deps.createToken = async () => { assert.fail('finish the existing token'); };
  f.deps.finishToken = async ({ tokenMint }) => { assert.equal(tokenMint, mint); return { isSafe: true, updateAuthorityRevoked: true }; };
  await assert.rejects(f.run, /pool pause/);
  assert.equal(store.get(f.record.id).steps.token.mint, mint);
});

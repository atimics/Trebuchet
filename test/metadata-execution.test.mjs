import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireProfileOwner } from '../packages/runtime/src/owner.js';
import { createWalletExecutionRuntime } from '../walletExecution.js';
import { metadataChain, metadataMint, sweepWallet } from '../packages/runtime/test/fixtures/metadata-chain.mjs';

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-metadata-service-'));
const priorConfig = process.env.TREBUCHET_CONFIG_DIR;
process.env.TREBUCHET_CONFIG_DIR = configDir;
const tokenService = await import('../tokenService.js');
const { metadataDocumentHash } = await import('../brandShieldService.js');
const { sealedCommitmentDocument } = await import('../metadataUploadService.js');
test.after(() => {
  if (priorConfig === undefined) delete process.env.TREBUCHET_CONFIG_DIR; else process.env.TREBUCHET_CONFIG_DIR = priorConfig;
  fs.rmSync(configDir, { recursive: true, force: true });
});

function fixture(t, inline) {
  const profile = fs.mkdtempSync(path.join(configDir, 'profile-'));
  const owner = acquireProfileOwner(profile), ledger = metadataChain({ inline });
  ledger.connection.getAccountInfo = async (key) => ledger.accountInfo(key);
  const runtime = createWalletExecutionRuntime({ owner, getScopeId: () => 'journal-a', networkForRequest: () => 'devnet', createConnection: () => ledger.connection, timeoutMs: 0 });
  tokenService.setConnectionFactoryForTests(() => ledger.connection);
  tokenService.setUmiFactoryForTests(() => ({}));
  t.after(() => { tokenService.resetConnectionFactoryForTests(); tokenService.resetMetadataFactoriesForTests(); owner.release(); });
  const finalDocument = { name: 'Final Token', symbol: 'FINAL', mint: metadataMint.toBase58(), image: 'https://example.invalid/image.png', description: 'Verified identity' };
  const imageSha256 = 'c'.repeat(64);
  const metadataHash = metadataDocumentHash(sealedCommitmentDocument(finalDocument, imageSha256));
  ledger.state.additionalMetadata = [['trebuchet:sha256', metadataHash]];
  const metadataUri = 'https://example.invalid/final-metadata-with-image.json';
  const placeholderUri = ledger.state.uri;
  const events = [];
  const input = { tempWalletSecretKey: Array.from(sweepWallet.secretKey), tokenMint: metadataMint.toBase58(), name: finalDocument.name, symbol: finalDocument.symbol,
    metadataUri, metadataHash, imageSha256, metadataExecution: { update: runtime.updateMetadata, recover: runtime.recoverMetadataReveal },
    fetchDocument: async (uri) => {
      if (uri === metadataUri) return finalDocument;
      assert.equal(uri, placeholderUri);
      return { description: `Sealed identity sha256:${metadataHash}` };
    }, onProgress: (event) => events.push(event) };
  return { ...ledger, runtime, input, events, finalDocument };
}

for (const inline of [false, true]) {
  test(`the ${inline ? 'inline' : 'Metaplex'} sealed reveal verifies its document before durable execution`, async (t) => {
    const f = fixture(t, inline);
    const result = await tokenService.revealSealedTokenMetadata(f.input);
    assert.equal(result.sealedMetadataPending, false);
    assert.equal(result.metadataImmutable, true);
    assert.equal(result.txId, f.state.sends[0].signature);
    assert.ok(result.operationId);
    assert.equal(f.state.sends.length, 1);
    assert.equal(f.state.uri, f.input.metadataUri);
    assert.equal(f.state.name, f.input.name);
    assert.equal(result.finalMetadataHash, metadataDocumentHash(f.finalDocument));
    if (inline) assert.equal(f.state.additionalMetadata[0][1], result.finalMetadataHash);
    assert.equal(f.events.at(-1).operationId, result.operationId);
    assert.equal((await tokenService.revealSealedTokenMetadata(f.input)).skipped, true);
    assert.equal(f.state.sends.length, 1);
  });
}

test('sealed reveal recovery finishes its saved operation before taking the completed-state path', async (t) => {
  const f = fixture(t, true);
  f.state.afterSend = () => { throw new Error('Reply lost'); };
  await assert.rejects(tokenService.revealSealedTokenMetadata(f.input), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  const pending = f.runtime.active(sweepWallet.publicKey.toBase58());
  f.state.afterSend = null;
  const result = await tokenService.revealSealedTokenMetadata(f.input);
  assert.equal(result.skipped, true);
  assert.equal(result.operationId, pending.id);
  assert.equal(f.runtime.active(sweepWallet.publicKey.toBase58()), null);
  assert.equal(f.state.sends.length, 1);
});

test('a changed sealed document stops before preparing or signing an update', async (t) => {
  const f = fixture(t, true);
  f.finalDocument.description = 'Changed after commitment';
  await assert.rejects(tokenService.revealSealedTokenMetadata(f.input), /does not match the sealed identity commitment/);
  assert.equal(f.runtime.active(sweepWallet.publicKey.toBase58()), null);
  assert.equal(f.state.sends.length, 0);
});

test('a failed reveal-start checkpoint preserves the authority and stops execution', async (t) => {
  const f = fixture(t, false);
  f.input.onProgress = () => { throw Object.assign(new Error('Journal write failed'), { code: 'RECOVERY_STORAGE_UNAVAILABLE' }); };
  await assert.rejects(tokenService.revealSealedTokenMetadata(f.input), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(f.state.authority, sweepWallet.publicKey.toBase58());
  assert.equal(f.state.sends.length, 0);
});


test('a completed reveal receipt survives failure of the following journal checkpoint', async (t) => {
  const f = fixture(t, true);
  f.input.onProgress = (event) => {
    f.events.push(event);
    if (event.stage === 'metadata_revealed') throw Object.assign(new Error('Final checkpoint failed'), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  };
  await assert.rejects(tokenService.revealSealedTokenMetadata(f.input), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(f.runtime.active(sweepWallet.publicKey.toBase58()), null);
  const saved = f.events.at(-1);
  f.input.onProgress = () => {};
  const result = await tokenService.revealSealedTokenMetadata(f.input);
  assert.equal(result.operationId, saved.operationId);
  assert.equal(result.txId, saved.txId);
  assert.equal(result.skipped, true);
  assert.equal(f.state.sends.length, 1);
});

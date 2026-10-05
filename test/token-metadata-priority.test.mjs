import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { pack } from '@solana/spl-token-metadata';
import { packedTokenMetadataLength } from '../tokenService.js';

test('the metadata size matches the library packer byte for byte', () => {
  const updateAuthority = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  for (const metadata of [
    { name: 'METEORA TREBUCHET', symbol: 'MTREBU', uri: 'https://gateway.irys.xyz/cC-BlZLOWXOHHGVg36h5JtiEGyBowOyyVUfeZwJMXEQ', additionalMetadata: [] },
    { name: 'Ünïcode ✓', symbol: '🚀', uri: '', additionalMetadata: [['trebuchet:sha256', 'a'.repeat(64)]] },
    { name: '', symbol: '', uri: '', additionalMetadata: [['k1', 'v1'], ['k2', '']] },
  ]) {
    assert.equal(packedTokenMetadataLength(metadata), pack({ updateAuthority, mint, ...metadata }).length, JSON.stringify(metadata));
  }
});

test('every metadata write is sent with a priority fee, never the fee-less library helpers', () => {
  const source = fs.readFileSync(new URL('../tokenService.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /tokenMetadataInitializeWithRentTransfer|tokenMetadataUpdateFieldWithRentTransfer/);
  assert.match(source, /async function initializeTokenMetadataWithPriority[\s\S]*?sendIxsWithPriority\(/);
  assert.match(source, /async function updateTokenMetadataFieldWithPriority[\s\S]*?sendIxsWithPriority\(/);
  assert.match(source, /const commitmentTx = await updateTokenMetadataFieldWithPriority\(/);
});

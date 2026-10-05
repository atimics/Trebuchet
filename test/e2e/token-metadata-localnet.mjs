#!/usr/bin/env node
// The launch's token creation on a local validator, upload stubbed: a Token-2022 mint whose
// name, symbol, URI and Trebuchet commitment field land with priority-fee transactions.
//
//   npm run test:e2e:token-metadata:localnet   (needs solana-test-validator on PATH)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { getTokenMetadata, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

const freePort = (avoid = []) => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(avoid.some((p) => Math.abs(p - port) < 3) ? freePort(avoid) : port));
  });
});
const rpcPort = await freePort();
const faucetPort = await freePort([rpcPort]);
const ledger = mkdtempSync(path.join(tmpdir(), 'trebuchet-token-meta-'));
const validator = spawn('solana-test-validator', ['--ledger', ledger, '--rpc-port', String(rpcPort), '--faucet-port', String(faucetPort), '--quiet', '--reset'], { stdio: 'ignore' });
process.on('exit', () => validator.kill('SIGTERM'));
const rpc = `http://127.0.0.1:${rpcPort}`;
const connection = new Connection(rpc, 'confirmed');
for (let i = 0; ; i += 1) {
  try { await connection.getSlot(); break; } catch { /* starting */ }
  if (i > 120) throw new Error('validator did not start');
  await new Promise((resolve) => setTimeout(resolve, 500));
}

process.env.SOLANA_RPC_URL = rpc;
const tokenService = await import('../../tokenService.js');
tokenService.setConnectionFactoryForTests(() => new Connection(rpc, 'confirmed'));
const metadataHash = 'ab'.repeat(32);
tokenService.setUploaderForTests(async () => ({ metadataUri: 'https://example.invalid/meta.json', imageUri: 'https://example.invalid/logo.png', metadataHash }));
tokenService.setUmiFactoryForTests(() => ({}));

const wallet = Keypair.generate();
const sig = await connection.requestAirdrop(wallet.publicKey, 5 * LAMPORTS_PER_SOL);
// The token code sends with finalized commitment, so its preflight sees only finalized balances.
const latest = await connection.getLatestBlockhash('finalized');
await connection.confirmTransaction({ signature: sig, ...latest }, 'finalized');

const result = await tokenService.createTokenWithMetaplex({
  tempWalletSecretKey: Array.from(wallet.secretKey),
  name: 'METEORA TREBUCHET',
  symbol: 'MTREBU',
  description: 'localnet',
  totalSupply: '1000000',
  logoBase64: null,
  mintFormat: 'token-2022',
  sealedLaunch: false,
});
const mint = new PublicKey(result.tokenMint);
const metadata = await getTokenMetadata(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
assert.equal(metadata.name, 'METEORA TREBUCHET');
assert.equal(metadata.symbol, 'MTREBU');
assert.equal(metadata.uri, 'https://example.invalid/meta.json');
assert.deepEqual(metadata.additionalMetadata, [['trebuchet:sha256', metadataHash]], 'the commitment field landed');
console.log(`token metadata localnet: ok (${mint.toBase58()})`);
validator.kill('SIGTERM');
process.exit(0);

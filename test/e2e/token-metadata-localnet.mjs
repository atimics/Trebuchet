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
import { getMint, getTokenMetadata, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

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
process.env.TREBUCHET_CONFIG_DIR = ledger;
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
let uploads = 0;
tokenService.setUploaderForTests(async () => { uploads++; return { metadataUri: 'https://example.invalid/meta.json', imageUri: 'https://example.invalid/logo.png', metadataHash }; });
tokenService.setUmiFactoryForTests(() => ({}));

const wallet = Keypair.generate();
const sig = await connection.requestAirdrop(wallet.publicKey, 5 * LAMPORTS_PER_SOL);
// The token code sends with finalized commitment, so its preflight sees only finalized balances.
const latest = await connection.getLatestBlockhash('finalized');
await connection.confirmTransaction({ signature: sig, ...latest }, 'finalized');

const mintKeypair = Keypair.generate();
const events = [];
const input = {
  tempWalletSecretKey: Array.from(wallet.secretKey),
  name: 'METEORA TREBUCHET',
  symbol: 'MTREBU',
  description: 'localnet',
  totalSupply: '1000000',
  logoBase64: null,
  mintFormat: 'token-2022',
  sealedLaunch: false,
  vanityCAKeypair: Array.from(mintKeypair.secretKey),
};
await assert.rejects(tokenService.createTokenWithMetaplex({ ...input, onProgress(event) {
  events.push(event);
  if (event.stage === 'token_transaction_signed' && event.label === 'mint supply') throw new Error('Injected interruption before supply broadcast');
} }), /Injected interruption/);
const interrupted = await getMint(connection, mintKeypair.publicKey, 'finalized', TOKEN_2022_PROGRAM_ID);
assert.equal(interrupted.supply, 0n);
assert.ok(interrupted.mintAuthority.equals(wallet.publicKey));
const recoveredEvents = JSON.parse(JSON.stringify(events));
const result = await tokenService.createTokenWithMetaplex({ ...input, journalEvents: recoveredEvents, onProgress: (event) => events.push(event) });
let replaySends = 0;
const replay = await tokenService.createTokenWithMetaplex({ ...input, journalEvents: JSON.parse(JSON.stringify(events)), onProgress(event) {
  if (event.stage === 'token_transaction_signed') replaySends++;
} });
assert.equal(replay.tokenMint, result.tokenMint);
assert.equal(replaySends, 0, 'a completed Token-2022 launch replays with zero new signed transactions');
assert.equal(uploads, 1, 'resume and replay reuse the saved metadata upload');
const signedSupply = events.filter((event) => event.stage === 'token_transaction_signed' && event.label === 'mint supply');
assert.equal(signedSupply.length, 1, 'the supply transaction keeps its signature through recovery');
const recoveredStatus = (await connection.getSignatureStatuses([signedSupply[0].transaction.signature], { searchTransactionHistory: true })).value[0];
assert.equal(recoveredStatus.confirmationStatus, 'finalized');
assert.equal(recoveredStatus.err, null);
const mint = new PublicKey(result.tokenMint);
const metadata = await getTokenMetadata(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
assert.equal(metadata.name, 'METEORA TREBUCHET');
assert.equal(metadata.symbol, 'MTREBU');
assert.equal(metadata.uri, 'https://example.invalid/meta.json');
assert.deepEqual(metadata.additionalMetadata, [['trebuchet:sha256', metadataHash]], 'the commitment field landed');
console.log(`token metadata localnet: ok (${mint.toBase58()}); resumed supply from zero; completed replay signed zero transactions`);
validator.kill('SIGTERM');
process.exit(0);

#!/usr/bin/env node
// scripts/devnet-launch.mjs — end-to-end devnet launch exercise.
//
// Generates a wallet, airdrops devnet SOL, creates an SPL token with
// Metaplex metadata, creates a Raydium CLMM pool, opens a position,
// and sweeps funds back.  Every step touches the real devnet chain.
//
// Usage:
//   node scripts/devnet-launch.mjs
//   DEVNET_RPC=https://devnet.helius-rpc.com/?api-key=YOUR_KEY \
//     node scripts/devnet-launch.mjs
//
// Requirements:
//   - Devnet RPC endpoint (default: https://api.devnet.solana.com)

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { Raydium, TxVersion, DEVNET_PROGRAM_ID } from '@raydium-io/raydium-sdk-v2';
import { createTokenWithMetaplex } from '../tokenService.js';
import { createPoolsAndPositions } from '../lpService.js';
import { sweepAllTokensToDestination, sweepSolToDestination, setConnectionFactoryForTests } from '../walletHelpers.js';
import { setConnectionFactoryForTests as setLpConnection } from '../lpService.js';
import { setConnectionFactoryForTests as setTokenConnection, setUmiFactoryForTests, setUploaderForTests, refreshConnection } from '../tokenService.js';
import fs from 'node:fs';

// ── Config ──────────────────────────────────────────────────────────

const DEVNET_RPC = process.env.DEVNET_RPC || clusterApiUrl('devnet');
const TOKEN_NAME = process.env.TOKEN_NAME || 'Devnet Test';
const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL || 'DTEST';
const TOKEN_SUPPLY = process.env.TOKEN_SUPPLY || '1000000000';
const AIRDROP_SOL = 2;

// ── Helpers ─────────────────────────────────────────────────────────

function log(label, detail = '') {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${label}${detail ? ': ' + detail : ''}`);
}

async function waitForConfirm(connection, sig, label) {
  log(label, `confirming ${sig.slice(0, 16)}…`);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  log(label, 'confirmed');
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  log('Devnet', 'connecting to ' + DEVNET_RPC);
  const connection = new Connection(DEVNET_RPC, 'confirmed');

  // Override connection factories so services use devnet.
  setConnectionFactoryForTests(() => connection);
  setLpConnection(() => connection);
  setTokenConnection(() => connection);
  refreshConnection();

  // ── 1. Generate wallet ────────────────────────────────────────────
  const wallet = Keypair.generate();
  const pubkey = wallet.publicKey;
  log('Wallet', pubkey.toBase58());

  // ── 2. Fund with devnet SOL ───────────────────────────────────────
  log('Airdrop', `requesting ${AIRDROP_SOL} SOL…`);
  const airdropSig = await connection.requestAirdrop(pubkey, AIRDROP_SOL * LAMPORTS_PER_SOL);
  await waitForConfirm(connection, airdropSig, 'Airdrop');
  const solBalance = await connection.getBalance(pubkey);
  log('Balance', `${solBalance / LAMPORTS_PER_SOL} SOL`);

  // ── 3. Create token with Metaplex ─────────────────────────────────
  log('Token', `creating "${TOKEN_NAME}" (${TOKEN_SYMBOL})…`);
  const tokenResult = await createTokenWithMetaplex({
    tempWalletSecretKey: Array.from(wallet.secretKey),
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    description: 'Devnet test token — Trebuchet E2E exercise',
    totalSupply: TOKEN_SUPPLY,
    logoBase64: null,
    onProgress: (event) => log('Token progress', event),
  });

  if (!tokenResult.success) {
    throw new Error('Token creation failed: ' + tokenResult.error);
  }
  const mint = tokenResult.tokenMint;
  const metadataUri = tokenResult.metadataUri;
  log('Token', `mint: ${mint}`);
  log('Metadata', metadataUri);

  const tokenBalance = tokenResult.totalSupply;
  log('Token balance', `${tokenBalance} raw`);

  // ── 4. Create Raydium CLMM pool ───────────────────────────────────
  log('SDK', 'initializing Raydium (devnet)…');
  const raydium = await Raydium.load({
    owner: wallet,
    connection,
    cluster: 'devnet',
    disableFeatureCheck: true,
    disableLoadToken: true,
  });

  let feeConfigs;
  try {
    feeConfigs = await raydium.api.getClmmConfigs();
    log('Fee tiers', `fetched ${feeConfigs.length} configs via API`);
  } catch {
    feeConfigs = [
      { id: '100',  index: 0, tickSpacing: 1,   tradeFeeRate: 100,   protocolFeeRate: 120000, fundFeeRate: 40000, description: '0.01%' },
      { id: '500',  index: 1, tickSpacing: 10,  tradeFeeRate: 500,   protocolFeeRate: 120000, fundFeeRate: 40000, description: '0.05%' },
      { id: '2500', index: 2, tickSpacing: 60,  tradeFeeRate: 2500,  protocolFeeRate: 120000, fundFeeRate: 40000, description: '0.25%' },
      { id: '10000',index: 3, tickSpacing: 200, tradeFeeRate: 10000, protocolFeeRate: 120000, fundFeeRate: 40000, description: '1%' },
    ];
    log('Fee tiers', `using hardcoded fallback (${feeConfigs.length} tiers)`);
  }

  const config = feeConfigs.find(c => c.tickSpacing === 60) || feeConfigs[2];
  log('Fee tier', `tickSpacing=${config.tickSpacing}, rate=${config.tradeFeeRate / 100}%`);

  log('Pool', 'creating CLMM pool…');
  const { execute, extInfo } = await raydium.clmm.createPool({
    programId: DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID,
    mint1: mint,
    mint2: 'So11111111111111111111111111111111111111112',
    ammConfig: { id: config.id, index: config.index, tickSpacing: config.tickSpacing, tradeFeeRate: config.tradeFeeRate, protocolFeeRate: config.protocolFeeRate, fundFeeRate: config.fundFeeRate },
    initialPrice: 1,
    startTime: 0,
    txVersion: TxVersion.V0,
  });
  const { txId } = await execute();
  log('Pool', `created, tx: ${txId}`);
  log('Pool address', extInfo.address.id);

  // ── 5. Open a position ────────────────────────────────────────────
  log('Position', 'opening…');
  const poolInfo = await raydium.clmm.getPoolInfoFromRpc(extInfo.address.id);
  const pos = await raydium.clmm.openPositionFromBase({
    poolInfo,
    poolKeys: poolInfo.poolKeys,
    tickLower: poolInfo.state.tickCurrent - 120,
    tickUpper: poolInfo.state.tickCurrent + 120,
    base: 'MintA',
    baseAmount: tokenBalance / 10,
    otherAmountMax: 0.01 * LAMPORTS_PER_SOL,
    txVersion: TxVersion.V0,
  });
  const { txId: posTxId } = await pos.execute();
  log('Position', `opened, tx: ${posTxId}`);

  // ── 6. Sweep remaining funds ──────────────────────────────────────
  const sweepResult = await sweepAllTokensToDestination({
    connection,
    walletKeypair: wallet,
    destinationPubkey: pubkey,
    solAmount: null,
    tokens: [{ mint, amount: 'all' }],
  });
  log('Sweep', `${sweepResult.sweptTokens.length} tokens swept, ${sweepResult.errors.length} errors`);

  // ── Summary ───────────────────────────────────────────────────────
  const finalSol = await connection.getBalance(pubkey);
  console.log('\n══════════════════════════════════════════');
  console.log('  Devnet launch complete!');
  console.log(`  Wallet:  ${pubkey.toBase58()}`);
  console.log(`  Token:   ${mint}`);
  console.log(`  Pool:    ${extInfo.address.id}`);
  console.log(`  SOL:     ${(finalSol / LAMPORTS_PER_SOL).toFixed(6)}`);
  console.log(`  Metadata: ${metadataUri}`);
  console.log('══════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('Devnet launch failed:', err.message);
  process.exit(1);
});

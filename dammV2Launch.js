// dammV2Launch.js
//
// Runs a lean Meteora launch: create the token (the app's own Token-2022 path),
// create the single-sided locked pool, verify it, and optionally send the Fee Key
// to another wallet. Every step is saved to the record as it finishes, so a run
// that stops can be run again and picks up where it left off:
//
//   token        skipped once the record holds the verified mint
//   pool         if the pool already exists on chain (the position NFT key was
//                saved before sending) the run adopts it instead of creating another
//   fee key      skipped once sent
//
// Chain and token work come in through `deps`, so tests can run the whole flow
// without a network and the localnet test can run it against a real validator.

import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  DAMM_V2_VENUE,
  TOKEN_DECIMALS,
  LAMPORTS_PER_SOL,
  dammV2Pricing,
} from '@trebuchet/core/damm-v2-plan';
import * as store from './dammV2Store.js';
import * as damm from './dammV2Service.js';

const jobs = new Map(); // id -> { startedAt, stage, finishedAt?, error? }

export function isBusy(id) {
  const job = jobs.get(id);
  return Boolean(job && !job.finishedAt);
}

export function jobStatus(id) {
  const job = jobs.get(id);
  return job ? { ...job, running: !job.finishedAt } : { running: false };
}

function httpError(status, message, code) {
  return Object.assign(new Error(message), { statusCode: status, ...(code ? { code } : {}) });
}

// The events worth keeping in the record, without anything bulky or sensitive.
function compactEvent(event) {
  const keep = ['stage', 'tokenMint', 'mint', 'txId', 'pool', 'position', 'positionNft', 'unitsConsumed', 'passed', 'permanentlyLocked'];
  const out = {};
  for (const key of keep) if (event?.[key] !== undefined) out[key] = event[key];
  return out;
}

/** The numbers the chain stage uses, from the saved config and the frozen SOL price. */
export function chainParams(record) {
  const { token, pool } = record.config;
  const supplyRaw = BigInt(token.supply) * 10n ** BigInt(TOKEN_DECIMALS);
  const startingMarketCapLamports = BigInt(Math.round((pool.startingMarketCapUsd / record.solUsd) * LAMPORTS_PER_SOL));
  return { supplyRaw, startingMarketCapLamports, rangeMultiple: pool.rangeMultiple, feeBps: pool.feeBps };
}

/**
 * Run (or resume) a launch. Resolves with the record's public summary; throws on
 * failure after recording the error, leaving finished steps in place.
 *
 * deps:
 *   connection           web3.js Connection
 *   createToken          tokenService.createTokenWithMetaplex
 *   getVanityCandidate   (publicKey) => { keyType, scalar | secretKey } | null
 *   removeVanityCandidate (publicKey) => void
 *   addCoin              ({ mint, name, symbol, image }) => void, puts the coin on the Coins list
 *   solUsd               the price the operator approved (frozen into the record)
 *   priorityMicroLamports
 */
export async function runLaunch({ id, walletSecretKey, deps }) {
  if (isBusy(id)) throw httpError(409, 'This launch is already running.', 'DAMM_JOB_RUNNING');
  let record = store.get(id);
  if (record.status === 'completed') throw httpError(409, 'This launch is already complete.', 'DAMM_ALREADY_COMPLETE');
  const wallet = Keypair.fromSecretKey(Uint8Array.from(walletSecretKey));
  if (record.walletPublicKey && record.walletPublicKey !== wallet.publicKey.toBase58()) {
    throw httpError(409, 'This launch belongs to a different wallet.');
  }
  const job = { startedAt: new Date().toISOString(), stage: 'starting' };
  jobs.set(id, job);
  const note = (event) => {
    job.stage = event.stage || job.stage;
    try { store.appendEvent(id, compactEvent(event)); } catch { /* the journal is best-effort */ }
  };

  try {
    if (!record.solUsd) record = store.update(id, { solUsd: deps.solUsd });
    record = store.update(id, { status: 'running', error: null, walletPublicKey: wallet.publicKey.toBase58() });
    const { connection } = deps;

    // ---- token -----------------------------------------------------------------------------
    if (!record.steps.token?.complete) {
      note({ stage: 'token_starting' });
      const vanityKey = record.config.vanity?.selectedPublicKey || null;
      const candidate = vanityKey ? deps.getVanityCandidate(vanityKey) : null;
      if (vanityKey && !candidate) throw httpError(404, 'The selected contract address is not in the saved list.');
      const created = await deps.createToken({
        tempWalletSecretKey: Array.from(wallet.secretKey),
        name: record.config.token.name,
        symbol: record.config.token.symbol,
        description: record.config.token.description,
        totalSupply: record.config.token.supply,
        logoBase64: record.logoDataUrl,
        vanityCAScalar: candidate?.keyType === 'scalar' ? candidate.scalar : null,
        vanityCAKeypair: candidate && candidate.keyType !== 'scalar' ? candidate.secretKey : null,
        sealedLaunch: false,
        mintFormat: 'token-2022',
        onProgress: note,
      });
      if (!created?.tokenMint || created.isSafe !== true) throw new Error('The token was not verified as safe, so no pool was created.');
      if (vanityKey) deps.removeVanityCandidate(vanityKey);
      record = store.update(id, {
        steps: { token: {
          complete: true,
          mint: created.tokenMint,
          metadataUri: created.metadataUri || null,
          imageUri: created.imageUri || null,
          mintAuthorityRenounced: created.mintAuthorityRenounced === true,
          freezeAuthorityDisabled: created.freezeAuthorityDisabled === true,
          metadataImmutable: created.metadataImmutable === true,
        } },
      });
    }
    const mint = new PublicKey(record.steps.token.mint);

    // ---- pool ------------------------------------------------------------------------------
    if (!record.steps.pool?.complete) {
      const params = chainParams(record);
      // The position NFT's key exists before anything is sent. A resume reuses it.
      let secret = store.loadPositionNft(id);
      if (!secret) {
        const fresh = Keypair.generate();
        store.savePositionNft(id, fresh.secretKey);
        secret = fresh.secretKey;
      }
      const positionNft = Keypair.fromSecretKey(secret);
      const existing = await damm.findExistingPool({ connection, mint, positionNft: positionNft.publicKey });
      let pool;
      if (existing.poolExists && existing.positionExists) {
        note({ stage: 'damm_pool_adopted', pool: existing.pool.toBase58(), position: existing.position.toBase58() });
        const verification = await damm.verifyLockedPool({ connection, pool: existing.pool, position: existing.position, mint, supplyRaw: params.supplyRaw });
        if (!verification.passed) throw new Error('A pool for this token already exists but is not the locked single-sided pool this launch makes.');
        pool = { pool: existing.pool.toBase58(), position: existing.position.toBase58(), positionNft: positionNft.publicKey.toBase58(), verification, adopted: true };
      } else if (existing.poolExists) {
        throw new Error('A pool for this token already exists, and it is not this launch\'s position. Nothing was created.');
      } else {
        const created = await damm.createLockedPool({
          connection, payer: wallet, mint, positionNft, ...params,
          priorityMicroLamports: deps.priorityMicroLamports || 0, onProgress: note,
        });
        pool = { ...created, adopted: false };
      }
      const pricing = dammV2Pricing({ supply: record.config.token.supply, startingMarketCapUsd: record.config.pool.startingMarketCapUsd, solUsd: record.solUsd, rangeMultiple: record.config.pool.rangeMultiple, feeBps: record.config.pool.feeBps });
      record = store.update(id, {
        steps: { pool: {
          complete: true,
          pool: pool.pool,
          position: pool.position,
          positionNft: pool.positionNft,
          signature: pool.signature || null,
          adopted: pool.adopted,
          verification: pool.verification,
          startMarketCapSol: pricing.startMarketCapSol,
          startPriceSol: pricing.startPriceSol,
          solUsd: record.solUsd,
        } },
      });
    }

    // ---- Fee Key ---------------------------------------------------------------------------
    const destination = record.config.destination;
    if (destination && destination !== wallet.publicKey.toBase58() && !record.steps.keyTransfer?.complete) {
      note({ stage: 'fee_key_sending' });
      const sent = await damm.transferPositionNft({ connection, owner: wallet, positionNft: record.steps.pool.positionNft, to: destination });
      record = store.update(id, { steps: { keyTransfer: { complete: true, to: sent.to, signature: sent.signature } } });
      note({ stage: 'fee_key_sent', txId: sent.signature });
    }

    // Put the coin on the Coins list. Best effort: the launch is already complete.
    try {
      deps.addCoin?.({
        mint: record.steps.token.mint,
        name: record.config.token.name,
        symbol: record.config.token.symbol,
        image: record.steps.token.imageUri || null,
      });
      note({ stage: 'coin_added' });
    } catch { /* the coin can be added from the Coins page */ }

    record = store.update(id, { status: 'completed', error: null });
    note({ stage: 'launch_complete' });
    job.finishedAt = new Date().toISOString();
    return store.publicView(record);
  } catch (error) {
    const message = error?.message || String(error);
    try { store.update(id, { status: 'failed', error: message }); } catch { /* record gone */ }
    job.error = message;
    job.finishedAt = new Date().toISOString();
    throw error;
  }
}

/** How much SOL and token the launch wallet holds, for the pre-run check. */
export async function walletHoldings({ connection, publicKey, mint = null }) {
  const owner = new PublicKey(publicKey);
  const lamports = await connection.getBalance(owner, 'confirmed');
  let tokenRaw = 0n;
  if (mint) {
    try {
      tokenRaw = (await getAccount(connection, getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, TOKEN_2022_PROGRAM_ID), 'confirmed', TOKEN_2022_PROGRAM_ID)).amount;
    } catch { /* no token account yet */ }
  }
  return { lamports, tokenRaw };
}

export { DAMM_V2_VENUE };

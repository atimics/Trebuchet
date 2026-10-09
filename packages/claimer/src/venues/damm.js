// Venue adapter: Meteora DAMM v2 fee claiming.
//
// These functions were originally defined in dammV2Service.js; the claimer
// owns them now so the desktop and the sealed runner share one implementation.
// dammV2Service re-exports them, so existing callers are unchanged.

import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import { CpAmm, derivePositionNftAccount, getUnClaimLpFee } from '@meteora-ag/cp-amm-sdk';

async function mintOwnerProgram(connection, mint) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error('Mint not found');
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

export async function simulateOrThrow(connection, transaction, signers) {
  const simulation = await connection.simulateTransaction(transaction, signers, { replaceRecentBlockhash: true });
  if (simulation.value.err) {
    const logs = (simulation.value.logs || []).join('\n');
    throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}\n${logs}`);
  }
  return { unitsConsumed: simulation.value.unitsConsumed || null };
}

async function sendAndConfirm(connection, transaction, signers, commitment) {
  await simulateOrThrow(connection, transaction, signers);
  const latest = await connection.getLatestBlockhash(commitment);
  transaction.recentBlockhash = latest.blockhash;
  transaction.lastValidBlockHeight = latest.lastValidBlockHeight;
  transaction.sign(...signers);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: commitment });
  const outcome = await connection.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, commitment);
  if (outcome.value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(outcome.value.err)}`);
  return signature;
}

/** Transfer the position NFT (the Fee Key) to another wallet. */
export async function transferPositionNft({ connection, owner, positionNft, to, commitment = 'confirmed' }) {
  const mint = new PublicKey(positionNft);
  const recipient = new PublicKey(to);
  const from = derivePositionNftAccount(mint);
  const target = getAssociatedTokenAddressSync(mint, recipient, true, TOKEN_2022_PROGRAM_ID);
  const transaction = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, target, recipient, mint, TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(from, mint, target, owner.publicKey, 1n, 0, [], TOKEN_2022_PROGRAM_ID),
  );
  transaction.feePayer = owner.publicKey;
  const signature = await sendAndConfirm(connection, transaction, [owner], commitment);
  return { signature, to: recipient.toBase58() };
}

/** Claim accrued fees from a locked position. Fees are SOL (quote side only). */
export async function claimFees({ connection, owner, position, commitment = 'confirmed', receiver = null }) {
  const cpAmm = new CpAmm(connection);
  const positionKey = new PublicKey(position);
  const positionState = await cpAmm.fetchPositionState(positionKey);
  const pool = positionState.pool;
  const poolState = await cpAmm.fetchPoolState(pool);
  const tokenProgram = await mintOwnerProgram(connection, poolState.tokenAMint);
  const tempWsol = Keypair.generate();
  const held = (await cpAmm.getPositionsByUser(owner.publicKey)).find((entry) => entry.position.equals(positionKey));
  if (!held) throw new Error('This wallet does not hold that position.');
  const before = await connection.getBalance(owner.publicKey, commitment);
  const transaction = await cpAmm.claimPositionFee({
    owner: owner.publicKey,
    position: positionKey,
    pool,
    positionNftAccount: held.positionNftAccount,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: tokenProgram,
    tokenBProgram: TOKEN_PROGRAM_ID,
    receiver: receiver ? new PublicKey(receiver) : owner.publicKey,
    tempWSolAccount: tempWsol.publicKey,
  });
  const signature = await sendAndConfirm(connection, transaction, [owner, tempWsol], commitment);
  const after = await connection.getBalance(owner.publicKey, commitment);
  return { signature, lamportsReceived: after - before };
}

/** Positions owned by a wallet in this program, with unclaimed fees. */
export async function listPositions({ connection, owner }) {
  const cpAmm = new CpAmm(connection);
  const rows = [];
  for (const entry of await cpAmm.getPositionsByUser(new PublicKey(owner))) {
    const state = entry.positionState;
    const poolState = await cpAmm.fetchPoolState(state.pool);
    const quoteIsB = poolState.tokenBMint.equals(NATIVE_MINT);
    const fees = getUnClaimLpFee(poolState, state);
    rows.push({
      venue: 'meteora-damm-v2',
      position: entry.position.toBase58(),
      pool: state.pool.toBase58(),
      positionNft: state.nftMint.toBase58(),
      tokenMint: (quoteIsB ? poolState.tokenAMint : poolState.tokenBMint).toBase58(),
      permanentlyLocked: cpAmm.isPermanentLockedPosition(state),
      unclaimedQuoteLamports: (quoteIsB ? fees.feeTokenB : fees.feeTokenA).toString(),
    });
  }
  return rows;
}
import { createHash, randomBytes } from 'node:crypto';
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddressSync, unpackMint,
} from '@solana/spl-token';
import { CpAmm, CP_AMM_PROGRAM_ID, derivePositionAddress } from '@meteora-ag/cp-amm-sdk';
import {
  ClmmInstrument, LockClPositionLayoutV2, PoolInfoLayout, PositionInfoLayout,
  getPdaLockClPositionIdV2, getPdaProtocolPositionAddress, getPdaTickArrayAddress, TickUtils,
} from '@raydium-io/raydium-sdk-v2';
import { transferV1, fetchAssetV1 } from '@metaplex-foundation/mpl-core';
import { publicKey as umiKey } from '@metaplex-foundation/umi';
import { toWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters';
import bs58 from 'bs58';
import { createNftUmi } from './nftService.js';
import { clmmLockPrograms } from './clmmLockEvidence.js';
import * as collections from './nftCollectionStore.js';
import * as store from './feeNftStore.js';
import { feeNftPlan, recipientList } from './feeNftPlan.js';
import {
  CORE_PROGRAM_ID, FEE_VAULT_HEADER, FEE_VAULT_ENTRY, feeVaultAddress, feeVaultTokenAccounts,
  initializeFeeVault, registerFeeShare, activateFeeVault, harvestFeeVault, claimFeeShare, decodeFeeVault, feeEntitlement,
} from './feeVaultClient.js';

const jobs = new Map();
const pub = (v) => new PublicKey(v);
const codeError = (message, code = 'FEE_NFT_BLOCKED') => Object.assign(new Error(message), { statusCode: 409, code });
const connectionFor = (url) => new Connection(url, 'confirmed');
export const programId = () => process.env.TREBUCHET_FEE_VAULT_PROGRAM_ID || null;
export function jobStatus(id) { return jobs.get(id) || null; }
export function isBusy(id) { return jobStatus(id)?.status === 'running'; }

async function sourceFor(connection, venue, nativeNftMint, network) {
  const nft = pub(nativeNftMint);
  let source;
  if (venue === 'meteora') {
    const cp = new CpAmm(connection);
    const position = derivePositionAddress(nft);
    const state = await cp.fetchPositionState(position);
    if (!state.nftMint.equals(nft) || !cp.isPermanentLockedPosition(state) || !state.unlockedLiquidity.isZero() || !state.vestedLiquidity.isZero()) throw codeError('Choose a permanently locked Meteora position');
    const pool = await cp.fetchPoolState(state.pool);
    if (pool.rewardInfos?.some((r) => !r.mint.equals(PublicKey.default))) throw codeError('Choose a position with trading fees only');
    source = { venue, pool: state.pool.toBase58(), position: position.toBase58(), nativeNftMint: nft.toBase58(), mints: [pool.tokenAMint.toBase58(), pool.tokenBMint.toBase58()], poolVaults: [pool.tokenAVault.toBase58(), pool.tokenBVault.toBase58()], nativeTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() };
  } else if (venue === 'raydium') {
    const programs = clmmLockPrograms(network);
    const position = getPdaLockClPositionIdV2(programs.programId, nft).publicKey;
    const info = await connection.getAccountInfo(position, 'confirmed');
    if (!info?.owner.equals(programs.programId) || info.data.length !== LockClPositionLayoutV2.span) throw codeError('Choose a Raydium Burn & Earn Fee Key');
    const lock = LockClPositionLayoutV2.decode(info.data);
    if (!lock.lockNftMint.equals(nft)) throw codeError('Fee Key mint differs from its lock');
    const poolInfo = await connection.getAccountInfo(lock.poolId, 'confirmed');
    if (!poolInfo?.owner.equals(programs.poolProgramId)) throw codeError('Pool owner differs from the Raydium program');
    const pool = PoolInfoLayout.decode(poolInfo.data);
    if (pool.rewardInfos?.some((r) => !r.tokenMint.equals(PublicKey.default))) throw codeError('Choose a position with trading fees only');
    source = { venue: network === 'devnet' ? 'raydium-devnet' : 'raydium', pool: lock.poolId.toBase58(), position: position.toBase58(), nativeNftMint: nft.toBase58(), mints: [pool.mintA.toBase58(), pool.mintB.toBase58()], poolVaults: [pool.vaultA.toBase58(), pool.vaultB.toBase58()], nativeTokenProgram: TOKEN_PROGRAM_ID.toBase58() };
  } else { throw codeError('Choose Meteora or Raydium'); }
  source.tokenPrograms = []; source.decimals = [];
  for (const address of source.mints) {
    const info = await connection.getAccountInfo(pub(address), 'confirmed');
    if (!info) throw codeError('Fee mint is missing');
    const mint = unpackMint(pub(address), info, info.owner);
    // The contract permits metadata extensions only.
    if (mint.tlvData.length) {
      let at = 0;
      while (at + 4 <= mint.tlvData.length) {
        const kind = mint.tlvData.readUInt16LE(at); const len = mint.tlvData.readUInt16LE(at + 2);
        if (!kind) break;
        if (![18, 19].includes(kind)) throw codeError('Choose fee tokens with standard transfers');
        at += 4 + len;
      }
    }
    source.tokenPrograms.push(info.owner.toBase58()); source.decimals.push(mint.decimals);
  }
  return source;
}

async function requireProgram(connection, id) {
  if (!id) throw codeError('Deploy the fee vault program, then set TREBUCHET_FEE_VAULT_PROGRAM_ID', 'FEE_PROGRAM_SETUP');
  const info = await connection.getAccountInfo(pub(id), 'confirmed');
  if (!info?.executable) throw codeError('Deploy the fee vault program on the selected network', 'FEE_PROGRAM_SETUP');
}
export async function prepare({ rpcUrl, network, walletPublicKey, collectionId, venue, nativeNftMint, recipients }) {
  const connection = connectionFor(rpcUrl);
  const id = programId(); await requireProgram(connection, id);
  const source = await sourceFor(connection, venue, nativeNftMint, network);
  const collection = collections.get(collectionId);
  const plan = feeNftPlan({ collection, source, recipients: recipientList(recipients), creator: walletPublicKey, seed: [...randomBytes(32)], programId: id, network: await connection.getGenesisHash() });
  const assets = await connection.getMultipleAccountsInfo(plan.shares.map((s) => pub(s.asset)), 'confirmed');
  for (let i = 0; i < assets.length; i++) {
    const info = assets[i];
    if (!info?.owner.equals(CORE_PROGRAM_ID) || info.data[0] !== 1 || info.data[33] !== 2 || !new PublicKey(info.data.subarray(34, 66)).equals(pub(plan.collection)) || !new PublicKey(info.data.subarray(1, 33)).equals(pub(walletPublicKey))) throw codeError(`Keep branded NFT #${i + 1} in the signing wallet until setup`);
  }
  const record = store.create(plan);
  record.vault = feeVaultAddress(id, walletPublicKey, plan.seed).toBase58();
  record.estimate = await estimate(connection, plan);
  return store.save(record);
}
async function estimate(connection, plan) {
  const rent = await connection.getMinimumBalanceForRentExemption(FEE_VAULT_HEADER + plan.count * FEE_VAULT_ENTRY);
  const tokenRent = await connection.getMinimumBalanceForRentExemption(200);
  const transactions = plan.count * 2 + 4;
  // Fixed compute price zero. Each step simulates and checks the exact fee before signing.
  const feeLamports = transactions * 10_000;
  return { vaultRentLamports: rent, accountRentLamports: tokenRent * 3 + plan.count * 100_000, feeLamports, totalLamports: rent + tokenRent * 3 + plan.count * 100_000 + feeLamports, transactions };
}
function assertVault(record, account) {
  const decoded = decodeFeeVault(account.data);
  const p = record.plan;
  if (!account.owner.equals(pub(p.programId)) || decoded.creator !== p.creator || decoded.collection !== p.collection || decoded.totalWeight !== p.totalWeight || decoded.count !== p.count || decoded.source.nativeNftMint !== p.source.nativeNftMint || decoded.source.position !== p.source.position || decoded.source.pool !== p.source.pool || JSON.stringify(decoded.seed) !== JSON.stringify(p.seed) || JSON.stringify(decoded.source.mints) !== JSON.stringify(p.source.mints) || JSON.stringify(decoded.source.tokenPrograms) !== JSON.stringify(p.source.tokenPrograms)) throw codeError('On-chain vault differs from the saved plan');
  return decoded;
}

// Write the signed transaction before sending. An uncertain send keeps its cost
// reservation. Retry reuses those bytes until finality or blockhash expiry is known.
export async function sendStep(record, connection, signer, key, instructions, rentLamports = 0, approval = null) {
  const scope = approval?.scope || 'setup';
  const cap = approval?.cap ?? record.maxSpendLamports;
  let op = record.operations[key];
  if (op?.status === 'confirmed') return;
  if (op && op.status !== 'failed') {
    const result = (await connection.getSignatureStatuses([op.signature], { searchTransactionHistory: true })).value[0];
    if (result && ['confirmed', 'finalized'].includes(result.confirmationStatus)) {
      op.status = result.err ? 'failed' : 'confirmed';
      const tx = await connection.getTransaction(op.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!tx?.meta) throw codeError('Waiting for the transaction receipt', 'FEE_SEND_PENDING');
      op.spentLamports = Math.max(tx.meta.preBalances[0] - tx.meta.postBalances[0], 0);
      store.save(record);
      if (result.err) throw codeError('Transaction failed; review the receipt and resume');
      return;
    }
    if (await connection.getBlockHeight('confirmed') <= op.lastValidBlockHeight) {
      await connection.sendRawTransaction(Buffer.from(op.bytes, 'base64'), { skipPreflight: false });
      throw codeError('Waiting for the saved transaction to confirm', 'FEE_SEND_PENDING');
    }
    // Confirm absence at finalized commitment after expiry before replacing bytes.
    const finalHeight = await connection.getBlockHeight('finalized');
    if (finalHeight <= op.lastValidBlockHeight || result) throw codeError('Waiting for final transaction status', 'FEE_SEND_PENDING');
    op.status = 'failed'; op.spentLamports = 0; store.save(record);
  }
  const block = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: signer.publicKey, ...block }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...instructions);
  const fee = (await connection.getFeeForMessage(tx.compileMessage(), 'confirmed')).value;
  if (fee == null) throw codeError('Refresh the fee estimate');
  const reserved = Object.entries(record.operations).filter(([k, v]) => k !== key && (v.scope || 'setup') === scope).reduce((sum, [, v]) => sum + (v.spentLamports ?? v.reservedLamports ?? 0), 0);
  if (reserved + fee + rentLamports > cap) throw codeError('Increase the approved spend cap to continue', 'FEE_SPEND_CAP');
  tx.sign(signer);
  const simulation = await connection.simulateTransaction(tx);
  if (simulation.value.err) throw codeError(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
  op = { bytes: tx.serialize().toString('base64'), signature: bs58.encode(tx.signature), lastValidBlockHeight: block.lastValidBlockHeight, reservedLamports: fee + rentLamports, scope, signer: signer.publicKey.toBase58(), status: 'prepared' };
  record.operations[key] = op; store.save(record);
  await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const result = await connection.confirmTransaction({ signature: op.signature, ...block }, 'confirmed');
  const receipt = await connection.getTransaction(op.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!receipt?.meta) throw codeError('Waiting for the transaction receipt', 'FEE_SEND_PENDING');
  op.status = result.value.err ? 'failed' : 'confirmed'; op.spentLamports = Math.max(receipt.meta.preBalances[0] - receipt.meta.postBalances[0], 0); store.save(record);
  if (result.value.err) throw codeError('Transaction failed; review the receipt and resume');
}

export function startRun(id, options) {
  if (isBusy(id)) throw codeError('Setup is running');
  if ([...jobs.values()].some((job) => job.status === 'running' && job.walletPublicKey === options.walletPublicKey)) throw codeError('This wallet has a fee setup running');
  const job = { status: 'running', step: 'Checking backing', done: 0, walletPublicKey: options.walletPublicKey };
  jobs.set(id, job);
  run(id, options, job).then(() => { job.status = 'complete'; }).catch((error) => { job.status = 'attention'; job.error = error.message; job.code = error.code; }).finally(() => options.onFinish?.());
  return job;
}
async function run(id, { rpcUrl, walletPublicKey, secretKey, approvedDigest, confirmNativeNftMint, maxSpendLamports }, job) {
  const record = store.get(id); const p = record.plan;
  const { digest: savedDigest, ...planBody } = p;
  if (createHash('sha256').update(JSON.stringify(planBody)).digest('hex') !== savedDigest) throw codeError('Prepare a fresh fee plan');
  if (approvedDigest !== p.digest || confirmNativeNftMint !== p.source.nativeNftMint || walletPublicKey !== p.creator || !Number.isSafeInteger(maxSpendLamports) || maxSpendLamports <= 0) throw codeError('Review the backing NFT and approve the saved plan and spend cap');
  const connection = connectionFor(rpcUrl); const signer = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  if (signer.publicKey.toBase58() !== p.creator || await connection.getGenesisHash() !== p.network || programId() !== p.programId) throw codeError('Use the network, program and wallet saved in this plan');
  await requireProgram(connection, p.programId);
  record.maxSpendLamports = maxSpendLamports; record.status = 'setting-up'; store.save(record);
  const rent = await connection.getMinimumBalanceForRentExemption(FEE_VAULT_HEADER + p.count * FEE_VAULT_ENTRY);
  const tokenRent = await connection.getMinimumBalanceForRentExemption(200);
  const v = pub(record.vault);
  const existing = await connection.getAccountInfo(v, 'confirmed');
  if (existing) assertVault(record, existing);
  await sendStep(record, connection, signer, 'vault', [initializeFeeVault({ programId: p.programId, creator: p.creator, seed: p.seed, collection: p.collection, source: p.source, count: p.count, totalWeight: p.totalWeight })], rent);
  const umi = createNftUmi({ rpcUrl, payerSecretKey: secretKey });
  for (const s of p.shares) {
    job.step = `Registering fee NFT ${s.index + 1} of ${p.count}`;
    await sendStep(record, connection, signer, `share-${s.index}`, [registerFeeShare({ programId: p.programId, creator: p.creator, vault: v, ...s })]);
    job.done = s.index + 1;
  }
  job.step = 'Backing the collection';
  const nftMint = pub(p.source.nativeNftMint); const nftProgram = pub(p.source.nativeTokenProgram);
  const nftTarget = getAssociatedTokenAddressSync(nftMint, v, true, nftProgram);
  const feeAccounts = feeVaultTokenAccounts(v, p.source);
  const tokenAccounts = await connection.getTokenAccountsByOwner(signer.publicKey, { mint: nftMint });
  const from = tokenAccounts.value.find((e) => e.account.data.readBigUInt64LE(64) === 1n)?.pubkey;
  if (!record.operations.backing && !from) throw codeError('The signing wallet must hold the backing NFT');
  const backing = [createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, nftTarget, v, nftMint, nftProgram),
    ...p.source.mints.map((m, i) => createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, feeAccounts[i], v, pub(m), pub(p.source.tokenPrograms[i])))];
  if (from) backing.push(createTransferCheckedInstruction(from, nftMint, nftTarget, signer.publicKey, 1n, 0, [], nftProgram));
  await sendStep(record, connection, signer, 'backing', backing, tokenRent * 3);
  job.step = 'Activating fee rights';
  await sendStep(record, connection, signer, 'activate', [activateFeeVault({ programId: p.programId, creator: p.creator, vault: v, source: p.source, nativeNftAccount: nftTarget })]);
  for (const s of p.shares) {
    job.step = `Sending fee NFT ${s.index + 1} of ${p.count}`;
    if (s.recipient === p.creator) continue;
    const asset = await fetchAssetV1(umi, umiKey(s.asset));
    if (String(asset.owner) === s.recipient) continue;
    if (String(asset.owner) !== p.creator && !record.operations[`send-${s.index}`]) throw codeError(`NFT #${s.index + 1} changed hands during setup`);
    const instructions = transferV1(umi, { asset: umiKey(s.asset), collection: umiKey(p.collection), newOwner: umiKey(s.recipient) }).getInstructions().map(toWeb3JsInstruction);
    await sendStep(record, connection, signer, `send-${s.index}`, instructions, 100_000);
  }
  record.status = 'active'; record.completedAt = new Date().toISOString(); store.save(record); job.step = 'Fee collection is active';
}

async function harvestInstruction(connection, record) {
  const { source: s } = record.plan; const v = pub(record.vault); const outputs = feeVaultTokenAccounts(v, s);
  const nftAccount = getAssociatedTokenAddressSync(pub(s.nativeNftMint), v, true, pub(s.nativeTokenProgram));
  if (s.venue === 'meteora') {
    const cp = new CpAmm(connection);
    const tx = await cp.claimPositionFee({ owner: v, receiver: v, position: pub(s.position), pool: pub(s.pool), positionNftAccount: nftAccount,
      tokenAMint: pub(s.mints[0]), tokenBMint: pub(s.mints[1]), tokenAVault: pub(s.poolVaults[0]), tokenBVault: pub(s.poolVaults[1]), tokenAProgram: pub(s.tokenPrograms[0]), tokenBProgram: pub(s.tokenPrograms[1]) });
    const instruction = tx.instructions.find((ix) => ix.programId.equals(CP_AMM_PROGRAM_ID));
    if (!instruction || !instruction.keys[3].pubkey.equals(outputs[0]) || !instruction.keys[4].pubkey.equals(outputs[1])) throw codeError('Fee claim destinations differ from the vault');
    return instruction;
  }
  const network = s.venue === 'raydium-devnet' ? 'devnet' : 'mainnet'; const programs = clmmLockPrograms(network);
  const lock = LockClPositionLayoutV2.decode((await connection.getAccountInfo(pub(s.position))).data);
  const position = PositionInfoLayout.decode((await connection.getAccountInfo(lock.positionId)).data);
  const pool = PoolInfoLayout.decode((await connection.getAccountInfo(pub(s.pool))).data);
  const spacing = pool.tickSpacing;
  return ClmmInstrument.harvestLockPositionInstructionV2({ programId: programs.programId, auth: programs.authProgramId, clmmProgram: programs.poolProgramId, lockPositionId: pub(s.position), lockOwner: v,
    lockNftMint: pub(s.nativeNftMint), lockNftAccount: nftAccount, positionNftAccount: lock.nftAccount, positionId: lock.positionId, poolId: pub(s.pool),
    protocolPosition: getPdaProtocolPositionAddress(programs.poolProgramId, pub(s.pool), position.tickLower, position.tickUpper).publicKey,
    tickArrayLower: getPdaTickArrayAddress(programs.poolProgramId, pub(s.pool), TickUtils.getTickArrayStartIndexByTick(position.tickLower, spacing)).publicKey,
    tickArrayUpper: getPdaTickArrayAddress(programs.poolProgramId, pub(s.pool), TickUtils.getTickArrayStartIndexByTick(position.tickUpper, spacing)).publicKey,
    vaultA: pub(s.poolVaults[0]), vaultB: pub(s.poolVaults[1]), userVaultA: outputs[0], userVaultB: outputs[1], mintA: pub(s.mints[0]), mintB: pub(s.mints[1]), rewardAccounts: [] });
}
export async function snapshot(record, rpcUrl) {
  const c = connectionFor(rpcUrl);
  if (await c.getGenesisHash() !== record.plan.network) throw codeError('Select this fee collection’s network');
  const info = await c.getAccountInfo(pub(record.vault));
  if (!info) return { ...store.publicView(record), job: jobStatus(record.id), onChain: null };
  const state = assertVault(record, info);
  const accounts = await c.getMultipleAccountsInfo(feeVaultTokenAccounts(record.vault, record.plan.source));
  const received = accounts.map((a, n) => (BigInt(a?.data.readBigUInt64LE(64) || 0n) + BigInt(state.paid[n])).toString());
  const assets = await c.getMultipleAccountsInfo(record.plan.shares.map((s) => pub(s.asset)));
  return { ...store.publicView(record), job: jobStatus(record.id), onChain: { active: state.active, received, paid: state.paid,
    shares: record.plan.shares.map((s, i) => ({ ...s, owner: assets[i]?.owner.equals(CORE_PROGRAM_ID) && assets[i].data[0] === 1 ? new PublicKey(assets[i].data.subarray(1, 33)).toBase58() : null,
      claimable: state.active ? received.map((r, n) => feeEntitlement(r, s.weight, state.totalWeight, state.shares[i].paid[n])) : ['0', '0'] })) } };
}
export async function transact(id, { rpcUrl, walletPublicKey, secretKey, action, index, maxSpendLamports }) {
  if (isBusy(id)) throw codeError('Finish collection setup first');
  const record = store.get(id); const c = connectionFor(rpcUrl); const signer = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  if (signer.publicKey.toBase58() !== walletPublicKey || await c.getGenesisHash() !== record.plan.network || programId() !== record.plan.programId) throw codeError('Use this collection’s network and signing wallet');
  if (!Number.isSafeInteger(maxSpendLamports) || maxSpendLamports <= 0) throw codeError('Approve a transaction spend cap');
  const p = record.plan;
  const state = assertVault(record, await c.getAccountInfo(pub(record.vault)));
  if (!state.active) throw codeError('Activate the collection first');
  let instructions; let rent = 0;
  if (action === 'harvest') {
    instructions = [harvestFeeVault({ programId: p.programId, vault: record.vault, source: p.source, instruction: await harvestInstruction(c, record) })];
  } else if (action === 'claim' && Number.isInteger(index) && index >= 0 && index < p.count) {
    const owner = signer.publicKey; const s = p.shares[index];
    const tokenRent = await c.getMinimumBalanceForRentExemption(200);
    instructions = p.source.mints.map((m, n) => { const ata = getAssociatedTokenAddressSync(pub(m), owner, false, pub(p.source.tokenPrograms[n])); return createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, pub(m), pub(p.source.tokenPrograms[n])); });
    rent = tokenRent * 2;
    instructions.push(claimFeeShare({ programId: p.programId, vault: record.vault, source: p.source, owner, asset: s.asset, index }));
  } else { throw codeError('Choose a fee collection or claim action'); }
  // Each action has its own durable record and approved spend cap.
  const pending = Object.keys(record.operations).find((k) => k.startsWith(`${action}-${index ?? 'all'}-`) && record.operations[k].status === 'prepared' && record.operations[k].signer === walletPublicKey);
  const key = pending || `${action}-${index ?? 'all'}-${Date.now()}`;
  await sendStep(record, c, signer, key, instructions, rent, { scope: key, cap: maxSpendLamports });
  return { signature: record.operations[key]?.signature, state: await snapshot(record, rpcUrl) };
}

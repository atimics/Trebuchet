import { createHash, randomBytes } from 'node:crypto';
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddressSync, unpackMint,
} from '@solana/spl-token';
import { CpAmm, CP_AMM_PROGRAM_ID, derivePositionAddress } from '@meteora-ag/cp-amm-sdk';
import {
  ClmmInstrument, LockClPositionLayoutV2, PoolInfoLayout, PositionInfoLayout,
  getPdaLockClPositionIdV2, getPdaProtocolPositionAddress, getPdaTickArrayAddress, getPdaExBitmapAccount, TickUtils,
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
  initializeFeeVault, registerFeeShare, activateFeeVault, harvestFeeVault, claimFeeShare, recoverFeeBacking, decodeFeeVault, feeEntitlement,
} from './feeVaultClient.js';

const jobs = new Map();
const actions = new Set();
const pub = (v) => new PublicKey(v);
const codeError = (message, code = 'FEE_NFT_BLOCKED') => Object.assign(new Error(message), { statusCode: 409, code });
const connectionFor = (url) => new Connection(url, 'confirmed');
export const programId = () => process.env.TREBUCHET_FEE_VAULT_PROGRAM_ID || null;
export function jobStatus(id) { return jobs.get(id) || null; }
export function isBusy(id) { return jobStatus(id)?.status === 'running' || actions.has(id); }
export function activeWallet(walletPublicKey) {
  return store.list().find((r) => Object.values(r.operations).some((op) => op.status === 'prepared' && op.signer === walletPublicKey))?.id || null;
}

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
    if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some((p) => info.owner.equals(p))) throw codeError('Choose SPL fee tokens');
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
  const legacyLoader = pub('BPFLoader2111111111111111111111111111111111');
  const upgradeableLoader = pub('BPFLoaderUpgradeab1e11111111111111111111111');
  let bytes;
  if (info.owner.equals(legacyLoader)) bytes = info.data;
  else if (info.owner.equals(upgradeableLoader) && info.data.readUInt32LE(0) === 2) {
    const data = await connection.getAccountInfo(new PublicKey(info.data.subarray(4, 36)), 'confirmed');
    if (!data?.owner.equals(upgradeableLoader) || data.data.length < 45 || data.data.readUInt32LE(0) !== 3 || data.data[12] !== 0) throw codeError('Finalize the fee vault program before backing a collection', 'FEE_PROGRAM_SETUP');
    bytes = data.data.subarray(45);
  } else throw codeError('Use the compiled fee vault program', 'FEE_PROGRAM_SETUP');
  // Deployment capacity adds zero padding. Hash the same bytes in the build tool.
  let end = bytes.length; while (end && bytes[end - 1] === 0) end--;
  const hash = createHash('sha256').update(bytes.subarray(0, end)).digest('hex');
  if (hash !== process.env.TREBUCHET_FEE_VAULT_PROGRAM_SHA256) throw codeError('Set the verified fee vault build hash for this network', 'FEE_PROGRAM_SETUP');
}
async function assetAccounts(connection, shares) {
  const result = [];
  for (let at = 0; at < shares.length; at += 100) result.push(...await connection.getMultipleAccountsInfo(shares.slice(at, at + 100).map((s) => pub(s.asset)), 'confirmed'));
  return result;
}
export async function prepare({ rpcUrl, network, walletPublicKey, collectionId, venue, nativeNftMint, recipients }) {
  const connection = connectionFor(rpcUrl);
  const id = programId(); await requireProgram(connection, id);
  const source = await sourceFor(connection, venue, nativeNftMint, network);
  const collection = collections.get(collectionId);
  const plan = feeNftPlan({ collection, source, recipients: recipientList(recipients), creator: walletPublicKey, seed: [...randomBytes(32)], programId: id, network: await connection.getGenesisHash() });
  const assets = await assetAccounts(connection, plan.shares);
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
  if (!account) throw codeError('Create the vault first');
  const decoded = decodeFeeVault(account.data);
  const p = record.plan;
  if (!account.owner.equals(pub(p.programId)) || decoded.creator !== p.creator || decoded.collection !== p.collection || decoded.totalWeight !== p.totalWeight || decoded.count !== p.count || decoded.source.nativeNftMint !== p.source.nativeNftMint || decoded.source.position !== p.source.position || decoded.source.pool !== p.source.pool || JSON.stringify(decoded.seed) !== JSON.stringify(p.seed) || JSON.stringify(decoded.source.mints) !== JSON.stringify(p.source.mints) || JSON.stringify(decoded.source.tokenPrograms) !== JSON.stringify(p.source.tokenPrograms)) throw codeError('On-chain vault differs from the saved plan');
  if (decoded.source.venue !== p.source.venue || decoded.shares.some((s, n) => s.asset !== PublicKey.default.toBase58() && (s.asset !== p.shares[n].asset || s.weight !== p.shares[n].weight))) throw codeError('On-chain shares differ from the saved plan');
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
  if (approval?.reconcileOnly) return;
  const block = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: signer.publicKey, ...block }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...instructions);
  const fee = (await connection.getFeeForMessage(tx.compileMessage(), 'confirmed')).value;
  if (fee == null) throw codeError('Refresh the fee estimate');
  const reserved = Object.entries(record.operations).filter(([k, v]) => k !== key && (v.scope || 'setup') === scope).reduce((sum, [, v]) => sum + (v.attemptsSpentLamports || 0) + (v.spentLamports ?? v.reservedLamports ?? 0), 0);
  const attemptsSpentLamports = (op?.attemptsSpentLamports || 0) + (op?.spentLamports || 0);
  if (reserved + attemptsSpentLamports + fee + rentLamports > cap) throw codeError('Increase the approved spend cap to continue', 'FEE_SPEND_CAP');
  tx.sign(signer);
  const balance = await connection.getBalance(signer.publicKey, 'confirmed');
  const simulation = await connection.simulateTransaction(tx, undefined, [signer.publicKey]);
  if (simulation.value.err) throw codeError(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
  if (!Number.isSafeInteger(simulation.value.accounts?.[0]?.lamports)) throw codeError('Refresh the payer account simulation');
  const reservation = Math.max(fee + rentLamports, balance - simulation.value.accounts[0].lamports);
  if (reserved + attemptsSpentLamports + reservation > cap) throw codeError('Increase the approved spend cap to cover the simulated debit', 'FEE_SPEND_CAP');
  const attempts = [...(op?.attempts || []), ...(op?.signature ? [{ signature: op.signature, spentLamports: op.spentLamports || 0 }] : [])];
  op = { bytes: tx.serialize().toString('base64'), signature: bs58.encode(tx.signature), lastValidBlockHeight: block.lastValidBlockHeight, reservedLamports: reservation, scope, signer: signer.publicKey.toBase58(), status: 'prepared', attemptsSpentLamports, attempts };
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
  if (Object.values(record.operations).some((op) => op.status === 'prepared' && (op.scope || 'setup') !== 'setup' && op.signer === walletPublicKey)) throw codeError('Resume the pending fee claim or collection first');
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
    if (String(asset.owner) === s.recipient) {
      if (record.operations[`send-${s.index}`]?.status === 'prepared') await sendStep(record, connection, signer, `send-${s.index}`, [], 0, { reconcileOnly: true });
      continue;
    }
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
    const tx = await cp.claimPositionFee({ owner: v, position: pub(s.position), pool: pub(s.pool), positionNftAccount: nftAccount,
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
  const bitmap = getPdaExBitmapAccount(programs.poolProgramId, pub(s.pool)).publicKey;
  const exTickArrayBitmap = await connection.getAccountInfo(bitmap) ? bitmap : undefined;
  return ClmmInstrument.harvestLockPositionInstructionV2({ programId: programs.programId, auth: programs.authProgramId, clmmProgram: programs.poolProgramId, lockPositionId: pub(s.position), lockOwner: v,
    lockNftMint: pub(s.nativeNftMint), lockNftAccount: nftAccount, positionNftAccount: lock.nftAccount, positionId: lock.positionId, poolId: pub(s.pool),
    protocolPosition: getPdaProtocolPositionAddress(programs.poolProgramId, pub(s.pool), position.tickLower, position.tickUpper).publicKey,
    tickArrayLower: getPdaTickArrayAddress(programs.poolProgramId, pub(s.pool), TickUtils.getTickArrayStartIndexByTick(position.tickLower, spacing)).publicKey,
    tickArrayUpper: getPdaTickArrayAddress(programs.poolProgramId, pub(s.pool), TickUtils.getTickArrayStartIndexByTick(position.tickUpper, spacing)).publicKey,
    vaultA: pub(s.poolVaults[0]), vaultB: pub(s.poolVaults[1]), userVaultA: outputs[0], userVaultB: outputs[1], mintA: pub(s.mints[0]), mintB: pub(s.mints[1]), rewardAccounts: [], exTickArrayBitmap });
}
export async function snapshot(record, rpcUrl) {
  const c = connectionFor(rpcUrl);
  if (await c.getGenesisHash() !== record.plan.network) throw codeError('Select this fee collection’s network');
  const info = await c.getAccountInfo(pub(record.vault));
  if (!info) return { ...store.publicView(record), job: jobStatus(record.id), onChain: null };
  const state = assertVault(record, info);
  const accounts = await c.getMultipleAccountsInfo(feeVaultTokenAccounts(record.vault, record.plan.source));
  const received = accounts.map((a, n) => (BigInt(a?.data.readBigUInt64LE(64) || 0n) + BigInt(state.paid[n])).toString());
  const assets = await assetAccounts(c, record.plan.shares);
  return { ...store.publicView(record), job: jobStatus(record.id), onChain: { active: state.active, received, paid: state.paid,
    shares: record.plan.shares.map((s, i) => ({ ...s, owner: assets[i]?.owner.equals(CORE_PROGRAM_ID) && assets[i].data[0] === 1 ? new PublicKey(assets[i].data.subarray(1, 33)).toBase58() : null,
      claimable: state.active ? received.map((r, n) => feeEntitlement(r, s.weight, state.totalWeight, state.shares[i].paid[n])) : ['0', '0'] })) } };
}
export async function importProof(proof, rpcUrl) {
  const p = proof?.plan;
  if (!p || p.schema !== 'trebuchet.fee-nfts.v1' || p.programId !== programId()) throw codeError('Choose a fee proof for the configured program');
  const { digest, ...body } = p;
  if (createHash('sha256').update(JSON.stringify(body)).digest('hex') !== digest) throw codeError('Choose the original fee proof');
  const c = connectionFor(rpcUrl); await requireProgram(c, p.programId);
  if (await c.getGenesisHash() !== p.network) throw codeError('Select the fee proof’s network');
  const verifiedSource = await sourceFor(c, p.source.venue === 'meteora' ? 'meteora' : 'raydium', p.source.nativeNftMint, p.source.venue === 'raydium-devnet' ? 'devnet' : 'mainnet');
  if (JSON.stringify(verifiedSource) !== JSON.stringify(p.source)) throw codeError('Fee proof backing differs from the pool');
  const vault = feeVaultAddress(p.programId, p.creator, p.seed).toBase58();
  const state = assertVault({ plan: p }, await c.getAccountInfo(pub(vault)));
  if (!state.active || state.registered !== p.count || p.shares.length !== p.count) throw codeError('Choose an active fee collection');
  const existing = store.list().find((r) => r.vault === vault && r.plan.digest === digest);
  if (existing) return existing;
  const record = store.create(p); record.vault = vault; record.status = 'active'; record.estimate = { totalLamports: 0 }; return store.save(record);
}
export async function prepareHolderClaim(id, { rpcUrl, walletPublicKey, index, maxSpendLamports, action = 'claim' }) {
  const record = store.get(id); const p = record.plan; const c = connectionFor(rpcUrl);
  await requireProgram(c, p.programId);
  if (await c.getGenesisHash() !== p.network || !['claim', 'harvest'].includes(action) || (action === 'claim' && (!Number.isInteger(index) || index < 0 || index >= p.count))) throw codeError('Choose this collection’s network and NFT');
  if (!Number.isSafeInteger(maxSpendLamports) || maxSpendLamports <= 0) throw codeError('Approve a claim spend cap');
  const state = assertVault(record, await c.getAccountInfo(pub(record.vault)));
  const owner = pub(walletPublicKey);
  if (!state.active) throw codeError('Activate this fee collection first');
  if (action === 'claim') {
    const asset = await c.getAccountInfo(pub(p.shares[index].asset));
    if (!asset?.owner.equals(CORE_PROGRAM_ID) || asset.data[0] !== 1 || !new PublicKey(asset.data.subarray(1, 33)).equals(owner)) throw codeError('Connect the wallet that holds this NFT');
  }
  const outputs = p.source.mints.map((m, n) => getAssociatedTokenAddressSync(pub(m), owner, false, pub(p.source.tokenPrograms[n])));
  const accounts = await c.getMultipleAccountsInfo(outputs);
  const rent = action === 'claim' ? accounts.filter((a) => !a).length * await c.getMinimumBalanceForRentExemption(200) : 0;
  const block = await c.getLatestBlockhash('confirmed');
  const instructions = action === 'harvest' ? [harvestFeeVault({ programId: p.programId, vault: record.vault, source: p.source, instruction: await harvestInstruction(c, record) })] : [
    ...p.source.mints.map((m, n) => createAssociatedTokenAccountIdempotentInstruction(owner, outputs[n], owner, pub(m), pub(p.source.tokenPrograms[n]))),
    claimFeeShare({ programId: p.programId, vault: record.vault, source: p.source, owner, asset: p.shares[index].asset, index })];
  const tx = new Transaction({ feePayer: owner, ...block }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...instructions);
  const fee = (await c.getFeeForMessage(tx.compileMessage(), 'confirmed')).value;
  if (fee == null || fee + rent > maxSpendLamports) throw codeError('Increase the approved claim spend cap', 'FEE_SPEND_CAP');
  const genesis = p.network;
  const chain = genesis === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' ? 'solana:mainnet' : genesis === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1' ? 'solana:devnet' : 'solana:localnet';
  return { transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), chain, maxDebitLamports: fee + rent, lastValidBlockHeight: block.lastValidBlockHeight, asset: action === 'claim' ? p.shares[index].asset : null };
}
export async function transact(id, options) {
  if (isBusy(id)) throw codeError('Finish collection setup first');
  actions.add(id);
  try { return await transactLocked(id, options); } finally { actions.delete(id); }
}
async function transactLocked(id, { rpcUrl, walletPublicKey, secretKey, action, index, maxSpendLamports }) {
  const record = store.get(id); const c = connectionFor(rpcUrl); const signer = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  if (signer.publicKey.toBase58() !== walletPublicKey || await c.getGenesisHash() !== record.plan.network || programId() !== record.plan.programId) throw codeError('Use this collection’s network and signing wallet');
  await requireProgram(c, record.plan.programId);
  if (!Number.isSafeInteger(maxSpendLamports) || maxSpendLamports <= 0) throw codeError('Approve a transaction spend cap');
  const p = record.plan;
  const state = assertVault(record, await c.getAccountInfo(pub(record.vault)));
  if (action === 'recover') {
    if (state.active || walletPublicKey !== p.creator) throw codeError('Backing recovery is available to the creator during setup');
  } else if (!state.active) throw codeError('Activate the collection first');
  const held = Object.entries(record.operations).find(([, op]) => op.status === 'prepared');
  if (held && held[1].signer !== walletPublicKey) throw codeError('Resume the saved action with its signing wallet first');
  if (held && !held[0].startsWith(`${action}-${index ?? 'all'}-`)) throw codeError('Resume the pending wallet action first');
  let instructions; let rent = 0;
  if (action === 'recover') {
    const mint = pub(p.source.nativeNftMint); const tokenProgram = pub(p.source.nativeTokenProgram);
    const ata = getAssociatedTokenAddressSync(mint, signer.publicKey, false, tokenProgram);
    rent = await c.getMinimumBalanceForRentExemption(200);
    instructions = [createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, ata, signer.publicKey, mint, tokenProgram), recoverFeeBacking({ programId: p.programId, vault: record.vault, source: p.source, creator: p.creator })];
  } else if (action === 'harvest') {
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
  if (action === 'recover') {
    record.operations[`previous-backing-${Date.now()}`] = record.operations.backing;
    delete record.operations.backing;
    record.status = 'backing-returned'; store.save(record);
  }
  return { signature: record.operations[key]?.signature, state: await snapshot(record, rpcUrl) };
}

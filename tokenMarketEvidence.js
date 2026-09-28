import { PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import { PoolInfoLayout, PositionInfoLayout, LockClPositionLayoutV2, getPdaPersonalPositionAddress } from '@raydium-io/raydium-sdk-v2';
import { clmmLockPrograms, decodeClmmLock } from './clmmLockEvidence.js';
import { redactSensitiveText } from './logRedaction.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MAX_POOLS = 12;
const MAX_LOCKS = 32;
const U64_MAX = (1n << 64n) - 1n;
const percent = (amount, supply) => supply > 0n ? Number(amount * 10000n / supply) / 100 : null;
const tokenProgram = (info) => [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].find((id) => info?.owner?.equals(id));

export function marketEvidenceError(error) {
  const message = String(error?.message || 'This check needs another try.');
  if (/429|too many requests/i.test(message)) return 'RPC rate limit reached. Try again later or choose a dedicated RPC in Settings.';
  return redactSensitiveText(message.replace(/https?:\/\/[^\s"'<>]+/gi, '[RPC endpoint]')).slice(0, 400);
}

function readTokenAccount(address, info, mint) {
  const program = tokenProgram(info);
  if (!program) throw new Error('Token account owner needs verification.');
  const account = unpackAccount(new PublicKey(address), info, program);
  if (!account.mint.equals(new PublicKey(mint))) throw new Error('Token account mint changed.');
  return account;
}

function decodePool(info, network) {
  const { poolProgramId } = clmmLockPrograms(network);
  if (!info?.owner?.equals(poolProgramId) || info.data?.length !== PoolInfoLayout.span) return null;
  return PoolInfoLayout.decode(info.data);
}

// The sample covers the largest token accounts. Pool vaults are checked against
// their pool's mint and vault fields before they are separated from wallets.
export async function readHolderSample(connection, mint, supply, network = 'mainnet', largestAccounts = null) {
  const result = largestAccounts || await connection.getTokenLargestAccounts(new PublicKey(mint), 'finalized');
  const rows = (result.value || []).slice(0, 20);
  const accounts = await connection.getMultipleAccountsInfo(rows.map((r) => new PublicKey(r.address)), 'finalized');
  const parsed = rows.map((row, i) => {
    try {
      const account = readTokenAccount(row.address, accounts[i], mint);
      return { address: String(row.address), owner: account.owner.toBase58(), amount: account.amount.toString() };
    } catch { return { address: String(row.address), owner: null, amount: String(row.amount), kind: 'unverified' }; }
  });
  const owners = [...new Set(parsed.map((r) => r.owner).filter(Boolean))];
  const infos = owners.length
    ? await connection.getMultipleAccountsInfo(owners.map((owner) => new PublicKey(owner)), 'finalized') : [];
  const byOwner = new Map(owners.map((owner, i) => [owner, infos[i]]));
  const wallets = new Map();
  let poolAmount = 0n;
  let otherAmount = 0n;
  for (const row of parsed) {
    if (!row.owner) { otherAmount += BigInt(row.amount); continue; }
    const info = byOwner.get(row.owner);
    const pool = decodePool(info, network);
    const isPool = pool && ((pool.mintA.toBase58() === mint && pool.vaultA.toBase58() === row.address)
      || (pool.mintB.toBase58() === mint && pool.vaultB.toBase58() === row.address));
    if (isPool) {
      row.kind = 'raydium-clmm-vault';
      poolAmount += BigInt(row.amount);
    } else if (info?.owner?.equals(SystemProgram.programId) && !info.executable && PublicKey.isOnCurve(new PublicKey(row.owner).toBytes())) {
      row.kind = 'wallet';
      wallets.set(row.owner, (wallets.get(row.owner) || 0n) + BigInt(row.amount));
    } else {
      row.kind = 'other-or-unverified';
      otherAmount += BigInt(row.amount);
    }
  }
  const total = BigInt(supply);
  const walletRows = [...wallets].map(([owner, amount]) => ({ owner, amount: amount.toString() }))
    .sort((a, b) => BigInt(a.amount) > BigInt(b.amount) ? -1 : BigInt(a.amount) < BigInt(b.amount) ? 1 : 0);
  return {
    scope: 'Largest 20 token accounts; Raydium CLMM vaults verified on-chain.',
    slot: result.context?.slot ?? null,
    accounts: parsed,
    wallets: walletRows,
    poolSupplyPercent: percent(poolAmount, total),
    sampledWalletSupplyPercent: percent(walletRows.reduce((sum, row) => sum + BigInt(row.amount), 0n), total),
    otherSupplyPercent: percent(otherAmount, total),
    sampledSupplyPercent: percent(parsed.reduce((sum, row) => sum + BigInt(row.amount), 0n), total),
  };
}

async function currentFeeOwner(connection, mint) {
  const largest = await connection.getTokenLargestAccounts(new PublicKey(mint), 'finalized');
  const holders = (largest.value || []).filter((row) => BigInt(row.amount) > 0n);
  if (holders.length !== 1 || holders[0].amount !== '1' || holders[0].decimals !== 0) {
    throw new Error('Fee Key ownership needs a fresh check.');
  }
  const address = new PublicKey(holders[0].address);
  const info = await connection.getAccountInfo(address, 'finalized');
  const account = readTokenAccount(address, info, mint);
  if (account.amount !== 1n) throw new Error('Fee Key moved during inspection.');
  return { address: account.owner.toBase58(), tokenAccount: address.toBase58(), slot: largest.context?.slot ?? null };
}

export async function readPoolEvidence(connection, poolId, mint, network = 'mainnet', { includeLocks = true } = {}) {
  const inspectedAt = new Date().toISOString();
  const address = new PublicKey(poolId);
  const info = await connection.getAccountInfo(address, 'finalized');
  const pool = decodePool(info, network);
  if (!pool || (!pool.mintA.equals(new PublicKey(mint)) && !pool.mintB.equals(new PublicKey(mint)))) {
    throw new Error('This pool needs a supported Raydium CLMM account.');
  }
  const infos = await connection.getMultipleAccountsInfo([pool.vaultA, pool.vaultB], 'finalized');
  const a = readTokenAccount(pool.vaultA, infos[0], pool.mintA.toBase58());
  const b = readTokenAccount(pool.vaultB, infos[1], pool.mintB.toBase58());
  if (!a.owner.equals(address) || !b.owner.equals(address)) throw new Error('Pool vault ownership changed.');
  const tokenIsA = pool.mintA.toBase58() === mint;
  const reserves = [
    { mint: pool.mintA.toBase58(), amount: a.amount.toString(), decimals: pool.mintDecimalsA },
    { mint: pool.mintB.toBase58(), amount: b.amount.toString(), decimals: pool.mintDecimalsB },
  ];
  const result = {
    poolId, inspectedAt, token: reserves[tokenIsA ? 0 : 1], quote: reserves[tokenIsA ? 1 : 0],
    tickCurrent: pool.tickCurrent,
    reserveScope: 'Vault balances include inventory across price ranges and accrued fees. Request a sell quote for proceeds.',
    locks: [], lockStatus: 'checked', lockError: null,
  };
  if (!includeLocks) { result.lockStatus = 'pending'; return result; }
  try {
    const { programId, poolProgramId } = clmmLockPrograms(network);
    const entries = await connection.getProgramAccounts(programId, {
      commitment: 'finalized',
      filters: [{ dataSize: LockClPositionLayoutV2.span }, { memcmp: { offset: LockClPositionLayoutV2.offsetOf('poolId'), bytes: poolId } }],
    });
    result.lockRecordsFound = entries.length;
    result.lockStatus = entries.length > MAX_LOCKS ? 'partial' : 'checked';
    for (const entry of entries.slice(0, MAX_LOCKS)) {
      const lock = decodeClmmLock(entry, network);
      if (!lock?.poolId.equals(address)) { result.lockStatus = 'partial'; continue; }
      const positionInfo = await connection.getAccountInfo(lock.positionId, 'finalized');
      if (!positionInfo?.owner?.equals(poolProgramId) || positionInfo.data?.length !== PositionInfoLayout.span) {
        result.lockStatus = 'partial'; continue;
      }
      const position = PositionInfoLayout.decode(positionInfo.data);
      const expected = getPdaPersonalPositionAddress(poolProgramId, position.nftMint).publicKey;
      if (!position.poolId.equals(address) || !expected.equals(lock.positionId)) { result.lockStatus = 'partial'; continue; }
      const row = {
        lockAccount: entry.pubkey.toBase58(), lockProgram: programId.toBase58(),
        positionId: lock.positionId.toBase58(), positionNftMint: position.nftMint.toBase58(),
        tickLower: position.tickLower, tickUpper: position.tickUpper,
        liquidity: position.liquidity.toString(), feeKeyMint: lock.lockNftMint.toBase58(),
        feeOwner: null, feeOwnerError: null,
      };
      try { row.feeOwner = await currentFeeOwner(connection, row.feeKeyMint); }
      catch (error) { row.feeOwnerError = marketEvidenceError(error); }
      result.locks.push(row);
    }
  } catch (error) { result.lockStatus = 'unavailable'; result.lockError = marketEvidenceError(error); }
  return result;
}

export async function readTokenMarketEvidence(connection, mint, { supply, pools = [], network = 'mainnet' } = {}) {
  const evidence = {
    schema: 'trebuchet-market-evidence/v1', mint, network, inspectedAt: new Date().toISOString(),
    holderSample: null, holderError: null, pools: [],
    feeRights: 'Trading fees accrue to the current Fee Key holder.',
    flywheel: 'Static pool allocation. Fee routing is a planned feature.',
  };
  try { evidence.holderSample = await readHolderSample(connection, mint, supply, network); }
  catch (error) { evidence.holderError = marketEvidenceError(error); }
  const ids = [...new Set([
    ...pools.map((p) => p.poolId || p.address).filter(Boolean),
    ...(evidence.holderSample?.accounts || []).filter((r) => r.kind === 'raydium-clmm-vault').map((r) => r.owner),
  ])];
  evidence.poolCoverage = { requested: ids.length, limit: MAX_POOLS, inspected: Math.min(ids.length, MAX_POOLS) };
  // Keep the RPC load bounded even for tokens with many pools and positions.
  for (let i = 0; i < Math.min(ids.length, MAX_POOLS); i += 2) {
    const rows = await Promise.all(ids.slice(i, Math.min(i + 2, MAX_POOLS)).map(async (poolId) => {
      try { return await readPoolEvidence(connection, poolId, mint, network); }
      catch (error) { return { poolId, error: marketEvidenceError(error) }; }
    }));
    evidence.pools.push(...rows);
  }
  return evidence;
}

export function tokenAmountRaw(value, decimals) {
  const text = String(value ?? '').trim();
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !/^\d{1,20}(?:\.\d{1,18})?$/.test(text)) {
    throw new Error('Enter a positive token amount using digits and a decimal point.');
  }
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (raw <= 0n || raw > U64_MAX) throw new Error('Token amount is outside the supported range.');
  return raw.toString();
}

export async function fetchSellQuote({ mint, amount, decimals, fetchImpl = globalThis.fetch }) {
  new PublicKey(mint);
  if (mint === SOL_MINT) throw new Error('Choose a token to quote into SOL.');
  const raw = tokenAmountRaw(amount, decimals);
  const url = new URL('https://transaction-v1.raydium.io/compute/swap-base-in');
  for (const [key, value] of Object.entries({ inputMint: mint, outputMint: SOL_MINT, amount: raw, slippageBps: '100', txVersion: 'V0' })) url.searchParams.set(key, value);
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Sell quote service returned HTTP ${response.status}.`);
  const payload = await response.json();
  const quote = payload?.data;
  if (payload.success !== true || !quote?.routePlan?.length) throw new Error('A sell route is unavailable for this amount.');
  if (quote.inputMint !== mint || quote.outputMint !== SOL_MINT || quote.inputAmount !== raw || quote.swapType !== 'BaseIn'
      || quote.slippageBps !== 100) throw new Error('Sell quote details differ from the request.');
  const values = [quote.outputAmount, quote.otherAmountThreshold];
  if (values.some((v) => typeof v !== 'string' || !/^\d{1,20}$/.test(v) || BigInt(v) <= 0n || BigInt(v) > U64_MAX)
      || BigInt(values[1]) > BigInt(values[0])
      || BigInt(values[1]) < BigInt(values[0]) * 99n / 100n) throw new Error('Sell quote amounts need verification.');
  return {
    mint, inputAmount: raw, decimals, amount: String(amount), outputMint: SOL_MINT,
    outputLamports: quote.outputAmount, minimumLamports: quote.otherAmountThreshold,
    slippageBps: 100, quotedAt: new Date().toISOString(), source: 'Raydium Trade API',
    scope: 'Route estimate at the quoted time. Network fees apply separately.',
  };
}

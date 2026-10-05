// coinAirdrop.js
//
// Who a coin's airdrop reached, how much each wallet received, and what each
// holds now. The launch record says what was sent; the chain says what is
// left, so a wallet that sold, moved, or burned its tokens shows it.

import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

const READ_BATCH = 100;
const OWNER_SCAN_LIMIT = 6;

const journalMint = (journal) => String(journal?.token?.mint || journal?.token?.tokenMint || '').trim();

/**
 * Every delivered airdrop row for a mint, one per wallet, summed across the
 * launch records that sent to it. Amounts are raw base units as strings.
 */
export function airdropDeliveries(journals = [], mint) {
  const byWallet = new Map();
  for (const journal of journals) {
    if (journalMint(journal) !== mint) continue;
    for (const row of journal?.airdrop?.transferred || []) {
      const wallet = String(row?.wallet || '').trim();
      if (!wallet) continue;
      let received;
      try { received = BigInt(String(row.receivedRaw ?? row.amountRaw ?? '0')); } catch { continue; }
      const existing = byWallet.get(wallet);
      if (existing) {
        existing.receivedRaw += received;
        if (row.txId) existing.txIds.push(row.txId);
      } else {
        byWallet.set(wallet, { wallet, receivedRaw: received, txIds: row.txId ? [row.txId] : [] });
      }
    }
  }
  return [...byWallet.values()];
}

function rawAmount(parsedAccount) {
  const amount = parsedAccount?.data?.parsed?.info?.tokenAmount?.amount;
  try { return amount == null ? null : BigInt(amount); } catch { return null; }
}

/**
 * Each delivered wallet's current balance of the mint. Reads the wallet's
 * associated account in batches; a wallet whose associated account is empty or
 * gone is checked for other accounts of the mint before it counts as holding none.
 * `nowRaw` is null when the chain could not be read for that wallet.
 */
export async function readAirdropHolders(connection, { mint, tokenProgram, deliveries }) {
  const mintKey = new PublicKey(mint);
  const programKey = new PublicKey(tokenProgram);
  const rows = deliveries.map((row) => {
    let ata = null;
    try { ata = getAssociatedTokenAddressSync(mintKey, new PublicKey(row.wallet), true, programKey); } catch { /* not a wallet address */ }
    return { ...row, ata, nowRaw: null };
  });
  const readable = rows.filter((row) => row.ata);
  for (let i = 0; i < readable.length; i += READ_BATCH) {
    const batch = readable.slice(i, i + READ_BATCH);
    const accounts = await connection.getMultipleParsedAccounts(batch.map((row) => row.ata), { commitment: 'confirmed' });
    accounts.value.forEach((account, index) => {
      batch[index].nowRaw = account ? rawAmount(account) : 0n;
    });
  }
  // Tokens can sit in an account other than the associated one: look before calling them gone.
  const empty = readable.filter((row) => row.nowRaw === 0n);
  for (let i = 0; i < empty.length; i += OWNER_SCAN_LIMIT) {
    await Promise.all(empty.slice(i, i + OWNER_SCAN_LIMIT).map(async (row) => {
      try {
        const owned = await connection.getParsedTokenAccountsByOwner(new PublicKey(row.wallet), { mint: mintKey }, 'confirmed');
        row.nowRaw = owned.value.reduce((sum, item) => sum + (rawAmount(item.account) || 0n), 0n);
      } catch {
        row.nowRaw = null;
      }
    }));
  }
  return rows.map(({ wallet, receivedRaw, txIds, nowRaw }) => ({
    wallet,
    receivedRaw: receivedRaw.toString(),
    nowRaw: nowRaw == null ? null : nowRaw.toString(),
    txIds,
  }));
}

// Programs whose transactions trade one asset for another: a balance change there is a buy or a sell.
export const SWAP_PROGRAMS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', // Raydium LaunchLab
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora DAMM v1
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', // Meteora DAMM v2
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // Pump AMM
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump
]);

const HISTORY_LIMIT = 50;
const HISTORY_CONCURRENCY = 4;

const keyOf = (key) => String(key?.pubkey?.toBase58?.() || key?.pubkey || key?.toBase58?.() || key || '');

function ownerTokenDeltas(tx, owner) {
  const deltas = new Map();
  const add = (rows, sign) => {
    for (const row of rows || []) {
      if (row.owner !== owner) continue;
      let amount;
      try { amount = BigInt(row.uiTokenAmount?.amount || '0'); } catch { continue; }
      deltas.set(row.mint, (deltas.get(row.mint) || 0n) + sign * amount);
    }
  };
  add(tx.meta?.preTokenBalances, -1n);
  add(tx.meta?.postTokenBalances, 1n);
  return deltas;
}

function allInstructions(tx) {
  return [
    ...(tx.transaction?.message?.instructions || []),
    ...(tx.meta?.innerInstructions || []).flatMap((inner) => inner.instructions || []),
  ];
}

/**
 * What one transaction did to a wallet's holding of the mint, from the chain's
 * own balances: burned, sold, bought, sent, or received. Null when it didn't change it.
 */
export function classifyHoldingChange(tx, { owner, mint }) {
  if (!tx || tx.meta?.err) return null;
  const instructions = allInstructions(tx);
  let burned = 0n;
  for (const ix of instructions) {
    const type = ix?.parsed?.type;
    if ((type === 'burn' || type === 'burnChecked') && ix.parsed.info?.mint === mint
        && [ix.parsed.info?.authority, ix.parsed.info?.multisigAuthority].includes(owner)) {
      try { burned += BigInt(ix.parsed.info.amount ?? ix.parsed.info.tokenAmount?.amount ?? '0'); } catch { /* unreadable amount */ }
    }
  }
  const deltas = ownerTokenDeltas(tx, owner);
  const delta = (deltas.get(mint) || 0n) + burned;
  if (!burned && !delta) return null;
  // Anything else coming the other way in the same transaction makes it a trade.
  const keys = (tx.transaction?.message?.accountKeys || []).map(keyOf);
  const ownerIndex = keys.indexOf(owner);
  const fee = ownerIndex === 0 ? BigInt(tx.meta?.fee || 0) : 0n;
  const lamports = ownerIndex >= 0
    ? BigInt(tx.meta?.postBalances?.[ownerIndex] ?? 0) - BigInt(tx.meta?.preBalances?.[ownerIndex] ?? 0) + fee
    : 0n;
  const otherIn = [...deltas].some(([other, amount]) => other !== mint && amount > 0n) || lamports > 5000n;
  const otherOut = [...deltas].some(([other, amount]) => other !== mint && amount < 0n) || lamports < -5000n;
  const swap = instructions.some((ix) => SWAP_PROGRAMS.has(keyOf(ix.programId)));
  const change = { signature: tx.transaction?.signatures?.[0] || null, at: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null, burnedRaw: burned };
  if (delta < 0n) return { ...change, kind: swap || otherIn ? 'sold' : 'sent', amountRaw: -delta };
  if (delta > 0n) return { ...change, kind: swap || otherOut ? 'bought' : 'received', amountRaw: delta };
  return { ...change, kind: 'burned', amountRaw: 0n };
}

// The client library can't decode every transaction version; ask the RPC for those as plain JSON.
async function rawParsedTransaction(connection, signature) {
  const endpoint = connection.rpcEndpoint;
  if (!endpoint) throw new Error('Transaction version not readable');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }] }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || 'Transaction not readable');
  return payload.result;
}

async function parsedTransactions(connection, signatures) {
  try {
    return { txs: await connection.getParsedTransactions(signatures, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }), unread: 0 };
  } catch {
    let unread = 0;
    const txs = [];
    for (const signature of signatures) {
      try {
        txs.push(await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }));
      } catch {
        try { txs.push(await rawParsedTransaction(connection, signature)); } catch { unread += 1; }
      }
    }
    return { txs, unread };
  }
}

const TOTAL_FIELDS = ['burnedRaw', 'soldRaw', 'boughtRaw', 'sentRaw', 'transferredInRaw'];
const MAX_PAGES = 6;

// A token account's transactions newer than `until`, newest first, a page at a time.
// `complete` is false when there were more than the pages read allow.
async function signaturesSince(connection, account, until) {
  const found = [];
  let before;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const list = await connection.getSignaturesForAddress(new PublicKey(account), { limit: HISTORY_LIMIT, ...(until ? { until } : {}), ...(before ? { before } : {}) }, 'confirmed');
    found.push(...list);
    if (list.length < HISTORY_LIMIT) return { list: found, complete: true };
    before = list[list.length - 1].signature;
  }
  return { list: found, complete: false };
}

/**
 * Each wallet's burns, sells, buys, sends, and receipts of the mint since its airdrop.
 * `known` is what was read before (per wallet: totals, and the newest transaction read on
 * each token account); only transactions newer than that are read and added to it.
 * The airdrop's own transactions are skipped. A wallet whose read fails keeps what was known.
 */
export async function readAirdropHistory(connection, { mint, tokenProgram, recipients, known = {} }) {
  const mintKey = new PublicKey(mint);
  const programKey = new PublicKey(tokenProgram);
  const results = new Map();
  const work = [...recipients];
  const next = async () => {
    for (let row = work.shift(); row; row = work.shift()) {
      const before = known[row.wallet] || null;
      const totals = Object.fromEntries(TOTAL_FIELDS.map((field) => {
        try { return [field, BigInt(before?.[field] || '0')]; } catch { return [field, 0n]; }
      }));
      const cursors = { ...(before?.cursors || {}) };
      let partial = Boolean(before?.partial);
      try {
        const owner = new PublicKey(row.wallet);
        const accounts = new Set([getAssociatedTokenAddressSync(mintKey, owner, true, programKey).toBase58(), ...Object.keys(cursors)]);
        const owned = await connection.getParsedTokenAccountsByOwner(owner, { mint: mintKey }, 'confirmed').catch(() => ({ value: [] }));
        owned.value.forEach((item) => accounts.add(keyOf(item.pubkey)));
        const skip = new Set(row.txIds || []);
        const signatures = new Set();
        const newest = {};
        for (const account of accounts) {
          const { list, complete } = await signaturesSince(connection, account, cursors[account]);
          // Older history past the pages read is left unread on a first read only; later reads start from the cursor.
          if (!complete && !cursors[account]) partial = true;
          if (list[0]) newest[account] = list[0].signature;
          list.filter((item) => !item.err && !skip.has(item.signature)).forEach((item) => signatures.add(item.signature));
        }
        const { txs, unread } = signatures.size ? await parsedTransactions(connection, [...signatures]) : { txs: [], unread: 0 };
        if (unread) partial = true;
        for (const tx of txs) {
          const change = classifyHoldingChange(tx, { owner: row.wallet, mint });
          if (!change) continue;
          totals.burnedRaw += change.burnedRaw;
          const field = { sold: 'soldRaw', bought: 'boughtRaw', sent: 'sentRaw', received: 'transferredInRaw' }[change.kind];
          if (field) totals[field] += change.amountRaw;
        }
        Object.assign(cursors, newest);
        results.set(row.wallet, { totals, cursors, partial, error: null });
      } catch (error) {
        results.set(row.wallet, before
          ? { totals, cursors: before.cursors || {}, partial: Boolean(before.partial), error: error.message || 'History not readable' }
          : { totals, cursors: {}, partial, error: error.message || 'History not readable' });
      }
    }
  };
  await Promise.all(Array.from({ length: HISTORY_CONCURRENCY }, next));
  return recipients.map((row) => {
    const { totals, cursors, partial, error } = results.get(row.wallet);
    return {
      wallet: row.wallet,
      ...Object.fromEntries(TOTAL_FIELDS.map((field) => [field, totals[field].toString()])),
      cursors,
      partial,
      error,
      readAt: new Date().toISOString(),
    };
  });
}

/**
 * Airdrop lists used by earlier launches, newest first: each launch's planned recipients
 * (wallet and tokens), one per distinct set of wallets, at most `limit`.
 */
export function previousAirdropLists(journals = [], limit = 5) {
  const seen = new Set();
  const lists = [];
  const ordered = journals.slice().sort((a, b) => String(b?.createdAt || '').localeCompare(String(a?.createdAt || '')));
  for (const journal of ordered) {
    const recipients = (journal?.launchConfig?.poolTopology?.airdrop?.recipients || [])
      .map((row) => ({ wallet: String(row?.wallet || '').trim(), tokens: Number(row?.tokens) }))
      .filter((row) => row.wallet && Number.isFinite(row.tokens) && row.tokens > 0);
    if (!recipients.length) continue;
    const key = recipients.map((row) => row.wallet).sort().join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    lists.push({ id: journal.id, symbol: journal.token?.symbol || null, name: journal.token?.name || null, createdAt: journal.createdAt || null, recipients });
  }
  return lists.slice(0, limit);
}

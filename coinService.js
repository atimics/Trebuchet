// coinService.js
//
// Coins are what the app is organized around; a launch is one event in a
// coin's life. A coin is a draft (a saved plan, no mint yet), or it is
// on-chain: launched here (a launch journal), or added by address. The
// list merges those records. On-chain facts are read fresh from the chain
// each time; records are claims to check against it, not state.

import { PublicKey } from '@solana/web3.js';

const lower = (value) => String(value || '').trim().toLowerCase();

function isPracticeMint(mint) {
  return /^Demo/.test(String(mint || ''));
}

function journalMint(journal) {
  return String(journal?.token?.mint || journal?.token?.tokenMint || '').trim();
}

// What the launch record claims. The app says "Live" only once the chain
// agrees (see coinChainStatus in the client), never from the record alone.
function journalStatus(journal) {
  if (journal.status === 'completed') return 'Launch recorded';
  if (journal.status === 'archived') return 'Launch stopped';
  return 'Being created';
}

/**
 * One list of coins from saved drafts, launch journals, and coins added by
 * address. A draft that has since launched is shown once, as the launched
 * coin. Test coins appear only in test mode.
 */
export function mergeCoins({ launches = [], journals = [], added = [], practice = false } = {}) {
  const byMint = new Map();
  for (const journal of journals) {
    const mint = journalMint(journal);
    if (!mint) continue;
    const isPractice = journal.demo === true || isPracticeMint(mint);
    // Real coins show in both modes; practice coins only in Practice.
    if (isPractice && !practice) continue;
    const token = { ...(journal.launchConfig?.token || {}), ...(journal.token || {}) };
    const existing = byMint.get(mint);
    if (existing && String(existing.updatedAt) > String(journal.updatedAt)) continue;
    byMint.set(mint, {
      key: `mint:${mint}`,
      kind: 'onchain',
      mint,
      name: token.name || null,
      symbol: token.symbol || null,
      status: journalStatus(journal),
      journalId: journal.id || null,
      image: token.imageUri || null,
      launchedHere: true,
      practice: isPractice,
      updatedAt: journal.updatedAt || journal.createdAt || null,
    });
  }
  for (const coin of added) {
    if (!coin?.mint || coin.hidden) continue;
    if (isPracticeMint(coin.mint) && !practice) continue;
    const existing = byMint.get(coin.mint);
    if (existing) {
      byMint.set(coin.mint, {
        ...existing,
        name: existing.name || coin.name || null,
        symbol: existing.symbol || coin.symbol || null,
        image: coin.image || existing.image || null,
        eventCount: (coin.events || []).length,
      });
      continue;
    }
    byMint.set(coin.mint, {
      key: `mint:${coin.mint}`,
      kind: 'onchain',
      mint: coin.mint,
      name: coin.name || null,
      symbol: coin.symbol || null,
      status: coin.source === 'added' ? 'Added' : coin.source === 'practice' ? 'Test coin' : 'On-chain',
      image: coin.image || null,
      launchedHere: false,
      practice: isPracticeMint(coin.mint),
      eventCount: (coin.events || []).length,
      updatedAt: coin.updatedAt || coin.addedAt || null,
    });
  }
  const onchain = [...byMint.values()];
  const launchedNames = new Set(onchain.map((coin) => `${lower(coin.symbol)}:${lower(coin.name)}`));
  const drafts = [];
  for (const entry of launches) {
    const token = entry?.config?.token || {};
    const reserved = String(entry?.config?.vanity?.selectedPublicKey || '').trim() || null;
    if (reserved && byMint.has(reserved)) continue;
    if (launchedNames.has(`${lower(token.symbol)}:${lower(token.name)}`)) continue;
    drafts.push({
      key: `draft:${entry.id}`,
      kind: 'draft',
      draftId: entry.id,
      mint: null,
      reservedAddress: reserved,
      name: token.name || entry.name || null,
      symbol: token.symbol || null,
      logoDataUrl: typeof token.logo?.dataUrl === 'string' ? token.logo.dataUrl : null,
      image: typeof token.logo?.dataUrl === 'string' ? token.logo.dataUrl : null,
      status: reserved ? 'Address reserved' : 'Draft',
      updatedAt: entry.updatedAt || entry.createdAt || null,
    });
  }
  return [...onchain, ...drafts]
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function validMint(value) {
  try {
    return new PublicKey(String(value || '').trim()).toBase58();
  } catch {
    return null;
  }
}

/**
 * On-chain identity of a mint: supply, decimals, token program, and
 * authorities, read from the mint account. Null when it is not a mint.
 */
export async function readMintAccount(connection, mint, commitment = 'confirmed') {
  const info = await connection.getParsedAccountInfo(new PublicKey(mint), commitment);
  const parsed = info?.value?.data?.parsed;
  if (!parsed || parsed.type !== 'mint') return null;
  const account = parsed.info || {};
  const extensions = Array.isArray(account.extensions) ? account.extensions : [];
  const metadata = extensions.find((ext) => ext.extension === 'tokenMetadata')?.state || null;
  return {
    program: info.value.owner.toBase58(),
    supply: account.supply,
    decimals: account.decimals,
    mintAuthority: account.mintAuthority || null,
    freezeAuthority: account.freezeAuthority || null,
    metadata: metadata
      ? { name: metadata.name || null, symbol: metadata.symbol || null, uri: metadata.uri || null, updateAuthority: metadata.updateAuthority || null }
      : null,
  };
}

// Fee inventory: one normalized row per claimable position, shared by the
// dashboard and the crank loop. Pure — chain reads are injected.

export const CLAIM_VENUES = Object.freeze(['raydium-clmm', 'meteora-damm-v2', 'meteora-dlmm']);
export const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Validate and normalize one inventory entry. Throws with a read-able message
 * so a malformed journal record is a visible bug, not a silent gap in the
 * fee surface.
 *
 * entry: {
 *   venue: 'raydium-clmm' | 'meteora-damm-v2' | 'meteora-dlmm',
 *   poolId, positionId, positionNftMint, feeKeyMint, owner, locked
 * }
 */
export function normalizeInventoryEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('Inventory entry must be an object');
  const venue = String(entry.venue || '').trim();
  if (!CLAIM_VENUES.includes(venue)) throw new Error(`Inventory entry venue must be one of: ${CLAIM_VENUES.join(', ')}`);
  const address = (name, value, required = true) => {
    const v = String(value || '').trim();
    if (!v) {
      if (required) throw new Error(`Inventory entry ${name} is required`);
      return null;
    }
    if (!BASE58_ADDRESS.test(v)) throw new Error(`Inventory entry ${name} is not a Solana address`);
    return v;
  };
  return {
    venue,
    poolId: address('poolId', entry.poolId),
    positionId: address('positionId', entry.positionId),
    positionNftMint: address('positionNftMint', entry.positionNftMint, false) || null,
    feeKeyMint: address('feeKeyMint', entry.feeKeyMint, false) || null,
    owner: address('owner', entry.owner, false) || null,
    locked: entry.locked !== false,
  };
}

/**
 * Build an inventory plan from raw candidate entries, each already carrying
 * an optional unclaimed estimate. Deduplicates by (venue, positionId), ranks
 * by unclaimedUsd descending, and caps the working set so a crank or a
 * dashboard render never iterates an unbounded list.
 *
 * raw: [{ ...entry fields, unclaimedUsd?, inRange? }]
 * Returns { rows: [...normalized], totalUnclaimedUsd, count }.
 */
export function buildInventoryPlan(raw, { cap = 500 } = {}) {
  const entries = Array.isArray(raw) ? raw.map((entry) => {
    const normalized = normalizeInventoryEntry(entry);
    const unclaimedUsd = Number(entry.unclaimedUsd);
    normalized.unclaimedUsd = Number.isFinite(unclaimedUsd) && unclaimedUsd > 0 ? unclaimedUsd : 0;
    return normalized;
  }) : [];
  const seen = new Map();
  for (const entry of entries) {
    const key = `${entry.venue}:${entry.positionId}`;
    if (!seen.has(key)) seen.set(key, entry);
  }
  let rows = [...seen.values()].sort((a, b) => (Number(b.unclaimedUsd) || 0) - (Number(a.unclaimedUsd) || 0));
  if (rows.length > cap) rows = rows.slice(0, cap);
  const totalUnclaimedUsd = rows.reduce((sum, row) => sum + (Number(row.unclaimedUsd) || 0), 0);
  return { rows, totalUnclaimedUsd, count: rows.length };
}
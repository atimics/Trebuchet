// NFT collections: normalization, review, metadata JSON, odds and cost model.
//
// Pure functions shared by the local API and tests. Chain work lives in
// nftService.js; persistence in nftCollectionStore.js.
//
// Trebuchet mints Metaplex Core assets. Each asset (and the collection) is a
// new keypair, so its address can be ground like a token CA. Keys come from
// split-key grinding (split-key.js): the grinder never holds a secret.

import { expectedVanityAttempts, invalidBase58Characters } from './validators.js';

export const NFT_STANDARD_CORE = 'core';
export const NFT_NAME_MAX = 32;
export const NFT_SYMBOL_MAX = 10;
export const NFT_DESCRIPTION_MAX = 1000;
export const NFT_MAX_ITEMS = 10000;
export const NFT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const NFT_ROYALTY_WARN_BPS = 1000;
export const NFT_MAX_CREATORS = 5;

// Measured on a local validator running the mainnet Core program
// (CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d): payer balance change per
// create, including the Core protocol fee and one base signature fee. Asset
// size grows slightly with the name and URI; the buffer covers it.
export const CORE_COLLECTION_CREATE_LAMPORTS = 1_951_840;
export const CORE_ASSET_CREATE_LAMPORTS = 3_173_440;
// Priority fee per create at the fee floor (60k CU x 50k microlamports).
export const NFT_PRIORITY_FEE_LAMPORTS = 3_000;
export const NFT_BUFFER_PCT = 0.2;
export const LAMPORTS_PER_SOL = 1_000_000_000;

// Default local grind rate when nothing has been measured yet (14 Mac cores,
// split-key walk mode). Replaced by the rate the grinder reports.
export const DEFAULT_GRIND_KEYS_PER_SEC = 28_000_000;

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function isSolanaAddress(value) {
  return BASE58_RE.test(String(value || ''));
}

export function normalizeVanityPattern(input = {}) {
  const mode = input.mode === 'prefix' ? 'prefix' : input.mode === 'suffix' ? 'suffix' : 'none';
  const pattern = String(input.pattern ?? '').trim();
  if (mode === 'none' || !pattern) return { mode: 'none', pattern: '', caseInsensitive: false };
  const invalid = invalidBase58Characters(pattern);
  if (invalid.length) {
    throw new Error(`Pattern has characters Solana addresses never use: ${invalid.join(', ')}`);
  }
  if (pattern.length > 8) throw new Error('Pattern can be at most 8 characters');
  return { mode, pattern, caseInsensitive: input.caseInsensitive === true };
}

export function vanityPatternAttempts(vanity) {
  if (!vanity || vanity.mode === 'none') return 1;
  return vanity.mode === 'prefix'
    ? expectedVanityAttempts(vanity.pattern, '', { caseInsensitive: vanity.caseInsensitive })
    : expectedVanityAttempts('', vanity.pattern, { caseInsensitive: vanity.caseInsensitive });
}

export function addressMatchesVanity(address, vanity) {
  if (!vanity || vanity.mode === 'none') return true;
  const a = vanity.caseInsensitive ? String(address).toLowerCase() : String(address);
  const p = vanity.caseInsensitive ? vanity.pattern.toLowerCase() : vanity.pattern;
  return vanity.mode === 'prefix' ? a.startsWith(p) : a.endsWith(p);
}

/** Odds for the pattern and each shorter tail/head of it, for a table. */
export function vanityOddsTable({ mode = 'suffix', pattern = '', caseInsensitive = true, itemCount = 1, keysPerSec = DEFAULT_GRIND_KEYS_PER_SEC } = {}) {
  const clean = normalizeVanityPattern({ mode, pattern, caseInsensitive });
  if (clean.mode === 'none') return [];
  const rows = [];
  for (let len = Math.min(clean.pattern.length, 8); len >= 1; len--) {
    const part = clean.mode === 'suffix' ? clean.pattern.slice(-len) : clean.pattern.slice(0, len);
    const attempts = vanityPatternAttempts({ ...clean, pattern: part });
    rows.push({
      pattern: part,
      attempts,
      secondsEach: Number.isFinite(attempts) ? attempts / keysPerSec : Infinity,
      secondsAll: Number.isFinite(attempts) ? (attempts * Math.max(1, itemCount)) / keysPerSec : Infinity,
    });
  }
  return rows.reverse();
}

export function normalizeCreators(list, fallbackAddress = null) {
  const rows = (Array.isArray(list) ? list : [])
    .map((row) => ({ address: String(row?.address || '').trim(), percentage: Math.round(Number(row?.percentage)) }))
    .filter((row) => row.address);
  if (!rows.length && fallbackAddress) return [{ address: fallbackAddress, percentage: 100 }];
  return rows;
}

export function normalizeCollectionConfig(input = {}) {
  return {
    name: cleanText(input.name, NFT_NAME_MAX),
    symbol: cleanText(input.symbol, NFT_SYMBOL_MAX).toUpperCase(),
    description: cleanText(input.description, NFT_DESCRIPTION_MAX),
    externalUrl: cleanText(input.externalUrl, 200),
    royaltyBps: Math.max(0, Math.min(10000, Math.round(Number(input.royaltyBps ?? 500)) || 0)),
    creators: normalizeCreators(input.creators),
    standard: NFT_STANDARD_CORE,
    collectionVanity: normalizeVanityPattern(input.collectionVanity || {}),
    itemVanity: normalizeVanityPattern(input.itemVanity || {}),
  };
}

/** Blocking problems and warnings for a collection config. */
export function collectionConfigIssues(config) {
  const issues = [];
  const add = (level, code, detail) => issues.push({ level, code, detail });
  if (!config.name) add('error', 'name', 'Collection name is required.');
  if (!config.symbol) add('error', 'symbol', 'Symbol is required.');
  if (config.royaltyBps > NFT_ROYALTY_WARN_BPS) add('warn', 'royalty', `Royalties of ${(config.royaltyBps / 100).toFixed(2)}% are above the usual 10%.`);
  if (config.creators.length > NFT_MAX_CREATORS) add('error', 'creators', `At most ${NFT_MAX_CREATORS} creators.`);
  if (config.creators.some((c) => !isSolanaAddress(c.address))) add('error', 'creators', 'Every creator needs a valid Solana address.');
  const total = config.creators.reduce((sum, c) => sum + (Number.isFinite(c.percentage) ? c.percentage : 0), 0);
  if (config.creators.length && total !== 100) add('error', 'creators', `Creator shares total ${total}, not 100.`);
  if (config.creators.some((c) => !(c.percentage >= 0 && c.percentage <= 100))) add('error', 'creators', 'Creator shares must be 0 to 100.');
  return issues;
}

function normalizeAttributes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((a) => ({ trait_type: cleanText(a?.trait_type, 64), value: typeof a?.value === 'number' ? a.value : cleanText(a?.value, 128) }))
    .filter((a) => a.trait_type);
}

/**
 * Items from a Sugar-style assets folder: `N.png` + `N.json` pairs. The
 * client sends each item's parsed JSON and image facts; images upload
 * separately.
 */
export function normalizeItems(list) {
  if (!Array.isArray(list)) throw new Error('items must be a list');
  if (list.length > NFT_MAX_ITEMS) throw new Error(`At most ${NFT_MAX_ITEMS} items per collection`);
  return list.map((raw, i) => ({
    index: Number.isInteger(raw?.index) ? raw.index : i,
    name: cleanText(raw?.name, NFT_NAME_MAX),
    description: cleanText(raw?.description, NFT_DESCRIPTION_MAX),
    attributes: normalizeAttributes(raw?.attributes),
    imageName: cleanText(raw?.imageName, 200),
    imageType: IMAGE_EXT_RE.test(raw?.imageName || '') ? String(raw.imageName).split('.').pop().toLowerCase().replace('jpg', 'jpeg') : null,
    imageBytes: Number.isFinite(Number(raw?.imageBytes)) ? Number(raw.imageBytes) : null,
    imageWidth: Number.isFinite(Number(raw?.imageWidth)) ? Number(raw.imageWidth) : null,
    imageHeight: Number.isFinite(Number(raw?.imageHeight)) ? Number(raw.imageHeight) : null,
    imageSha256: /^[0-9a-f]{64}$/.test(String(raw?.imageSha256 || '')) ? raw.imageSha256 : null,
    accepted: raw?.accepted === true,
  })).sort((a, b) => a.index - b.index);
}

/** Items that need a decision before upload. Accepted items are skipped. */
export function itemReviewIssues(items) {
  const issues = [];
  const traitTypes = new Map();
  for (const item of items) for (const a of item.attributes) traitTypes.set(a.trait_type, (traitTypes.get(a.trait_type) || 0) + 1);
  const common = [...traitTypes].filter(([, n]) => n >= items.length / 2).map(([t]) => t);
  const names = new Map();
  const hashes = new Map();
  for (const item of items) {
    names.set(item.name, [...(names.get(item.name) || []), item.index]);
    if (item.imageSha256) hashes.set(item.imageSha256, [...(hashes.get(item.imageSha256) || []), item.index]);
  }
  const indexes = new Set();
  items.forEach((item, pos) => {
    if (item.index !== pos) indexes.add(item.index);
  });
  for (const item of items) {
    const add = (level, code, detail) => issues.push({ index: item.index, level, code, detail });
    if (!item.name) add('error', 'name', 'Missing name.');
    if (!item.imageName) add('error', 'image', 'No image file.');
    else if (!item.imageType) add('error', 'image', `Unsupported image type: ${item.imageName}`);
    if (item.imageBytes > NFT_MAX_IMAGE_BYTES) add('error', 'image', `Image is ${(item.imageBytes / 1048576).toFixed(1)} MB; limit is 25 MB.`);
    if (item.accepted) continue;
    const missing = common.filter((t) => !item.attributes.some((a) => a.trait_type === t));
    if (missing.length) add('warn', 'traits', `Missing trait${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
    if (item.name && names.get(item.name).length > 1) add('warn', 'duplicate-name', `Same name as #${names.get(item.name).filter((i) => i !== item.index).join(', #')}`);
    if (item.imageSha256 && hashes.get(item.imageSha256).length > 1) add('warn', 'duplicate-image', `Same image as #${hashes.get(item.imageSha256).filter((i) => i !== item.index).join(', #')}`);
    if (item.imageWidth && item.imageHeight && Math.max(item.imageWidth, item.imageHeight) > 4096) add('warn', 'image-size', `${item.imageWidth}×${item.imageHeight} is large; marketplaces may not show it.`);
  }
  if (indexes.size) issues.push({ index: null, level: 'error', code: 'numbering', detail: 'Items must be numbered 0 to N-1 with no gaps.' });
  return issues;
}

export function traitDistribution(items) {
  const byType = new Map();
  for (const item of items) {
    for (const a of item.attributes) {
      if (!byType.has(a.trait_type)) byType.set(a.trait_type, new Map());
      const values = byType.get(a.trait_type);
      values.set(String(a.value), (values.get(String(a.value)) || 0) + 1);
    }
  }
  return [...byType].map(([traitType, values]) => ({
    traitType,
    values: [...values].map(([value, count]) => ({ value, count, share: items.length ? count / items.length : 0 }))
      .sort((a, b) => b.count - a.count),
  }));
}

/** Metaplex JSON standard for one asset (or the collection). */
export function nftMetadataJson({ name, symbol, description, imageUri, imageType, attributes = [], externalUrl = '', royaltyBps = 0, creators = [] }) {
  const mime = imageType ? `image/${imageType === 'jpg' ? 'jpeg' : imageType}` : 'image/png';
  return {
    name,
    symbol,
    description,
    image: imageUri,
    ...(externalUrl ? { external_url: externalUrl } : {}),
    attributes,
    seller_fee_basis_points: royaltyBps,
    properties: {
      files: [{ uri: imageUri, type: mime }],
      category: 'image',
      creators: creators.map((c) => ({ address: c.address, share: c.percentage })),
    },
  };
}

/** Cost model in SOL. storageLamports comes from an Irys price quote when known. */
export function nftCostModel({
  itemCount = 0,
  collectionCreated = false,
  mintedCount = 0,
  storageLamports = null,
  priorityLamportsEach = NFT_PRIORITY_FEE_LAMPORTS,
} = {}) {
  const remaining = Math.max(0, itemCount - mintedCount);
  const collection = collectionCreated ? 0 : CORE_COLLECTION_CREATE_LAMPORTS;
  const assets = remaining * CORE_ASSET_CREATE_LAMPORTS;
  const priority = (remaining + (collectionCreated ? 0 : 1)) * priorityLamportsEach;
  const storage = Number.isFinite(storageLamports) ? storageLamports : 0;
  const subtotal = collection + assets + priority + storage;
  const buffer = Math.ceil(subtotal * NFT_BUFFER_PCT);
  const toSol = (l) => l / LAMPORTS_PER_SOL;
  return {
    remainingItems: remaining,
    collectionSol: toSol(collection),
    assetsSol: toSol(assets),
    perAssetSol: toSol(CORE_ASSET_CREATE_LAMPORTS),
    priorityFeesSol: toSol(priority),
    storageSol: Number.isFinite(storageLamports) ? toSol(storage) : null,
    subtotalSol: toSol(subtotal),
    bufferSol: toSol(buffer),
    totalSol: toSol(subtotal + buffer),
    totalLamports: subtotal + buffer,
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCollectionConfig,
  collectionConfigIssues,
  normalizeVanityPattern,
  vanityPatternAttempts,
  addressMatchesVanity,
  vanityOddsTable,
  normalizeItems,
  itemReviewIssues,
  traitDistribution,
  nftMetadataJson,
  nftCostModel,
  CORE_ASSET_CREATE_LAMPORTS,
  CORE_COLLECTION_CREATE_LAMPORTS,
} from '../packages/core/src/nft-plan.js';

const WALLET = '7xKpR2mVq8sYbJcD5aE1gUzQ4hNq7TwYcB2pXk9vW3aF';

test('collection config is trimmed, capped and checked', () => {
  const config = normalizeCollectionConfig({
    name: '  Genesis   Series  ',
    symbol: 'gen',
    royaltyBps: 1500,
    creators: [{ address: WALLET, percentage: 90 }, { address: 'not-an-address', percentage: 5 }],
  });
  assert.equal(config.name, 'Genesis Series');
  assert.equal(config.symbol, 'GEN');
  assert.equal(config.standard, 'core');
  const codes = collectionConfigIssues(config).map((i) => `${i.level}:${i.code}`);
  assert.ok(codes.includes('warn:royalty'));
  assert.ok(codes.includes('error:creators'));
  assert.deepEqual(collectionConfigIssues(normalizeCollectionConfig({ name: 'A', symbol: 'A', creators: [{ address: WALLET, percentage: 100 }] })), []);
});

test('vanity patterns reject characters base58 never uses', () => {
  assert.throws(() => normalizeVanityPattern({ mode: 'suffix', pattern: 'zer0' }), /never use: 0/);
  assert.throws(() => normalizeVanityPattern({ mode: 'suffix', pattern: 'abcdefghj' }), /at most 8/);
  assert.deepEqual(normalizeVanityPattern({ mode: 'suffix', pattern: '' }), { mode: 'none', pattern: '', caseInsensitive: false });
});

test('odds match the grinder model: zerebro any case is 3.45e10', () => {
  const v = normalizeVanityPattern({ mode: 'suffix', pattern: 'zerebro', caseInsensitive: true });
  assert.ok(Math.abs(vanityPatternAttempts(v) / 3.45e10 - 1) < 0.01);
  const rows = vanityOddsTable({ mode: 'suffix', pattern: 'zerebro', caseInsensitive: true, itemCount: 1000, keysPerSec: 28.6e6 });
  assert.deepEqual(rows.map((r) => r.pattern), ['o', 'ro', 'bro', 'ebro', 'rebro', 'erebro', 'zerebro']);
  const zbro = vanityOddsTable({ mode: 'suffix', pattern: 'zbro', caseInsensitive: true, itemCount: 1000, keysPerSec: 28.6e6 }).at(-1);
  assert.ok(zbro.secondsAll > 40 && zbro.secondsAll < 60, `zbro x1000 ~50 s, got ${zbro.secondsAll}`);
});

test('address matching honors mode and case', () => {
  const v = { mode: 'suffix', pattern: 'zbro', caseInsensitive: true };
  assert.equal(addressMatchesVanity('9aTekQZbRo', v), true);
  assert.equal(addressMatchesVanity('9aTekQZbRo', { ...v, caseInsensitive: false }), false);
  assert.equal(addressMatchesVanity('zbro123', { mode: 'prefix', pattern: 'zbro', caseInsensitive: false }), true);
  assert.equal(addressMatchesVanity('anything', { mode: 'none' }), true);
});

test('item review flags missing traits, duplicates and bad numbering', () => {
  const items = normalizeItems([
    { index: 0, name: 'G #0', imageName: '0.png', imageSha256: 'a'.repeat(64), attributes: [{ trait_type: 'Eyes', value: 'Laser' }, { trait_type: 'Mouth', value: 'Grin' }] },
    { index: 1, name: 'G #1', imageName: '1.png', imageSha256: 'b'.repeat(64), attributes: [{ trait_type: 'Eyes', value: 'Plain' }, { trait_type: 'Mouth', value: 'Flat' }] },
    { index: 2, name: 'G #1', imageName: '2.png', imageSha256: 'a'.repeat(64), attributes: [{ trait_type: 'Eyes', value: 'Plain' }] },
  ]);
  const byIndex = (i) => itemReviewIssues(items).filter((x) => x.index === i).map((x) => x.code).sort();
  assert.deepEqual(byIndex(0), ['duplicate-image']);
  assert.deepEqual(byIndex(2), ['duplicate-image', 'duplicate-name', 'traits']);
  items[2].accepted = true;
  assert.deepEqual(itemReviewIssues(items).filter((x) => x.index === 2), []);
  const gap = normalizeItems([{ index: 0, name: 'a', imageName: '0.png' }, { index: 2, name: 'b', imageName: '2.png' }]);
  assert.ok(itemReviewIssues(gap).some((x) => x.code === 'numbering'));
  assert.ok(itemReviewIssues(normalizeItems([{ index: 0, name: 'a', imageName: '0.bmp' }])).some((x) => x.code === 'image'));
});

test('trait distribution counts values per trait type', () => {
  const items = normalizeItems([
    { index: 0, name: 'a', attributes: [{ trait_type: 'Eyes', value: 'Laser' }] },
    { index: 1, name: 'b', attributes: [{ trait_type: 'Eyes', value: 'Plain' }] },
    { index: 2, name: 'c', attributes: [{ trait_type: 'Eyes', value: 'Plain' }] },
  ]);
  const [eyes] = traitDistribution(items);
  assert.equal(eyes.traitType, 'Eyes');
  assert.deepEqual(eyes.values.map((v) => [v.value, v.count]), [['Plain', 2], ['Laser', 1]]);
});

test('metadata JSON follows the Metaplex standard', () => {
  const json = nftMetadataJson({
    name: 'G #1', symbol: 'GEN', description: 'd', imageUri: 'https://arweave.net/x', imageType: 'jpeg',
    attributes: [{ trait_type: 'Eyes', value: 'Laser' }], royaltyBps: 500, creators: [{ address: WALLET, percentage: 100 }],
  });
  assert.equal(json.image, 'https://arweave.net/x');
  assert.deepEqual(json.properties.files, [{ uri: 'https://arweave.net/x', type: 'image/jpeg' }]);
  assert.deepEqual(json.properties.creators, [{ address: WALLET, share: 100 }]);
  assert.equal(json.seller_fee_basis_points, 500);
});

test('cost model uses measured Core costs and only counts unfinished work', () => {
  const full = nftCostModel({ itemCount: 1000, storageLamports: 29_000_000, priorityLamportsEach: 3000 });
  const expected = CORE_COLLECTION_CREATE_LAMPORTS + 1000 * CORE_ASSET_CREATE_LAMPORTS + 1001 * 3000 + 29_000_000;
  assert.equal(full.subtotalSol, expected / 1e9);
  assert.equal(full.totalLamports, expected + Math.ceil(expected * 0.2));
  const resumed = nftCostModel({ itemCount: 1000, collectionCreated: true, mintedCount: 412, storageLamports: 0, priorityLamportsEach: 3000 });
  assert.equal(resumed.remainingItems, 588);
  assert.equal(resumed.collectionSol, 0);
});

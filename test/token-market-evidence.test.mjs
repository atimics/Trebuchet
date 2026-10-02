import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PoolInfoLayout, LockClPositionLayoutV2 } from '@raydium-io/raydium-sdk-v2';
import { clmmLockPrograms } from '../clmmLockEvidence.js';
import { readHolderSample, readPoolEvidence, readTokenMarketEvidence, tokenAmountRaw, fetchSellQuote, marketEvidenceError, SOL_MINT } from '../tokenMarketEvidence.js';

const MINT = 'RUGx1zSD7LCVqFgTYQWNiJKSkDcfN3yRR5XoFoAXRUG';
const POOL = '2SV3NWgJes9mHkWdBeuHFg8kNqfJS1XQKtNb1eJStVDC';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/rugoween-locks.json', import.meta.url)));
const publicInfo = (row) => ({ ...row, data: Buffer.from(row.data[0], 'base64'), owner: new PublicKey(row.owner) });
const address = () => Keypair.generate().publicKey;

test('downloaded RPC errors keep credentials private and rate limits readable', () => {
  assert.match(marketEvidenceError(new Error('429 Too Many Requests')), /Try again later/);
  const message = marketEvidenceError(new Error('Failed https://rpc.example/private-key?api-key=secret Authorization: Bearer abc123'));
  assert.doesNotMatch(message, /private-key|secret|abc123/);
});
function tokenInfo(mint, owner, amount, program = TOKEN_2022_PROGRAM_ID) {
  const data = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(data, 0);
  new PublicKey(owner).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(BigInt(amount), 64);
  data[108] = 1;
  return { data, owner: program, executable: false };
}
function poolFixture() {
  const vaultA = address(); const vaultB = address();
  const pool = { data: Buffer.alloc(PoolInfoLayout.span), owner: clmmLockPrograms().poolProgramId };
  for (const [key, value] of Object.entries({ mintA: MINT, mintB: SOL_MINT, vaultA, vaultB })) {
    new PublicKey(value).toBuffer().copy(pool.data, PoolInfoLayout.offsetOf(key));
  }
  pool.data[PoolInfoLayout.offsetOf('mintDecimalsA')] = 9;
  pool.data[PoolInfoLayout.offsetOf('mintDecimalsB')] = 9;
  const records = new Map([
    [POOL, pool],
    [vaultA.toBase58(), tokenInfo(MINT, POOL, '300613944435831000')],
    [vaultB.toBase58(), tokenInfo(SOL_MINT, POOL, '427512764', TOKEN_PROGRAM_ID)],
  ]);
  return { pool, vaultA, vaultB, records };
}

test('holder sample separates verified vaults, wallets and unresolved accounts', async () => {
  const { pool, vaultA, records } = poolFixture();
  const wallet = address(); const walletAta = address(); const unknownAta = address();
  records.set(walletAta.toBase58(), tokenInfo(MINT, wallet, '1000000000'));
  records.set(wallet.toBase58(), { owner: SystemProgram.programId, data: Buffer.alloc(0), executable: false });
  records.set(unknownAta.toBase58(), tokenInfo(MINT, POOL, '2000000000'));
  const connection = {
    getTokenLargestAccounts: async () => ({ context: { slot: 10 }, value: [
      { address: vaultA, amount: '300613944435831000' },
      { address: walletAta, amount: '1000000000' },
      { address: unknownAta, amount: '2000000000' },
    ] }),
    getMultipleAccountsInfo: async (keys) => keys.map((key) => records.get(key.toBase58()) || null),
  };
  const result = await readHolderSample(connection, MINT, '1000000000000000000');
  assert.equal(result.accounts[0].kind, 'raydium-clmm-vault');
  assert.equal(result.accounts[1].kind, 'wallet');
  assert.equal(result.accounts[2].kind, 'other-or-unverified', 'a pool owner alone is insufficient: the account must be its vault');
  assert.equal(result.poolSupplyPercent, 30.06);
  assert.equal(result.wallets[0].owner, wallet.toBase58());
  pool.owner = SystemProgram.programId;
  assert.equal((await readHolderSample(connection, MINT, '1000000000000000000')).poolSupplyPercent, 0);
});

test('pool proof preserves the small quote reserve and reads the current transferred Fee Key owner', async () => {
  const { records } = poolFixture();
  const lockEntry = fixture.locks[0];
  const lock = LockClPositionLayoutV2.decode(Buffer.from(lockEntry.account.data[0], 'base64'));
  const feeOwner = address(); const feeAta = address();
  records.set(lock.positionId.toBase58(), publicInfo(fixture.positions[0]));
  records.set(feeAta.toBase58(), tokenInfo(lock.lockNftMint, feeOwner, '1', TOKEN_PROGRAM_ID));
  const connection = {
    getAccountInfo: async (key) => records.get(key.toBase58()) || null,
    getMultipleAccountsInfo: async (keys) => keys.map((key) => records.get(key.toBase58()) || null),
    getProgramAccounts: async () => [{ pubkey: new PublicKey(lockEntry.pubkey), account: publicInfo(lockEntry.account) }],
    getTokenLargestAccounts: async () => ({ context: { slot: 11 }, value: [{ address: feeAta, amount: '1', decimals: 0 }] }),
  };
  const result = await readPoolEvidence(connection, POOL, MINT);
  assert.equal(result.quote.amount, '427512764');
  assert.equal(result.quote.mint, SOL_MINT);
  assert.equal(result.locks.length, 1);
  assert.equal(result.locks[0].feeOwner.address, feeOwner.toBase58());
  assert.notEqual(result.locks[0].feeOwner.address, lock.lockOwner.toBase58());
  records.set(feeAta.toBase58(), tokenInfo(lock.lockNftMint, feeOwner, '0', TOKEN_PROGRAM_ID));
  const moved = await readPoolEvidence(connection, POOL, MINT);
  assert.equal(moved.locks[0].feeOwner, null);
  assert.match(moved.locks[0].feeOwnerError, /moved/);
});

test('failed lock scans preserve reserves and explicit partial coverage', async () => {
  const { records } = poolFixture();
  const connection = {
    getAccountInfo: async (key) => records.get(key.toBase58()) || null,
    getMultipleAccountsInfo: async (keys) => keys.map((key) => records.get(key.toBase58()) || null),
    getProgramAccounts: async () => { throw new Error('RPC timeout'); },
    getTokenLargestAccounts: async () => { throw new Error('Holder lookup failed'); },
  };
  const result = await readTokenMarketEvidence(connection, MINT, { supply: '1000000000', pools: [{ poolId: POOL }] });
  assert.equal(result.pools[0].quote.amount, '427512764');
  assert.equal(result.pools[0].lockStatus, 'unavailable');
  assert.equal(result.holderSample, null);
  assert.match(result.holderError, /Holder lookup/);
});

test('sell amount conversion preserves raw precision and bounds', () => {
  assert.equal(tokenAmountRaw('1000000.000000001', 9), '1000000000000001');
  for (const [value, decimals] of [['-1', 9], ['0', 9], ['1e9', 9], ['0.0001', 3], ['18446744073709551616', 0]]) {
    assert.throws(() => tokenAmountRaw(value, decimals));
  }
});

test('sell quotes validate the mint, exact amount, route and slippage threshold', async () => {
  const data = { inputMint: MINT, outputMint: SOL_MINT, inputAmount: '1000000000000', outputAmount: '4275127', otherAmountThreshold: '4232375', swapType: 'BaseIn', slippageBps: 100, routePlan: [{}] };
  const requests = [];
  const fetchImpl = async (url, options) => { requests.push({ url: String(url), options }); return { ok: true, json: async () => ({ success: true, data }) }; };
  const result = await fetchSellQuote({ mint: MINT, amount: '1000', decimals: 9, fetchImpl });
  assert.equal(result.outputLamports, '4275127');
  assert.match(requests[0].url, /compute\/swap-base-in/);
  assert.equal(requests[0].options.method, undefined);
  for (const [key, value] of [['inputMint', SOL_MINT], ['inputAmount', '100'], ['outputMint', MINT], ['otherAmountThreshold', '1'], ['outputAmount', 'Infinity'], ['routePlan', []]]) {
    const original = data[key]; data[key] = value;
    await assert.rejects(fetchSellQuote({ mint: MINT, amount: '1000', decimals: 9, fetchImpl }));
    data[key] = original;
  }
});

test('market evidence HTML escapes external content and keeps small reserves visible', () => {
  const context = { window: {} }; vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL('../public/v2/market-evidence.js', import.meta.url), 'utf8'), context);
  const ui = context.window.TrebuchetMarketEvidence;
  assert.equal(ui.units('427512764', 9), '0.427512764');
  assert.equal(ui.units('10000000000', 9), '10');
  const html = ui.render({ inspectedAt: '2026-09-28', network: 'mainnet', holderError: '<img onerror=alert(1)>', feeRights: 'Fees belong to Fee Key holders.', pools: [{ poolId: POOL, error: '<script>bad</script>' }], poolCoverage: { requested: 1, inspected: 1 } });
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script>'));
  assert.match(html, /Fee Key holders/);
});

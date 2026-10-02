import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const coins = fs.readFileSync(new URL('../public/v2/features/discovery/coins.js', import.meta.url), 'utf8');
const funding = fs.readFileSync(new URL('../public/v2/features/launch/funding-view.js', import.meta.url), 'utf8');
const amounts = funding.slice(funding.indexOf('function parseRawTokenAmount'), funding.indexOf('function manualPrefundBalanceSnapshotStatus'));
const draft = { jobId: 'withdrawal-one', nftMint: 'position-nft', poolId: 'pool-address', walletPublicKey: 'saved-wallet', network: 'localnet',
  planDigest: 'saved-digest', status: 'review_required', maxSpendLamports: 4178560, feeCeilingLamports: 100000, rentCeilingLamports: 4078560,
  tokens: [{ mint: 'mint', decimals: 19, minimumRaw: '1234567890123456789', native: false, destination: 'wallet-ata' },
    { mint: 'native-mint', decimals: 9, minimumRaw: '12000000', native: true, destination: 'temporary-sol' }] };
function harness({ confirm = true, saved = false, positionsFail = false } = {}) {
  const calls = [], dialogs = [], notices = [];
  const job = { ...draft, status: saved ? 'paused' : 'review_required' };
  const state = { coins: { key: 'mint:mint' }, coinPositions: { mint: 'mint', list: saved ? [] : [{ nftMint: draft.nftMint, poolId: draft.poolId, owner: draft.walletPublicKey, liquidity: '1000' }],
    withdrawals: saved ? [job] : [], withdrawing: null }, apiClient: {
    preparePositionWithdrawal: async (input) => { calls.push({ action: 'prepare', input }); return { job }; },
    withdrawPosition: async (input) => { calls.push({ action: 'execute', input }); return { result: { status: 'confirmed' } }; },
    listCoinPositions: async () => { if (positionsFail) throw new Error('RPC needs recovery'); return { positions: [] }; },
    listPositionWithdrawals: async () => ({ withdrawals: [job] }),
  } };
  const context = vm.createContext({ state, Promise, BigInt, Number, confirmOperatorAction: async (input) => { calls.push({ action: 'review' }); dialogs.push(input); return confirm; },
    fullAddress: (value) => value, notify: (value) => notices.push(value), renderCoins: () => {}, loadCoinDetail: async () => {}, escapeHtml: (value) => value });
  vm.runInContext(amounts + coins.slice(coins.indexOf('async function loadCoinPositions'), coins.indexOf("// A position's range")), context);
  return { context, state, calls, dialogs, notices };
}

test('withdrawal saves the plan before showing minima, costs, and exact approval', async () => {
  const h = harness(); await h.context.withdrawCoinPosition(draft.nftMint);
  assert.deepEqual(h.calls.map((item) => item.action), ['prepare', 'review', 'execute']);
  for (const value of ['localnet', 'saved-wallet', 'position-nft', 'pool-address', '0.1234567890123456789', '0.012 SOL', '0.0001 SOL', '0.00407856 SOL', '0.00417856 SOL']) assert.ok(h.dialogs[0].detail.includes(value), value);
  assert.equal(h.dialogs[0].confirmationText, 'WITHDRAW');
  assert.equal(h.calls[2].input.planDigest, draft.planDigest); assert.equal(h.calls[2].input.maxSpendLamports, draft.maxSpendLamports);
});

test('cancelled withdrawal keeps its saved review and sends zero execution requests', async () => {
  const h = harness({ confirm: false }); await h.context.withdrawCoinPosition(draft.nftMint);
  assert.deepEqual(h.calls.map((item) => item.action), ['prepare', 'review']); assert.equal(h.state.coinPositions.withdrawals.length, 1);
});

test('a saved withdrawal remains recoverable after the position disappears', async () => {
  const h = harness({ saved: true }); await h.context.resumeCoinWithdrawal(draft.jobId);
  assert.deepEqual(h.calls.map((item) => item.action), ['review', 'execute']); assert.equal(h.dialogs[0].title, 'Resume saved withdrawal');
  assert.equal(h.calls[1].input.jobId, draft.jobId);
});

test('saved recovery stays visible when position RPC reads fail', async () => {
  const h = harness({ saved: true, positionsFail: true }); await h.context.loadCoinPositions('mint');
  assert.equal(h.state.coinPositions.withdrawals[0].jobId, draft.jobId); assert.match(h.state.coinPositions.error, /RPC needs recovery/);
  assert.match(h.context.coinWithdrawalHistoryHtml(), /data-action="resume-coin-withdrawal"/);
});

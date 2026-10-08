import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (name) => fs.readFileSync(new URL(`../public/v2/features/${name}`, import.meta.url), 'utf8');
const between = (source, start, end) => source.slice(source.indexOf(start), end ? source.indexOf(end) : undefined);
const coins = read('discovery/coins.js'), sweep = read('recovery/sweep.js'), events = read('shell/events.js');
const html = (value) => String(value ?? '');
const plan = { tokenMint: 'mint-a', recipients: Array.from({ length: 52 }, (_, index) => ({ wallet: `w${index}`, tokens: '10' })) };

test('the coin page counts airdrop wallets as they land, then says the sweep is next', () => {
  const state = { sweepAirdropProgress: null };
  const context = vm.createContext({ state, Math });
  vm.runInContext(between(coins, 'function coinSweepProgressText', 'function continueCoinStep'), context);
  const delivered = new Set(['w0', 'w1']);
  assert.match(context.coinSweepProgressText('wallet-a', plan, delivered), /2 of 52 wallets sent/);
  state.sweepAirdropProgress = { publicKey: 'wallet-a', status: 'running', completed: 7, failedCount: 1 };
  assert.match(context.coinSweepProgressText('wallet-a', plan, delivered), /9 of 52 wallets sent, 1 failed\. About \d+ min left/);
  state.sweepAirdropProgress = { publicKey: 'wallet-b', status: 'running', completed: 40 };
  assert.match(context.coinSweepProgressText('wallet-a', plan, delivered), /2 of 52/, 'another wallet\'s count is not shown');
  state.sweepAirdropProgress = { publicKey: 'wallet-a', status: 'done', completed: 50, failedCount: 0 };
  assert.match(context.coinSweepProgressText('wallet-a', plan, delivered), /52 of 52 wallets sent\. Now sweeping every token and SOL/);
  assert.match(context.coinSweepProgressText('wallet-a', null, delivered), /^Sweeping every token and SOL/);
});

test('the sweep reads the airdrop count until it ends and stops reading after', async () => {
  let reads = 0;
  const state = { sweepingWalletPublicKey: 'wallet-a', activeView: 'coins', apiClient: { getAirdropProgress: async () => {
    reads += 1; if (reads === 2) state.sweepingWalletPublicKey = null; return { status: 'running', completed: reads };
  } } };
  let renders = 0;
  const context = vm.createContext({ state, Promise, renderCoins: () => { renders += 1; }, setTimeout: (run) => run() });
  vm.runInContext(between(sweep, 'async function followSweepAirdropProgress'), context);
  await context.followSweepAirdropProgress('wallet-a');
  assert.equal(reads, 2); assert.equal(renders, 1);
  assert.deepEqual({ ...state.sweepAirdropProgress }, { status: 'running', completed: 1, publicKey: 'wallet-a' });
});


test('Open coin opens a live coin\'s page, and the coin list otherwise', () => {
  const handler = between(events, "  if (action === 'inspect-recovery') {", "  if (action === 'review-plan') {");
  const calls = [];
  const run = (proof) => {
    const context = vm.createContext({ state: { coins: { key: 'mint:other' } }, calls, currentLaunchProof: () => proof, proofTokenMint: (value) => value?.mint || null,
      isDemoLaunchProof: (value) => Boolean(value?.demo), openCoinByMint: (mint) => calls.push(['coin', mint]),
      setView: (view) => calls.push(['view', view]) });
    vm.runInContext(`(function (action) {\n${handler}\n})('inspect-recovery')`, context);
  };
  run({ mint: 'mint-a' }); run({ mint: 'mint-b', demo: true }); run(null);
  assert.deepEqual(calls, [['coin', 'mint-a'], ['view', 'coins'], ['view', 'coins']]);
});

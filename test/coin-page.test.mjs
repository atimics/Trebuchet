import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const coins = read('public/v2/features/discovery/coins.js');
const workspace = read('public/v2/features/launch/workspace.js');
const server = read('server.js');

function slice(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start} should be extractable`);
  return source.slice(from, to);
}

function load(overrides = {}) {
  const state = { coins: { key: 'mint:Mint111', list: [{ key: 'mint:Mint111', kind: 'onchain', mint: 'Mint111', launchedHere: true }], detail: null, detailLoading: false, detailError: null }, activeView: 'launch', selectedVanityPublicKey: null, ...overrides.state };
  const context = vm.createContext({
    state,
    shortAddress: (value) => `${value.slice(0, 4)}…`,
    formatTokenAmount: () => '1B',
    liveLaunchInProgress: () => Boolean(overrides.live),
    proofTokenMint: (proof) => proof?.token?.mint || '',
    currentLaunchProof: () => overrides.proof || null,
    currentLaunchConfig: () => ({ token: overrides.token || {} }),
  });
  vm.runInContext([
    slice(coins, 'function coinByKey(key)', '\n// A real launch that has a mint'),
    slice(coins, '// The on-chain coin the page shows', '\nasync function loadCoinPositions'),
    slice(coins, 'const CHAIN_FACT_LABELS', '\nfunction chainCoinSection'),
  ].join('\n'), context);
  return { context, state };
}

// TREBUCHET as the chain shows it: minted, four pools open, locks recorded, launch wallet swept.
const launched = {
  mint: 'Mint111',
  account: { supply: '1000000000000000000', decimals: 9, mintAuthority: null },
  markets: { pools: [{ poolId: 'a' }, { poolId: 'b' }, { poolId: 'c' }, { poolId: 'd' }] },
  creation: {
    walletPublicKey: 'JCTXdxzbxtUCE5Yr4Ucd1qXf4UBjYsHbr1ocaRPekjk9',
    steps: [
      { id: 'token', state: 'done' },
      { id: 'pools', state: 'done' },
      { id: 'locks', state: 'recorded', detail: '9/9 positions recorded as locked.' },
      { id: 'return', state: 'done' },
    ],
  },
};

test('a launched coin reads as launched on every row, never as a draft', () => {
  const { context, state } = load();
  state.coins.detail = launched;
  const facts = Object.fromEntries(JSON.parse(JSON.stringify(context.onchainCoinFacts(context.chainCoinOnPage()))).map((fact) => [fact.id, fact]));
  assert.deepEqual(facts.wallet, { id: 'wallet', state: 'done', value: 'From JCTX…' });
  assert.deepEqual(facts.mint, { id: 'mint', state: 'done', value: '1B · mint authority revoked' });
  assert.deepEqual(facts.liquidity, { id: 'liquidity', state: 'recorded', value: '4 pools open · 9/9 locked' });
  assert.deepEqual(facts.finish, { id: 'finish', state: 'done', value: 'Empty' });
  assert.ok(Object.values(facts).every((fact) => !fact.action), 'nothing is left to do');
});

test('a launch wallet that still holds funds is the row that needs doing', () => {
  const { context, state } = load();
  state.coins.detail = { ...launched, creation: { ...launched.creation, steps: launched.creation.steps.map((step) => (step.id === 'return' ? { ...step, state: 'todo' } : step)) } };
  const finish = context.onchainCoinFacts(context.chainCoinOnPage()).find((fact) => fact.id === 'finish');
  assert.equal(finish.state, 'todo');
  assert.equal(finish.action, 'Sweep the launch wallet');
});

test('a coin added by address has no launch rows to finish', () => {
  const { context, state } = load({ state: { coins: { key: 'mint:Mint111', list: [{ key: 'mint:Mint111', kind: 'onchain', mint: 'Mint111', status: 'Added' }], detail: { mint: 'Mint111', account: launched.account, markets: { pools: [] } } } } });
  const facts = Object.fromEntries(context.onchainCoinFacts(context.chainCoinOnPage()).map((fact) => [fact.id, fact.value]));
  assert.deepEqual(facts, { wallet: 'Added by address', mint: '1B · mint authority revoked', liquidity: '0 pools', finish: 'Not launched here' });
});

test('while the chain is read, every row says so', () => {
  const { context, state } = load({ state: { coins: { key: 'mint:Mint111', list: [{ key: 'mint:Mint111', kind: 'onchain', mint: 'Mint111' }], detail: null, detailLoading: true } } });
  assert.ok(context.onchainCoinFacts(context.chainCoinOnPage()).every((fact) => fact.state === 'running' && fact.value === 'Reading the chain'));
  assert.equal(state.coins.key, 'mint:Mint111');
});

test('a saved draft whose reserved address has launched opens as that coin', () => {
  const list = [{ key: 'mint:8fFf', kind: 'onchain', mint: '8fFf', launchedHere: true, name: 'TREBUCHET', symbol: 'TREBUCHET' }];
  const token = { name: 'TREBUCHET', symbol: 'TREBUCHET' };
  const draft = load({ token, state: { coins: { key: null, list }, selectedVanityPublicKey: '8fFf' } });
  assert.equal(draft.context.launchedCoinForWorkspaceDraft()?.key, 'mint:8fFf');
  // A new coin that picked that address is not that coin: it stays on its own page.
  const fresh = load({ token: { name: 'Other', symbol: 'OTH' }, state: { coins: { key: null, list }, selectedVanityPublicKey: '8fFf' } });
  assert.equal(fresh.context.launchedCoinForWorkspaceDraft(), null);
  const running = load({ live: true, token, state: { coins: { key: null, list }, selectedVanityPublicKey: '8fFf' } });
  assert.equal(running.context.launchedCoinForWorkspaceDraft(), null, 'a running launch is never swapped out');
  const unlaunched = load({ token, state: { coins: { key: null, list }, selectedVanityPublicKey: 'Other' } });
  assert.equal(unlaunched.context.launchedCoinForWorkspaceDraft(), null);
});

test('one page per coin: on-chain coins open on the steps page, and the old coin page is gone', () => {
  assert.match(coins, /function openCoin\(key\) \{[\s\S]*?setView\('launch'\);[\s\S]*?\n\}/);
  assert.doesNotMatch(coins, /function renderCoinPage|setView\('coins'\);\n  const coin = coinByKey/);
  assert.doesNotMatch(read('public/v2/index.html'), /id="coinPage"/);
  assert.match(workspace, /const facts = chainCoin \? onchainCoinFacts\(chainCoin\) : coinFacts\(\);/);
  assert.match(workspace, /renderChainCoinPane\(chainCoin, workspace\);\n  if \(chainCoin\) return;/);
});

test('a recorded lock is not an unfinished step', () => {
  assert.match(server, /nextStep: steps\.find\(\(step\) => !\['done', 'recorded'\]\.includes\(step\.state\)\)\?\.id \|\| null/);
});

test('a used address is greyed out in the grinder, never auto-picked, and dropped from a new coin', () => {
  const vanity = read('public/v2/features/launch/vanity.js');
  const list = [{ key: 'mint:8fFf', kind: 'onchain', mint: '8fFf', launchedHere: true, name: 'TREBUCHET', symbol: 'TREBUCHET', walletPublicKey: 'JCTX' }];
  const state = {
    coins: { key: null, list }, activeView: 'launch', selectedVanityPublicKey: '8fFf',
    vanityCandidates: [{ publicKey: 'free1' }, { publicKey: 'used1', usedBy: { symbol: 'RUG', walletPublicKey: 'W2' } }, { publicKey: '8fFf' }],
  };
  let wallet = 'NEW';
  let invalidated = 0;
  const context = vm.createContext({
    state, selectedLaunchWalletPublicKey: () => wallet, liveLaunchInProgress: () => false,
    proofTokenMint: () => '', currentLaunchProof: () => null, currentLaunchConfig: () => ({ token: { name: 'Fresh', symbol: 'FRSH' } }),
    invalidateClassicOutputs: () => { invalidated += 1; },
  });
  vm.runInContext([
    slice(vanity, '// A saved address a launch has already minted', '\nfunction rememberActiveLaunchId'),
    slice(coins, 'function coinByKey(key)', '\n// A real launch that has a mint'),
    slice(coins, '// The on-chain coin the page shows', '\nasync function loadCoinPositions'),
  ].join('\n'), context);
  assert.equal(context.vanityAddressUsedReason('used1'), 'Used by $RUG');
  assert.equal(context.vanityAddressUsedReason('8fFf'), 'Used by $TREBUCHET');
  assert.equal(context.vanityAddressUsedReason('free1'), null);
  assert.equal(context.vanityAddressUsedReason(''), null, 'a random address is always free');
  assert.deepEqual(context.freeVanityCandidates().map((item) => item.publicKey), ['free1']);
  wallet = 'JCTX';
  assert.equal(context.vanityAddressUsedReason('8fFf'), null, 'the launch wallet\'s own interrupted mint is still its address');
  wallet = 'NEW';
  assert.equal(context.dropUsedVanitySelection(), true);
  assert.equal(state.selectedVanityPublicKey, null);
  assert.equal(invalidated, 1);
  const guards = read('public/v2/features/shell/action-guards.js');
  assert.match(guards, /'select-vanity': \(element\) => vanityAddressUsedReason\(element\.dataset\.publicKey\)/);
  assert.match(read('public/v2/features/shell/connection.js'), /freeVanityCandidates\(\)\.at\(-1\)/);
});

test('the Send SOL button copies the launch wallet address, where the SOL goes', () => {
  assert.match(workspace, /\/\^Send \/\.test\(fundFact\.action \|\| ''\) && walletKey\s*\? `<button class="primary-button rail-act" type="button" data-action="copy-wallet-address"/);
  assert.match(read('public/v2/features/shell/events.js'), /action === 'copy-wallet-address'\) \{\n    copyText\(selectedLaunchWalletPublicKey\(\), 'Funding address'\);/);
});

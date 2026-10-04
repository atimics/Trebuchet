import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const chip = read('public/v2/features/wallet/chip.js');
const view = read('public/v2/features/wallet/view.js');
const server = read('server.js');
const html = (value) => String(value ?? '').replace(/</g, '&lt;');
const SYSTEM = '11111111111111111111111111111111';

function page(extra = {}) {
  const context = vm.createContext({
    state: { apiStatus: 'connected', coins: { list: [{ mint: 'mint-treb', symbol: 'TREB' }] }, secretPin: { locked: false },
      heldWallets: { list: null, loading: false, at: 0, error: null, sweep: null }, destinations: { signed: ['return-wallet'] }, activeView: 'wallet' },
    escapeHtml: html, shortAddress: (value) => `${value.slice(0, 4)}…`, solscanAccountUrl: (value) => `https://solscan.io/account/${value}`,
    formatTokenAmount: (raw, decimals) => String(Number(raw) / 10 ** decimals), Promise, Date, Map, Number, setTimeout, clearTimeout,
    ...extra,
  });
  vm.runInContext(chip, context);
  return context;
}

const contents = (overrides = {}) => ({ address: 'wallet-a', lamports: 660241, ownerProgram: SYSTEM, tokens: [], openAccounts: 13, accountRentLamports: 19375120, key: 'retired', ...overrides });

test('the hover card lists what the wallet holds and whether Trebuchet has its key', () => {
  const { walletCardHtml } = page();
  const card = walletCardHtml('wallet-a', contents({ tokens: [{ mint: 'mint-treb', amountRaw: '1500000000', decimals: 9 }] }), null);
  assert.match(card, /Finished launch wallet · key in Trebuchet/);
  assert.match(card, /<dt>SOL<\/dt><dd>0\.000660<\/dd>|<dt>SOL<\/dt><dd>0\.00066<\/dd>/);
  assert.match(card, /<dt>TREB<\/dt><dd>1\.5<\/dd>/);
  assert.match(card, /<dt>Open token accounts<\/dt><dd>13 · 0\.019375 SOL rent<\/dd>/);
  assert.match(walletCardHtml('someone', contents({ key: null, openAccounts: 0 }), null), /Key not in Trebuchet/);
  assert.match(walletCardHtml('mint-a', contents({ ownerProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', key: 'vanity' }), null), /Program account/);
  assert.doesNotMatch(card, /deleted|disagree|rent reserve/i);
});

test('a wallet is worth sweeping when it holds tokens or SOL above dust', () => {
  const { walletSweepable, walletContentsSummary } = page();
  assert.equal(walletSweepable(contents()), false, 'rent reserve and empty accounts only');
  assert.equal(walletSweepable(contents({ lamports: 5_000_000 })), true);
  assert.equal(walletSweepable(contents({ tokens: [{ mint: 'm', amountRaw: '1', decimals: 0 }] })), true);
  assert.equal(walletSweepable(contents({ lamports: 5_000_000, ownerProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' })), false, 'a mint is not a wallet');
  assert.equal(walletContentsSummary(contents()), '0.00066 SOL · 13 open accounts');
});

test('wallet contents are read once and reused for 15 seconds', async () => {
  let reads = 0;
  const context = page();
  context.state.apiClient = { getWalletContents: async () => { reads += 1; return contents(); } };
  await Promise.all([context.walletContents('wallet-a'), context.walletContents('wallet-a')]);
  await context.walletContents('wallet-a');
  assert.equal(reads, 1);
  await context.walletContents('wallet-a', { fresh: true });
  assert.equal(reads, 2);
});

function walletPage({ rows, sweepFails = [] }) {
  const calls = [];
  const context = page({
    $: () => target, renderCoins: () => {}, refreshLocalApiState: async () => {},
    openSweepConfirmation: async (input) => { calls.push(['confirm', input]); return { destinationWallet: 'return-wallet' }; },
  });
  const target = { innerHTML: '' };
  vm.runInContext(view.slice(view.indexOf('// Every key Trebuchet holds')), context);
  context.state.heldWallets.list = rows;
  context.state.apiClient = {
    sweepPendingWallet: async (input) => { calls.push(['sweep', input.walletPublicKey, input.destinationWallet]); if (sweepFails.includes(input.walletPublicKey)) throw new Error('RPC busy'); },
    getWalletContents: async (address) => (sweepFails.includes(address)
      ? rows.find((row) => row.address === address).contents
      : contents({ address, lamports: 0, openAccounts: 0, key: 'retired' })),
  };
  return { context, target, calls };
}

test('the Wallet page lists only keys that hold something and sweeps each launch wallet once', async () => {
  const rows = [
    { address: 'empty-1', kind: 'launch', contents: contents({ lamports: 0, openAccounts: 0 }) },
    { address: 'rent-only', kind: 'retired', contents: contents() },
    { address: 'has-sol', kind: 'retired', contents: contents({ lamports: 50_000_000 }) },
    { address: 'has-token', kind: 'launch', contents: contents({ lamports: 0, tokens: [{ mint: 'mint-treb', amountRaw: '5', decimals: 0 }] }) },
    { address: 'vanity-sol', kind: 'vanity', contents: contents({ lamports: 50_000_000, key: 'vanity' }) },
  ];
  const { context, target, calls } = walletPage({ rows, sweepFails: ['has-token'] });
  context.renderHeldWallets();
  assert.match(target.innerHTML, /5 keys · 4 holding anything/);
  assert.match(target.innerHTML, /data-action="sweep-all-wallets" ><i class="fa-solid fa-broom"><\/i><span>Sweep all \(2\)/);
  assert.doesNotMatch(target.innerHTML, /data-wallet-chip="empty-1"/);
  await context.sweepAllWallets();
  assert.equal(JSON.stringify(calls), JSON.stringify([['confirm', { publicKey: '2 launch wallets', defaultDestination: 'return-wallet' }],
    ['sweep', 'has-sol', 'return-wallet'], ['sweep', 'has-token', 'return-wallet']]));
  assert.match(target.innerHTML, /Swept 1 of 2; 1 not swept\./);
  assert.match(target.innerHTML, /title="RPC busy">Not swept/);
});

test('Sweep all is greyed out with nothing to sweep, and asks for the PIN when it is locked', () => {
  const idle = walletPage({ rows: [{ address: 'rent-only', kind: 'retired', contents: contents() }] });
  idle.context.renderHeldWallets();
  assert.match(idle.target.innerHTML, /data-action="sweep-all-wallets" disabled/);
  assert.match(idle.target.innerHTML, /Nothing to sweep/);
  const locked = walletPage({ rows: [{ address: 'has-sol', kind: 'launch', contents: contents({ lamports: 50_000_000 }) }] });
  locked.context.state.secretPin.locked = true;
  locked.context.renderHeldWallets();
  assert.match(locked.target.innerHTML, /data-action="unlock-secret-pin"/);
});

test('the server reads SOL, token balances, and open token accounts with their rent', async () => {
  const source = server.slice(server.indexOf('const TOKEN_PROGRAM_ADDRESSES'), server.indexOf("app.get('/api/v2/wallets/contents'"));
  const accounts = {
    TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: [
      { account: { lamports: 2039280, data: { parsed: { info: { mint: 'quote', tokenAmount: { amount: '0', decimals: 9 } } } } } },
      { account: { lamports: 2039280, data: { parsed: { info: { mint: 'nft', tokenAmount: { amount: '1', decimals: 0 } } } } } },
    ],
    TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: [
      { account: { lamports: 2074080, data: { parsed: { info: { mint: 'coin', tokenAmount: { amount: '7', decimals: 9 } } } } } },
      { account: { lamports: 2074080, data: { parsed: { info: { mint: 'coin', tokenAmount: { amount: '3', decimals: 9 } } } } } },
    ],
  };
  class PublicKey { constructor(value) { this.value = String(value); } toBase58() { return this.value; } }
  let reads = 0;
  class Connection { async getAccountInfo() { reads += 1; return { lamports: 660241, owner: new PublicKey(SYSTEM) }; }
    async getParsedTokenAccountsByOwner(_owner, { programId }) { return { value: accounts[programId.toBase58()] }; } }
  const context = vm.createContext({ PublicKey, Connection, getRpcUrl: () => 'rpc', Map, BigInt, Date, Promise,
    pendingWallets: { get: (address) => (address === 'wallet-a' ? { retiredAt: '2026-10-03' } : null) }, vanityCaStore: { listMetadata: () => [] } });
  vm.runInContext(`${source}\nthis.readWalletContents = readWalletContents;`, context);
  const result = await context.readWalletContents('wallet-a');
  assert.equal(result.lamports, 660241); assert.equal(result.key, 'retired');
  assert.equal(result.openAccounts, 4); assert.equal(result.accountRentLamports, 8226720);
  assert.equal(JSON.stringify(result.tokens.map((token) => [token.mint, token.amountRaw])), JSON.stringify([['nft', '1'], ['coin', '10']]));
  await context.readWalletContents('wallet-a');
  assert.equal(reads, 1, 'a second read within 15 seconds uses the saved one');
});

test('old launch wallets count only when the chain shows something to sweep', () => {
  const recovery = read('public/v2/features/recovery/view.js');
  const context = page({ selectedLaunchWalletPublicKey: () => 'in-use', isTerminalJournal: () => false });
  context.state.recovery = { journals: [], pendingWallets: [{ publicKey: 'unread' }, { publicKey: 'rent-only' }, { publicKey: 'has-sol', decryptionFailed: true, secretPinLocked: true }, { publicKey: 'in-use' }] };
  context.state.apiClient = { getWalletContents: async () => null };
  vm.runInContext(recovery.slice(recovery.indexOf('function recoveryWalletsNeedingAttention'), recovery.indexOf('// A launch lives on its coin page')), context);
  return Promise.all([
    context.walletContents.call(null, 'rent-only'),
  ]).then(() => {
    context.state.apiClient.getWalletContents = async (address) => contents({ address, lamports: address === 'has-sol' ? 50_000_000 : 660241 });
    return Promise.all(['rent-only', 'has-sol', 'in-use'].map((address) => context.walletContents(address, { fresh: true })));
  }).then(() => {
    assert.equal(JSON.stringify(context.recoveryWalletsNeedingAttention().map((wallet) => wallet.publicKey)), JSON.stringify(['has-sol']));
  });
});

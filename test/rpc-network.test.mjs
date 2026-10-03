// The app's network and its RPC's network must agree; the app now says when they don't and can match them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treb-rpc-'));
process.env.TREBUCHET_CONFIG_DIR = dir;
fs.writeFileSync(path.join(dir, 'rpcConfig.json'), JSON.stringify({
  // The state that stopped quotes: network devnet, RPC Helius mainnet, Helius entries untagged.
  active: 'https://mainnet.helius-rpc.com/?api-key=x', activeNetwork: 'devnet',
  saved: [
    { name: 'Public mainnet', url: 'https://api.mainnet-beta.solana.com', network: 'mainnet' },
    { name: 'Public devnet', url: 'https://api.devnet.solana.com', network: 'devnet' },
    { name: 'Helius devnet', url: 'https://devnet.helius-rpc.com/?api-key=x' },
    { name: 'Helius mainnet', url: 'https://mainnet.helius-rpc.com/?api-key=x' },
  ],
}));
const rpc = await import('../rpcConfig.js');

test('untagged RPCs take their network from the URL, and a mismatch is reported', () => {
  const config = rpc.getConfig();
  assert.equal(config.saved.find((r) => r.name === 'Helius devnet').network, 'devnet');
  assert.equal(config.saved.find((r) => r.name === 'Helius mainnet').network, 'mainnet');
  assert.equal(config.activeNetwork, 'devnet');
  assert.equal(config.rpcNetwork, 'mainnet');
  assert.equal(config.networkMismatch, true);
});

test('keeping the network switches to the same provider on it', () => {
  assert.equal(rpc.matchRpcToNetwork(), 'https://devnet.helius-rpc.com/?api-key=x');
  assert.equal(rpc.getConfig().networkMismatch, false);
});

test('choosing an RPC chooses its network, and keeping the RPC sets the network', () => {
  rpc.setActiveRpc('https://mainnet.helius-rpc.com/?api-key=x');
  assert.equal(rpc.getNetwork(), 'mainnet');
  assert.equal(rpc.getConfig().networkMismatch, false);
  rpc.setNetwork('devnet');
  rpc.setActiveRpc('https://mainnet.helius-rpc.com/?api-key=x');
  assert.equal(rpc.getNetwork(), 'mainnet');
  assert.equal(rpc.inferRpcNetwork('https://rpc.example.com'), null);
});

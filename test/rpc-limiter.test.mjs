import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the token bucket lets a burst through, then spaces requests to the rate', async () => {
  const { acquire } = await import(`../rpcLimiter.js?bucket=${Date.now()}`);
  let clock = 0;
  const waits = [];
  const options = { now: () => clock, wait: async (ms) => { waits.push(ms); clock += ms; } };
  for (let i = 0; i < 8; i += 1) await acquire('burst.example', options);
  assert.equal(clock, 0, 'eight go at once');
  await acquire('burst.example', options);
  await acquire('burst.example', options);
  assert.equal(clock, 250, 'then one every 125 ms');
  await acquire('other.example', options);
  assert.equal(clock, 250, 'each host has its own budget');
});

test('web3.js loaded after the limiter sends its RPC calls through it', () => {
  // A child process: web3.js must load after the limiter, as it does in main.js and server.js.
  const script = `
    import http from 'node:http';
    import './rpcLimiter.js';
    const { Connection } = await import('@solana/web3.js');
    const times = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        times.push(Date.now());
        const { id } = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: 7 }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const connection = new Connection('http://127.0.0.1:' + server.address().port, 'confirmed');
    const started = Date.now();
    await Promise.all(Array.from({ length: 16 }, () => connection.getSlot()));
    server.close();
    console.log(JSON.stringify({ calls: times.length, ms: Date.now() - started }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', env: { ...process.env, TREBUCHET_RPC_RPS: '8' } });
  assert.equal(run.status, 0, run.stderr);
  const { calls, ms } = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(calls, 16);
  assert.ok(ms >= 900, `16 calls at 8 a second take about a second, not ${ms} ms`);
});

test('the limiter loads before anything that loads web3.js', () => {
  for (const file of ['main.js', 'server.js']) {
    const firstImport = fs.readFileSync(`${root}/${file}`, 'utf8').split('\n').find((line) => line.startsWith('import '));
    assert.equal(firstImport, "import './rpcLimiter.js';", file);
  }
  const support = fs.readFileSync(`${root}/supportPositionRoutes.js`, 'utf8');
  assert.doesNotMatch(support, /pendingWallets\.list\(\)/, 'the support job list is polled: it must not decrypt keys');
  assert.doesNotMatch(fs.readFileSync(`${root}/positionWithdrawalRoutes.js`, 'utf8'), /pendingWallets\.list\(\)/);
});

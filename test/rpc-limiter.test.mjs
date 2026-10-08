import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('requests are paced from startup and stay within a rolling second', async () => {
  const { acquire } = await import(`../rpcLimiter.js?bucket=${Date.now()}`);
  let clock = 0;
  const waits = [];
  const options = { now: () => clock, wait: async (ms) => { waits.push(ms); clock += ms; } };
  for (let i = 0; i < 8; i += 1) await acquire('burst.example', { ...options, rate: 8 });
  assert.equal(clock, 875, 'requests are spaced from the first call');
  await acquire('burst.example', { ...options, rate: 8 });
  await acquire('burst.example', { ...options, rate: 8 });
  assert.equal(clock, 1125, 'one every 125 ms');
  await acquire('other.example', { ...options, rate: 8 });
  assert.equal(clock, 1125, 'each host has its own budget');
  await acquire('heavy.example#heavy', { ...options, rate: 1 });
  await acquire('heavy.example#heavy', { ...options, rate: 1 });
  assert.equal(clock, 2125, 'a heavy method waits a second between calls');
});

test('heavy methods are recognised in single and batched requests', async () => {
  const { rpcMethods } = await import(`../rpcLimiter.js?methods=${Date.now()}`);
  assert.deepEqual(rpcMethods('{"jsonrpc":"2.0","id":1,"method":"getProgramAccounts","params":[]}'), ['getProgramAccounts']);
  assert.deepEqual(rpcMethods('[{"jsonrpc":"2.0","method":"getAsset"},{"jsonrpc":"2.0","method":"getSlot"}]'), ['getAsset', 'getSlot']);
  assert.deepEqual(rpcMethods('not json'), []);
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
  assert.ok(ms >= 1700, `16 paced calls at 8 a second took ${ms} ms`);
});

function limitedTarget(installRpcLimiter, host, respond) {
  let clock = 0;
  const sends = [];
  const target = { fetch: async (url, init) => {
    sends.push({ host: new URL(url).host, at: clock, method: JSON.parse(init.body).method });
    return respond?.(sends.length) || new Response('{}');
  } };
  installRpcLimiter(target, { now: () => clock, wait: async (ms) => { clock += ms; } });
  return { sends, call: (method = 'getSlot', options = {}) => target.fetch(`https://${host}`, {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method, id: 1 }), ...options,
  }), target };
}

test('a 429 pauses queued calls to that host using Retry-After', async () => {
  const { installRpcLimiter } = await import('../rpcLimiter.js');
  for (const [index, retryAfter] of ['3', new Date(3000).toUTCString(), 'invalid'].entries()) {
    const h = limitedTarget(installRpcLimiter, `cooldown-${index}.example`,
      (n) => n === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': retryAfter } }) : new Response('{}'));
    assert.equal((await h.call()).status, 429);
    await Promise.all([h.call(), h.call()]);
    assert.ok(h.sends[1].at >= (retryAfter === 'invalid' ? 1000 : 3000));
    assert.ok(h.sends[2].at - h.sends[1].at >= 166);
  }
});

test('heavy methods keep their spacing while sharing the general queue', async () => {
  const { installRpcLimiter } = await import('../rpcLimiter.js');
  const h = limitedTarget(installRpcLimiter, 'mixed-methods.example');
  await Promise.all([h.call('getProgramAccounts'), ...Array.from({ length: 9 }, () => h.call()), h.call('getProgramAccounts')]);
  const heavy = h.sends.filter((send) => send.method === 'getProgramAccounts');
  assert.equal(heavy.length, 2);
  assert.ok(heavy[1].at - heavy[0].at >= 1000);
  assert.ok(h.sends.every((send, index) => index === 0 || send.at - h.sends[index - 1].at >= 166));
});

test('a cancelled queued read releases the queue for the next read', async () => {
  const { installRpcLimiter } = await import('../rpcLimiter.js');
  const h = limitedTarget(installRpcLimiter, 'cancelled.example');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.call('getSlot', { signal: controller.signal }), { name: 'AbortError' });
  await h.call();
  assert.equal(h.sends.length, 1);
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

test('page requests that read the chain wait up to a minute, not the 3.5 s default', () => {
  const client = fs.readFileSync(`${root}/public/v2/api-client.js`, 'utf8');
  assert.match(client, /const CHAIN_REQUEST_TIMEOUT_MS = 60_000;/);
  for (const name of ['estimateClassicFunding', 'checkExecutionReadiness', 'getQuoteTokenInfo', 'checkDetailedBalance', 'findFundingWallet', 'listDestinations', 'stageLaunchPlan']) {
    const body = client.match(new RegExp(`async function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n    \\}`))?.[1] || '';
    assert.match(body, /timeoutMs: CHAIN_REQUEST_TIMEOUT_MS/, name);
  }
});

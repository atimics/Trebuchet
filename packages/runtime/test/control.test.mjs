import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRuntimeControl } from '../src/control.js';

test('runtime stop waits for admitted requests and host background jobs', async () => {
  const owner = { id: 'runtime-test', profile: '/profile', token: 'a'.repeat(43) };
  let stopped = false;
  let releaseWork;
  let enteredWork;
  let background = false;
  const entered = new Promise((resolve) => { enteredWork = resolve; });
  const work = new Promise((resolve) => { releaseWork = resolve; });
  const control = createRuntimeControl({ owner, stop: () => { stopped = true; }, isBusy: () => background });
  const server = http.createServer((req, res) => control(req, res, async () => {
    enteredWork();
    await work;
    res.end('{}');
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-trebuchet-owner': owner.token };
  try {
    const pending = fetch(`${base}/api/work`, { method: 'POST' });
    await entered;
    assert.equal(control.busy(), true);
    assert.equal((await fetch(`${base}/api/runtime/stop`, { method: 'POST', headers })).status, 409);
    releaseWork();
    await pending;
    assert.equal(control.busy(), false);
    background = true;
    assert.equal((await fetch(`${base}/api/runtime/stop`, { method: 'POST', headers })).status, 409);
    background = false;
    const stop = await fetch(`${base}/api/runtime/stop`, { method: 'POST', headers });
    assert.equal(stop.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, true);
    assert.equal((await fetch(`${base}/api/work`, { method: 'POST' })).status, 503);
  } finally {
    releaseWork();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
});

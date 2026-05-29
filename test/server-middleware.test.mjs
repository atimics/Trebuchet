// test/server-middleware.test.mjs
//
// Unit tests for serverMiddleware.js — each middleware function and the
// static-file resolver tested independently, no Express app needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';

import {
  ALLOWED_HOSTS,
  hostCheckMiddleware,
  securityHeadersMiddleware,
  apiSessionMiddleware,
  API_SESSION_TOKEN,
  resolvePublicDir,
} from '../serverMiddleware.js';

// ---------------------------------------------------------------------------
// Helpers — minimal Express-compatible req/res/next stubs
// ---------------------------------------------------------------------------

function stubReq(overrides = {}) {
  const base = {
    headers: {},
    method: 'GET',
    url: '/api/test',
    path: '/test',
  };
  const req = { ...base, ...overrides };
  req.get = (name) => req.headers[name.toLowerCase()];
  return req;
}

function stubRes() {
  const headers = {};
  const res = {
    statusCode: 200,
    body: null,
    headers,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
  };
  return res;
}

function stubNext() {
  let called = false;
  const fn = () => { called = true; };
  fn.called = () => called;
  return fn;
}

// ---------------------------------------------------------------------------
// hostCheckMiddleware
// ---------------------------------------------------------------------------

test('hostCheckMiddleware: passes when Host is 127.0.0.1', () => {
  const req = stubReq({ headers: { host: '127.0.0.1:3000' } });
  const next = stubNext();
  hostCheckMiddleware(req, stubRes(), next);
  assert.equal(next.called(), true, 'next() should be called');
});

test('hostCheckMiddleware: passes when Host is localhost', () => {
  const req = stubReq({ headers: { host: 'localhost:3000' } });
  const next = stubNext();
  hostCheckMiddleware(req, stubRes(), next);
  assert.equal(next.called(), true);
});

test('hostCheckMiddleware: passes when Host has no port', () => {
  const req = stubReq({ headers: { host: 'localhost' } });
  const next = stubNext();
  hostCheckMiddleware(req, stubRes(), next);
  assert.equal(next.called(), true);
});

test('hostCheckMiddleware: rejects external Host headers', () => {
  const req = stubReq({ headers: { host: 'attacker.com:3000' } });
  const res = stubRes();
  const next = stubNext();
  hostCheckMiddleware(req, res, next);
  assert.equal(next.called(), false, 'next() should NOT be called');
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { success: false, error: 'invalid Host header' });
});

test('hostCheckMiddleware: rejects empty Host header', () => {
  const req = stubReq({ headers: {} });
  const res = stubRes();
  const next = stubNext();
  hostCheckMiddleware(req, res, next);
  assert.equal(next.called(), false);
  assert.equal(res.statusCode, 403);
});

// ---------------------------------------------------------------------------
// securityHeadersMiddleware
// ---------------------------------------------------------------------------

test('securityHeadersMiddleware: sets CSP, frame, and content-type headers', () => {
  const res = stubRes();
  const next = stubNext();
  securityHeadersMiddleware(stubReq(), res, next);

  assert.ok(res.headers['content-security-policy'], 'CSP header set');
  assert.ok(
    res.headers['content-security-policy'].includes("default-src 'self'"),
    'CSP includes default-src',
  );
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(next.called(), true);
});

// ---------------------------------------------------------------------------
// apiSessionMiddleware
// ---------------------------------------------------------------------------

test('apiSessionMiddleware: passes /api/session without a token', () => {
  const req = stubReq({ path: '/session', headers: {} });
  const next = stubNext();
  apiSessionMiddleware(req, stubRes(), next);
  assert.equal(next.called(), true, '/session is exempt');
});

test('apiSessionMiddleware: passes /api/proxy-image without a token', () => {
  const req = stubReq({ path: '/proxy-image', headers: {} });
  const next = stubNext();
  apiSessionMiddleware(req, stubRes(), next);
  assert.equal(next.called(), true, '/proxy-image is exempt');
});

test('apiSessionMiddleware: rejects /api/* without a token', () => {
  const req = stubReq({ path: '/create-token', headers: {} });
  const res = stubRes();
  const next = stubNext();
  apiSessionMiddleware(req, res, next);
  assert.equal(next.called(), false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { success: false, error: 'invalid API session' });
});

test('apiSessionMiddleware: rejects with wrong token', () => {
  const req = stubReq({
    path: '/create-token',
    headers: { 'x-trebuchet-session': 'wrong-token' },
  });
  const res = stubRes();
  const next = stubNext();
  apiSessionMiddleware(req, res, next);
  assert.equal(next.called(), false);
  assert.equal(res.statusCode, 403);
});

test('apiSessionMiddleware: passes with correct token', () => {
  const req = stubReq({
    path: '/create-token',
    headers: { 'x-trebuchet-session': API_SESSION_TOKEN },
  });
  const next = stubNext();
  apiSessionMiddleware(req, stubRes(), next);
  assert.equal(next.called(), true);
});

// ---------------------------------------------------------------------------
// resolvePublicDir
// ---------------------------------------------------------------------------

test('resolvePublicDir: dev mode — joins __dirname with public/', () => {
  const result = resolvePublicDir('/path/to/project');
  assert.equal(result, path.join('/path/to/project', 'public'));
});

test('resolvePublicDir: packaged Electron — rewrites past app.asar', () => {
  // Simulate __dirname inside an asar: /path/to/resources/app.asar
  const result = resolvePublicDir(
    `/path/to/resources${path.sep}app.asar`,
  );
  const expected = `/path/to/resources${path.sep}app.asar.unpacked${path.sep}public`;
  assert.equal(result, expected);
});

test('resolvePublicDir: does not false-match app.asarx', () => {
  const result = resolvePublicDir('/path/to/resources/app.asarx');
  assert.equal(result, path.join('/path/to/resources/app.asarx', 'public'));
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('ALLOWED_HOSTS contains localhost and 127.0.0.1', () => {
  assert.equal(ALLOWED_HOSTS.has('127.0.0.1'), true);
  assert.equal(ALLOWED_HOSTS.has('localhost'), true);
  assert.equal(ALLOWED_HOSTS.has('attacker.com'), false);
});

test('API_SESSION_TOKEN is a non-empty string', () => {
  assert.equal(typeof API_SESSION_TOKEN, 'string');
  assert.ok(API_SESSION_TOKEN.length > 0);
});

// ---------------------------------------------------------------------------
// Security fixes: case-insensitive host, array Host guard
// ---------------------------------------------------------------------------

test('hostCheckMiddleware: passes when Host is mixed-case Localhost', () => {
  const req = stubReq({ headers: { host: 'Localhost:3000' } });
  const next = stubNext();
  hostCheckMiddleware(req, stubRes(), next);
  assert.equal(next.called(), true, 'mixed-case Localhost should pass');
});

test('hostCheckMiddleware: passes when Host is LOCALHOST', () => {
  const req = stubReq({ headers: { host: 'LOCALHOST' } });
  const next = stubNext();
  hostCheckMiddleware(req, stubRes(), next);
  assert.equal(next.called(), true, 'uppercase LOCALHOST should pass');
});

test('hostCheckMiddleware: Host header whitespace-only does not crash', () => {
  const req = stubReq({ headers: { host: '  ' } });
  const res = stubRes();
  const next = stubNext();
  assert.doesNotThrow(() => hostCheckMiddleware(req, res, next));
  // Whitespace-only hostname should be rejected
  assert.equal(next.called(), false);
});

// ---------------------------------------------------------------------------
// apiSessionMiddleware: near-miss paths
// ---------------------------------------------------------------------------

test('apiSessionMiddleware: /sessions is NOT exempt (requires token)', () => {
  const req = stubReq({ path: '/sessions', headers: {} });
  const res = stubRes();
  const next = stubNext();
  apiSessionMiddleware(req, res, next);
  assert.equal(next.called(), false);
  assert.equal(res.statusCode, 403);
});

test('apiSessionMiddleware: /session/ is NOT exempt (trailing slash)', () => {
  const req = stubReq({ path: '/session/', headers: {} });
  const res = stubRes();
  const next = stubNext();
  apiSessionMiddleware(req, res, next);
  assert.equal(next.called(), false);
  assert.equal(res.statusCode, 403);
});

// ---------------------------------------------------------------------------
// resolvePublicDir: app.asar/subdir false-positive guard
// ---------------------------------------------------------------------------

test('resolvePublicDir: does not rewrite app.asar when it is a directory component', () => {
  const result = resolvePublicDir(
    '/path/to/resources/app.asar/subdir',
  );
  assert.equal(
    result,
    path.join('/path/to/resources/app.asar/subdir', 'public'),
    'app.asar as directory component should not be rewritten',
  );
});

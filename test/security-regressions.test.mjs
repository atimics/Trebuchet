import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiSessionMiddleware } from '../serverMiddleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// The SSE grind endpoint IS exempt from the apiSessionMiddleware (because
// EventSource can't set the x-trebuchet-session header), but the handler itself
// validates the session token via a query parameter.  This test confirms the
// middleware exemption (the handler's inline check is tested via the
// vanity-server-safety test suite).
test('vanity-stream endpoint is exempt from session auth (handler validates token inline)', () => {
  let nextCalled = false;
  const req = { path: '/generate-vanity-wallet-stream', get: () => undefined };
  const res = {};
  apiSessionMiddleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true, 'vanity-stream endpoint must pass through middleware (handler validates token inline)');
});

// Control: a genuinely exempt, non-sensitive path still passes (so the test
// above is asserting something specific, not that the middleware blocks all).
test('session bootstrap endpoint remains exempt', () => {
  let nextCalled = false;
  apiSessionMiddleware({ path: '/session', get: () => undefined }, {}, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

// FAILING NOW (finding C2): -march=native bakes the build host's ISA into a
// binary that ships inside the Electron app to arbitrary user CPUs → SIGILL on
// older/different machines. Release builds must use a portable baseline.
test('C Makefile uses portable flags for release (-march=native only in dev target)', () => {
  const makefile = readFileSync(path.join(REPO, 'c', 'Makefile'), 'utf8');
  // Allowed in the dev target, but the default CFLAGS must be portable.
  const defaultCflags = makefile.match(/^CFLAGS\s*[?]?=\s*(.+)$/m);
  assert.ok(defaultCflags, 'Makefile must define default CFLAGS');
  assert.ok(
    !/-march=native/.test(defaultCflags[1]),
    '-march=native must not be in default CFLAGS — only in the dev target',
  );
});

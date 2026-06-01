import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiSessionMiddleware } from '../serverMiddleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// FAILING NOW (finding C3): the SSE grind endpoint was added to the
// apiSessionMiddleware exemption list so EventSource (which can't set headers)
// could reach it — but that lets any localhost page spawn native grinds with no
// session token (CSRF / CPU-DoS). The fix is to validate a query-param token
// inline, NOT to exempt the path. This test goes green when the exemption is
// removed (and the handler validates the token itself).
test('vanity-stream endpoint is not exempt from session auth', () => {
  let nextCalled = false;
  let statusCode = null;
  const req = { path: '/generate-vanity-wallet-stream', get: () => undefined };
  const res = {
    status(code) { statusCode = code; return this; },
    json() { return this; },
  };
  apiSessionMiddleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false, 'no-token request to vanity-stream must NOT pass through');
  assert.equal(statusCode, 403, 'no-token request to vanity-stream must be rejected 403');
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
test('C Makefile does not use -march=native (non-portable for shipped binary)', () => {
  const makefile = readFileSync(path.join(REPO, 'c', 'Makefile'), 'utf8');
  assert.ok(
    !/-march=native/.test(makefile),
    '-march=native must not be in release CFLAGS — it crashes on CPUs lacking the build host’s ISA',
  );
});

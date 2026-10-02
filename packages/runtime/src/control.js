import { timingSafeEqual } from 'node:crypto';

function send(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

// Mount after host/origin security checks, before API routes and body parsing.
export function createRuntimeControl({ owner, stop, isBusy = () => false }) {
  let stopping = false;
  let activeMutations = 0;
  const busy = () => activeMutations > 0 || isBusy();
  function runtimeControl(req, res, next) {
    const route = req.url.split('?')[0];
    const ownerRoute = route === '/api/runtime' || route === '/api/runtime/stop';
    if (ownerRoute || req.headers['x-trebuchet-owner'] !== undefined) {
      const supplied = Buffer.from(String(req.headers['x-trebuchet-owner'] || ''));
      const expected = Buffer.from(owner.token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return send(res, 403, { code: 'RUNTIME_AUTH_REQUIRED', error: 'Use the profile owner token to access runtime controls.' });
      }
    }
    if (ownerRoute) {
      if (req.method === 'GET' && route === '/api/runtime') {
        return send(res, 200, { schema: 'trebuchet-runtime/v1', id: owner.id, profile: owner.profile, pid: process.pid, state: stopping ? 'stopping' : busy() ? 'busy' : 'ready' });
      }
      if (req.method === 'POST' && route === '/api/runtime/stop') {
        if (busy()) return send(res, 409, { code: 'RUNTIME_BUSY', error: 'The runtime has active work. Retry after it finishes.' });
        stopping = true;
        // Send the receipt before closing the listener. Admission is already closed.
        res.once('finish', () => { setImmediate(() => Promise.resolve().then(stop).catch((error) => console.error('Runtime stop failed:', error.message))); });
        return send(res, 200, { success: true, id: owner.id, state: 'stopping' });
      }
      return send(res, 405, { code: 'INVALID_INPUT', error: 'Use GET for status or POST for stop.' });
    }
    if (stopping) return send(res, 503, { code: 'RUNTIME_STOPPING', error: 'The runtime is stopping. Attach again after it exits.' });
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method) || route === '/api/generate-vanity-wallet-stream';
    if (mutation) {
      activeMutations += 1;
      // Finish describes completed work. A disconnected client may leave
      // work running, so a lost response keeps this admission busy.
      let released = false;
      const release = () => { if (!released) { released = true; activeMutations -= 1; } };
      res.once('finish', release);
      // A lost response keeps admission busy until the owner is restarted.
      // This preserves work that continues after a client disconnects.
    }
    next();
  }
  runtimeControl.busy = busy;
  return runtimeControl;
}

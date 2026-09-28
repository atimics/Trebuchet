import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readRuntimeDescriptor } from './owner.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function runtimeError(code, message) { return Object.assign(new Error(message), { code }); }

export async function connectRuntime(profile, { timeoutMs = 1000 } = {}) {
  let descriptor;
  try { descriptor = readRuntimeDescriptor(profile); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const headers = { 'x-trebuchet-owner': descriptor.token };
  let response;
  try {
    response = await fetch(`${descriptor.url}/api/runtime`, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.cause?.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNRESET' || error.cause?.code === 'UND_ERR_SOCKET' || error.cause?.code === 'UND_ERR_CONNECT_TIMEOUT') return null;
    throw error;
  }
  if (!response.ok) return null;
  const identity = await response.json();
  if (identity.schema !== descriptor.schema || identity.id !== descriptor.id || identity.profile !== descriptor.profile || identity.pid !== descriptor.pid) {
    throw runtimeError('RUNTIME_IDENTITY_MISMATCH', 'The local runtime identity changed. Read its current descriptor before attaching.');
  }
  let sessionToken = null;
  return Object.freeze({
    identity: Object.freeze(identity),
    url: descriptor.url,
    async request(endpoint, { method = 'GET', body, signal } = {}) {
      if (!/^\/api\/(?!\/)[A-Za-z0-9_/?=&.%+-]+$/.test(endpoint) || endpoint.includes('..')) {
        throw runtimeError('INVALID_INPUT', 'A runtime request requires a local API path.');
      }
      if (!sessionToken) {
        const session = await fetch(`${descriptor.url}/api/session`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (!session.ok) throw runtimeError('RUNTIME_UNAVAILABLE', 'Read the runtime session before sending a request.');
        sessionToken = (await session.json()).token;
        if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken || '')) throw runtimeError('RUNTIME_UNAVAILABLE', 'The runtime returned an invalid session.');
      }
      const result = await fetch(`${descriptor.url}${endpoint}`, {
        method, signal, redirect: 'error',
        headers: { ...headers, 'x-trebuchet-session': sessionToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await result.json();
      if (!result.ok) throw Object.assign(runtimeError(payload.code || 'RUNTIME_REQUEST_FAILED', payload.error || `Runtime returned HTTP ${result.status}`), { statusCode: result.status, ...(typeof payload.operationId === 'string' ? { operationId: payload.operationId } : {}), ...(payload.errorDetails && typeof payload.errorDetails === 'object' ? { errorDetails: payload.errorDetails } : {}) });
      return payload;
    },
  });
}

// Each caller may start one child. The child's profile lock chooses the owner.
// Every caller then attaches through the same authenticated descriptor.
export async function ensureRuntime(profileDir, {
  command = process.execPath,
  args,
  env = process.env,
  timeoutMs = 30_000,
} = {}) {
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const profile = fs.realpathSync(profileDir);
  const existing = await connectRuntime(profile);
  if (existing) return existing;
  if (!Array.isArray(args) || !args.length) throw runtimeError('INVALID_INPUT', 'Supply the runtime entry point when starting a local process.');
  const logPath = path.join(profile, 'runtime.log');
  if (fs.existsSync(logPath) && fs.lstatSync(logPath).isSymbolicLink()) throw runtimeError('RECOVERY_STORAGE_UNAVAILABLE', 'Runtime log must be a regular file.');
  const log = fs.openSync(logPath, 'a', 0o600);
  fs.chmodSync(logPath, 0o600);
  let child;
  try {
    child = spawn(command, args, {
      cwd: profile,
      env: { ...env, TREBUCHET_CONFIG_DIR: profile, PORT: '0' },
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
  } finally { fs.closeSync(log); }
  let spawnError = null;
  child.once('error', (error) => { spawnError = error; });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) throw runtimeError('RUNTIME_START_FAILED', `Start the runtime process: ${spawnError.message}`);
    const runtime = await connectRuntime(profile, { timeoutMs: Math.min(1000, Math.max(1, deadline - Date.now())) });
    if (runtime) return runtime;
    await delay(100);
  }
  throw runtimeError('RUNTIME_START_TIMEOUT', `Runtime startup requires attention. Read ${logPath} for details.`);
}

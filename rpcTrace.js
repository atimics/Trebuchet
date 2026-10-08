// rpcTrace.js
//
// With TREBUCHET_RPC_TRACE=1, count every Solana RPC call by method and by the app code that
// made it, and print the totals every 10 seconds. Off by default; it changes nothing when off.
// For finding what floods the RPC with requests (and draws 429s).

import { createRequire } from 'module';
import { Connection as EsmConnection } from '@solana/web3.js';

const require = createRequire(import.meta.url);
// Some modules load web3.js as CommonJS: that is a second Connection class to count as well.
const connectionClasses = [...new Set([EsmConnection, require('@solana/web3.js').Connection])];

const PERIOD_MS = 10_000;

// The first stack frame in this app's own code (not web3.js, not node internals).
export function appCaller(stack = new Error().stack || '') {
  const frames = String(stack).split('\n').slice(1).map((line) => line.trim());
  const own = frames.filter((line) => !/node_modules|node:|rpcTrace\.js|<anonymous>/.test(line)).slice(0, 3);
  if (!own.length) return 'unknown';
  return own.map((line) => {
    const match = line.match(/at (?:async )?([^\s(]+)? ?\(?(?:file:\/\/)?[^()]*\/([^/():]+):(\d+):\d+\)?$/);
    return match ? `${match[2]}:${match[3]}${match[1] ? ` ${match[1]}` : ''}` : line.slice(0, 80);
  }).join(' ← ');
}

export function installRpcTrace({ log = console.log, now = Date.now } = {}) {
  const counts = new Map();
  let since = now();
  const restore = [];
  // Requests go through a per-connection function web3.js builds in its constructor, so the
  // public methods on the class are what can be wrapped: every get*, send* and confirm* call.
  for (const Connection of connectionClasses) {
    const proto = Connection.prototype;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (!/^(get|send|confirm|simulate|request)/.test(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      const original = descriptor?.value;
      if (typeof original !== 'function' || original.__traced) continue;
      const traced = function tracedConnectionCall(...args) {
        const key = `${name} ← ${appCaller()}`;
        counts.set(key, (counts.get(key) || 0) + 1);
        return original.apply(this, args);
      };
      traced.__traced = true;
      proto[name] = traced;
      restore.push(() => { proto[name] = original; });
    }
  }
  const timer = setInterval(() => {
    if (!counts.size) return;
    const seconds = (now() - since) / 1000;
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    log(`[rpc-trace] ${total} calls in ${seconds.toFixed(0)}s (${(total / seconds).toFixed(1)}/s)\n${rows.map(([key, value]) => `  ${String(value).padStart(5)}  ${key}`).join('\n')}`);
    counts.clear();
    since = now();
  }, PERIOD_MS);
  timer.unref?.();
  return () => { clearInterval(timer); restore.forEach((undo) => undo()); };
}

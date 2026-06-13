#!/usr/bin/env node
// Emit a static browser SPA build under dist/spa.
//
// The static build is intentionally a browser shell, not a fake full launch
// backend. It boots the existing UI, persists local preferences in localStorage,
// serves static/fallback metadata, and clearly rejects server-only launch
// endpoints until those paths move to browser-wallet transaction signing.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildAppJs } from './build-app-js.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const publicDir = join(root, 'public');
const outDir = join(root, 'dist', 'spa');

buildAppJs();

if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });
cpSync(publicDir, outDir, { recursive: true });

const indexPath = join(outDir, 'index.html');
let html = readFileSync(indexPath, 'utf8');

html = html.replace(
  /script-src 'self';/,
  "script-src 'self' 'wasm-unsafe-eval';",
);
html = html.replace(
  /connect-src 'self';/,
  "connect-src 'self' https: wss:; worker-src 'self' blob:;",
);
html = html.replace(
  '<script src="api.js"></script>',
  '<script src="spa-api.js"></script>',
);

writeFileSync(indexPath, html);

console.log(`Built static SPA at ${outDir}`);
console.log('Serve it with: npx http-server dist/spa -c-1');

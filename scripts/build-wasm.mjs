#!/usr/bin/env node
// Build browser-loadable WebAssembly artifacts for Trebuchet.
//
// Current scope: the C vanity key generator. The rest of the launch flow still
// depends on server-side Solana transaction construction, so it is intentionally
// not represented as WASM here yet.

import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'public', 'wasm');
const outFile = join(outDir, 'vanity_keygen.mjs');

const sources = [
  join(root, 'c', 'vanity_keygen', 'vanity_keygen.c'),
  join(root, 'c', 'vrf_ed25519.c'),
  join(root, 'c', 'vendor', 'tweetnacl', 'tweetnacl.c'),
  join(root, 'c', 'vendor', 'tweetnacl', 'randombytes.c'),
];

const includes = [
  join(root, 'c'),
  join(root, 'c', 'vendor'),
  join(root, 'c', 'vendor', 'tweetnacl'),
];

function probeEmcc() {
  const result = spawnSync('emcc', ['--version'], { stdio: 'pipe' });
  return result.status === 0;
}

if (!probeEmcc()) {
  console.error('Emscripten emcc is required for npm run build:wasm.');
  console.error('Install it from https://emscripten.org/docs/getting_started/downloads.html');
  process.exit(1);
}

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

const args = [
  ...sources,
  ...includes.flatMap((include) => ['-I', include]),
  '-O3',
  '-sMODULARIZE=1',
  '-sEXPORT_ES6=1',
  '-sENVIRONMENT=web,worker',
  '-sINVOKE_RUN=0',
  '-sEXIT_RUNTIME=1',
  '-sEXPORTED_RUNTIME_METHODS=callMain,FS',
  '-o', outFile,
];

console.log('Building browser WASM vanity_keygen');
console.log(`  output: ${outFile}`);

const result = spawnSync('emcc', args, {
  cwd: root,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Failed to invoke emcc: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status || 1);
}

console.log('Built public/wasm/vanity_keygen.mjs and public/wasm/vanity_keygen.wasm');

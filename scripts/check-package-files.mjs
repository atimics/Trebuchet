// scripts/check-package-files.mjs
//
// Guards against the recurring "added a module but forgot to list it in
// package.json" bug. In dev the app runs straight from the source tree, so a
// missing entry is invisible — but electron-builder only packages what the
// `build.files` allowlist matches, so an unlisted module is silently absent
// from the shipped app and the launcher breaks at runtime for end users.
//
// What this checks:
//   1. COVERAGE (hard fail): every first-party .js file reachable from the
//      Electron entry point (main.js), following static AND dynamic imports
//      transitively, must be matched by a pattern in BOTH package.json
//      `files` (npm) and `build.files` (electron-builder). Plus a small set
//      of non-import runtime assets that are read via fs rather than imported
//      (e.g. README.md, served by the in-app README viewer).
//   2. STALE LISTINGS (hard fail): every individually-listed (non-glob) entry
//      in either list must exist on disk — catches a deleted file that was
//      left in the list (e.g. an old extracted module).
//   3. DEAD LISTINGS (warning only): a root .js file that's listed and exists
//      but is NOT in the runtime closure. Usually means dead code or an
//      unnecessary packaging entry; warned, not failed, since a file could
//      legitimately be loaded by a path this static scan can't see.
//
// Zero dependencies on purpose: CI runs this after `npm ci` with only the
// app's own deps installed, so it must rely on Node built-ins alone.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Electron entry point. Everything the packaged app needs at runtime is
// reachable from here (main.js side-effect-imports server.js, which in turn
// imports the rest; vanityKeygen.js is reached via a dynamic import).
const ENTRY_FILES = ['main.js'];

// Runtime files that are loaded by path (fs.readFile / sendFile) rather than
// by `import`, so the import scan can't discover them. Keep this list short
// and obvious; each entry is a real runtime read. Files served out of public/
// are covered by the public/**/* glob and don't need listing here.
const EXTRA_RUNTIME_FILES = [
  'README.md',     // main.js README viewer: fs.readFile(__dirname/README.md)
  'metadata.json', // listed historically; harmless if unused
];

// ---------------------------------------------------------------------------
// 1. Compute the first-party JS import closure (dependency-free).
// ---------------------------------------------------------------------------

// Pull relative module specifiers out of a source file. Handles the four
// shapes that actually appear: `import ... from './x'`, side-effect
// `import './x'`, `export ... from './x'`, and dynamic `import('./x')`.
// Comments are stripped first so a commented-out import doesn't count.
function relativeSpecifiers(src) {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const out = [];
  const patterns = [
    /\bimport\s+[^'"]*?\bfrom\s*['"](\.\.?\/[^'"]+)['"]/g,
    /\bimport\s*['"](\.\.?\/[^'"]+)['"]/g,
    /\bexport\s+[^'"]*?\bfrom\s*['"](\.\.?\/[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(code))) out.push(m[1]);
  }
  return out;
}

function computeClosure() {
  const seen = new Set();
  const missingOnDisk = [];
  const queue = [...ENTRY_FILES];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.join(ROOT, rel);
    let src;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      missingOnDisk.push(rel);
      continue;
    }
    const dir = path.dirname(rel);
    for (const spec of relativeSpecifiers(src)) {
      const resolved = path
        .normalize(path.join(dir, spec))
        .replace(/\\/g, '/');
      queue.push(resolved);
    }
  }
  return { closure: [...seen].sort(), missingOnDisk };
}

// ---------------------------------------------------------------------------
// 2. Minimal glob matcher for the package.json patterns.
// ---------------------------------------------------------------------------

// Supports the patterns these lists actually use: exact paths, and globs with
// `**` (any number of path segments) and `*` (any run of non-slash chars).
function patternToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**` (optionally followed by `/`) matches across path separators.
        i++;
        if (pattern[i + 1] === '/') i++;
        re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else if (c === '/') {
      re += '/';
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function isCovered(file, patterns) {
  return patterns.some((p) => patternToRegExp(p).test(file));
}

// A list entry is a glob if it contains wildcard chars; otherwise it names a
// single file we expect to exist on disk.
function isGlob(pattern) {
  return /[*?[\]{}]/.test(pattern);
}

// ---------------------------------------------------------------------------
// 3. Run the checks.
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const npmFiles = pkg.files || [];
const buildFiles = (pkg.build && pkg.build.files) || [];

const { closure, missingOnDisk } = computeClosure();
const closureJs = closure.filter((f) => f.endsWith('.js'));

// The full set of files the packaged app must contain.
const required = [...new Set([...closureJs, ...EXTRA_RUNTIME_FILES])].sort();

const errors = [];
const warnings = [];

// (a) main field must be packaged.
if (pkg.main) required.push(pkg.main);

// (1) Coverage: every required file matched by BOTH lists.
for (const f of required) {
  if (!isCovered(f, buildFiles)) {
    errors.push(`build.files is MISSING required runtime file: ${f}`);
  }
  if (!isCovered(f, npmFiles)) {
    errors.push(`files (npm) is MISSING required runtime file: ${f}`);
  }
}

// (1b) Entry files that the scan couldn't read.
for (const f of missingOnDisk) {
  errors.push(`import closure references a file not found on disk: ${f}`);
}

// (2) Stale listings: a named (non-glob) entry that doesn't exist on disk.
for (const [label, list] of [['files', npmFiles], ['build.files', buildFiles]]) {
  for (const entry of list) {
    if (isGlob(entry)) continue;
    if (!existsSync(path.join(ROOT, entry))) {
      errors.push(`${label} lists a file that does not exist on disk: ${entry}`);
    }
  }
}

// (3) Dead listings (warning): a listed root .js that exists but isn't in the
// runtime closure. Could be dead code or an unnecessary packaging entry.
const closureSet = new Set(closureJs);
for (const [label, list] of [['files', npmFiles], ['build.files', buildFiles]]) {
  for (const entry of list) {
    if (isGlob(entry) || !entry.endsWith('.js') || entry.includes('/')) continue;
    if (!closureSet.has(entry)) {
      warnings.push(`${label} lists ${entry}, which is not reached from ${ENTRY_FILES.join(', ')} (possibly dead code / unnecessary entry)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

console.log(`Runtime first-party JS closure: ${closureJs.length} files`);
console.log(`Required runtime files checked: ${required.length}`);

for (const w of [...new Set(warnings)]) console.warn('  warning: ' + w);

if (errors.length) {
  console.error('\nPackaging file-list check FAILED:');
  for (const e of [...new Set(errors)]) console.error('  ✗ ' + e);
  console.error(
    '\nFix: add the missing file(s) to BOTH the "files" and "build.files" ' +
    'arrays in package.json (or remove stale entries). These lists control ' +
    'what electron-builder packages into the shipped app.',
  );
  process.exit(1);
}

console.log('\nPackaging file-list check passed: every runtime file is listed in both "files" and "build.files".');

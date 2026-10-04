import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The renderer is built by concatenating feature files. A name defined in one file and
// dropped in a split stays referenced elsewhere, and only fails when that line runs: the
// grinder's live rate threw on every progress event for a week that way.
const require = createRequire(import.meta.url);
let ts = null;
try { ts = require('typescript'); } catch { /* the check needs the TypeScript checker */ }

test('every name the v2 page uses is defined somewhere in the page', { skip: !ts && 'typescript is not installed' }, () => {
  const file = (name) => fileURLToPath(new URL(`../public/v2/${name}`, import.meta.url));
  const files = [file('core.js'), file('api-client.js'), file('app.js')];
  const program = ts.createProgram(files, {
    allowJs: true, checkJs: true, noEmit: true, types: [], target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  });
  const missing = ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => [2304, 2552].includes(diagnostic.code) && diagnostic.file?.fileName.endsWith('app.js'))
    .map((diagnostic) => {
      const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return `app.js:${line + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
    });
  assert.deepEqual(missing, []);
});

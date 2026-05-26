import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('public frontend has no inline JavaScript event handlers', () => {
  const app = read('public/app.js');
  const html = read('public/index.html');
  const combined = `${app}\n${html}`;

  assert.equal(/\bon(?:click|load|error)=["']/i.test(combined), false);
  assert.equal(/javascript:/i.test(combined), false);
});

test('frontend assets are local and guarded by CSP', () => {
  const html = read('public/index.html');

  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /vendor\/bulma\/bulma\.min\.css/);
  assert.match(html, /vendor\/fontawesome\/css\/all\.min\.css/);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/);
});

test('release artifacts stay out of git and lockfile is trackable', () => {
  const ignore = read('.gitignore');

  assert.match(ignore, /^\/dist$/m);
  assert.doesNotMatch(ignore, /^package-lock\.json$/m);
});

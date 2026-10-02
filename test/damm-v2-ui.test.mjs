import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the lean launch view is wired into the page, the nav and the renderer', () => {
  const html = read('public/v2/index.html');
  const entry = html.match(/<button[^>]*data-view="lean"[^>]*>/)?.[0] || '';
  assert.ok(entry, 'a button opens it');
  assert.doesNotMatch(entry, /nav-item/, 'it is opened from the Coins page, not the nav');
  assert.ok(html.indexOf(entry) > html.indexOf('id="view-coins"') && html.indexOf(entry) < html.indexOf('id="coinsList"'), 'the button sits in the Coins toolbar');
  assert.match(html, /id="view-lean"[\s\S]*?id="leanRoot"/, 'it has a view section with a root');
  assert.match(html, /<script src="\.\/lean\.js\?v=\d+"><\/script>/, 'its script is loaded');
  assert.match(read('public/v2/features/shell/state.js'), /lean: \{ eyebrow: '', title: 'Lean launch' \}/, 'it has a title');
  assert.match(read('public/v2/features/launch/workspace.js'), /view === 'lean'\) window\.TrebuchetLean\?\.onShow\(\)/, 'showing the view loads it');
  assert.match(read('public/v2/app.js'), /view === 'lean'\) window\.TrebuchetLean\?\.onShow\(\)/, 'the shipped renderer carries the hook');
});

test('the view only talks to the lean launch routes and never handles a key', () => {
  const view = read('public/v2/lean.js');
  // The view may read the hasSecretKey flag (to offer only wallets that can sign), never a key.
  assert.doesNotMatch(view, /(?<!has)secretKey|mnemonic|privateKey|positionNftEnc|scalar/i, 'no key material in the renderer');
  const routes = new Set([...view.matchAll(/'(\/api\/[a-z0-9\-\/]+)/g)].map((m) => m[1]));
  for (const route of routes) {
    assert.match(route, /^\/api\/(v2\/damm|v2\/wallets|vanity-ca-candidates|secret-pin\/status|check-balance)/, `unexpected route ${route}`);
  }
  assert.match(view, /maxSpendSol: ui\.estimate\.cost\.total, solUsd: ui\.estimate\.solUsd/, 'run sends the cap and the SOL price the operator saw');
  assert.match(view, /if \(ui\.detail\.status === 'draft' && !ui\.approved\) throw/, 'running needs the approval');
});

test('a launch is not offered until it is saved, approved and funded', () => {
  const view = read('public/v2/lean.js');
  assert.match(view, /saved && e && ui\.approved && !ui\.dirty && !pinLocked && canRun\(\) && !shortfall/);
  assert.match(view, /Every edit takes the approval back/);
});

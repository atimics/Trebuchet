// Pure geometry and share math for the 3D vortex control. The module is a
// classic browser script, so it is loaded in a VM sandbox the way the repo
// tests public/v2/api-client.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(REPO, 'public', 'v2', 'vortex.js'), 'utf8');

function loadVortex() {
  const sandbox = { Math, Number, String, Array, Object, JSON, Infinity };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'vortex.js' });
  return sandbox.TrebuchetV2Vortex;
}

function pools(solPercent = 70, corePercent = 30) {
  return [
    { id: 'sol', symbol: 'SOL', percent: solPercent, minPercent: 10, feeTier: 8 },
    { id: 'quote', symbol: 'FLY', percent: corePercent, minPercent: 10, maxPercent: 30, feeTier: 5 },
  ];
}

test('bands stack down a funnel: wide mouth first, narrow throat last', () => {
  const vortex = loadVortex();
  const bands = vortex.layoutBands(pools());
  assert.equal(bands.length, 2);
  assert.equal(bands[0].symbol, 'SOL');
  assert.equal(bands[1].symbol, 'FLY');

  // The mouth is above the throat and wider than it.
  assert.ok(bands[0].yTop < bands[1].yTop);
  assert.ok(bands[0].rTop > bands[1].rBottom);
  // Radii shrink monotonically toward the throat.
  assert.ok(bands[0].rTop > bands[0].rBottom);
  assert.ok(bands[0].rBottom >= bands[1].rBottom);
  // Bands tile the funnel without gaps.
  assert.equal(bands[0].yBottom, bands[1].yTop);
  assert.equal(bands[1].yBottom, vortex.constants.Y_BOTTOM);
});

test('the wider market occupies the taller span', () => {
  const vortex = loadVortex();
  const [sol, core] = vortex.layoutBands(pools(70, 30));
  assert.ok((sol.yBottom - sol.yTop) > (core.yBottom - core.yTop));
});

test('a zero-share pool still gets a visible, grabbable ring', () => {
  const vortex = loadVortex();
  const bands = vortex.layoutBands(pools(100, 0));
  assert.equal(bands.length, 2, 'the 0% core is still rendered');
  assert.ok(bands[1].yBottom - bands[1].yTop > 4, 'it has visual thickness');
  assert.ok(bands[1].rTop > 0);
});

test('dragging a ring down grows the mouth and shrinks the throat', () => {
  const vortex = loadVortex();
  const model = pools();
  // The boundary currently sits at t=0.7 (SOL holds 70%).
  assert.ok(Math.abs(vortex.boundaryDeltaForUpper(model, 0, 0.7)) < 0.05, 'the current boundary needs no change');

  // Dragging it down to t=0.9 must hand 20 points to SOL.
  const down = vortex.boundaryDeltaForUpper(model, 0, 0.9);
  assert.equal(Math.round(down), 20);
  const opened = vortex.transferShare(model, 0, down);
  assert.equal(opened[0].percent, 90);
  assert.equal(opened[1].percent, 10);

  // Dragging up is clamped by the core's 30% ceiling.
  const up = vortex.boundaryDeltaForUpper(model, 0, 0.5);
  assert.equal(Math.round(up), -20);
  const clamped = vortex.transferShare(model, 0, up);
  assert.equal(clamped[1].percent, 30);
  assert.equal(clamped[0].percent, 70);
});

test('share moves between neighbours and the total is preserved', () => {
  const vortex = loadVortex();
  const model = pools();
  const total = (list) => list.reduce((sum, pool) => sum + pool.percent, 0);
  const nudged = vortex.transferShare(model, 0, 5);
  assert.equal(nudged[0].percent, 75);
  assert.equal(nudged[1].percent, 25);
  assert.equal(total(nudged), total(model));

  const floored = vortex.transferShare(model, 0, 100);
  assert.equal(floored[1].percent, 10, 'the core cannot go below its floor');
  assert.equal(floored[0].percent, 90);
});

test('funnel paths close and trace elliptical rims', () => {
  const vortex = loadVortex();
  const [band] = vortex.layoutBands(pools());
  const path = vortex.funnelPath(band);
  assert.match(path, /^M /);
  assert.match(path, /A /, 'uses elliptical arcs for the rims');
  assert.match(path, /Z$/);
  assert.match(vortex.helixPath(), /^M /, 'the helix is a path');
});

test('fee tiers map to spin speed and colour', () => {
  const vortex = loadVortex();
  assert.ok(vortex.spinForFeeTier(3).speed > vortex.spinForFeeTier(8).speed);
  assert.match(vortex.spinForFeeTier(3).color, /^#/);
  assert.match(vortex.spinForFeeTier(undefined).color, /^#/);
});

test('mount renders the funnel, bands and draggable boundaries', () => {
  const vortex = loadVortex();
  const host = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const control = vortex.mount(host, {
    read: () => ({
      pools: [
        { id: 'sol', symbol: 'SOL', percent: 70, minPercent: 10, feeTier: 8 },
        { id: 'quote', symbol: 'FLY', percent: 30, minPercent: 10, maxPercent: 30, feeTier: 5 },
      ],
      depositSol: 1.287,
    }),
  });
  assert.ok(control && typeof control.render === 'function');
  assert.match(host.innerHTML, /Flywheel vortex/);
  assert.match(host.innerHTML, /FLY core at 30%/);
  assert.match(host.innerHTML, /SOL 70%/);
  assert.match(host.innerHTML, /1\.287 SOL/);
  assert.match(host.innerHTML, /vortex-slice/);
  assert.match(host.innerHTML, /vortex-rim/);
  assert.match(host.innerHTML, /vortex-helix/);
  assert.match(host.innerHTML, /vortex-boundary/);
  assert.match(host.innerHTML, /role="slider"/);
});

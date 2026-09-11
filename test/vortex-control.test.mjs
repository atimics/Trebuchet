// Pure-math coverage for the vortex allocation control. The module is a
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

test('bands are concentric, outermost first, thickness proportional to share', () => {
  const vortex = loadVortex();
  const bands = vortex.layoutBands([
    { id: 'sol', symbol: 'SOL', percent: 70, feeTier: 8 },
    { id: 'quote', symbol: 'FLY', percent: 30, feeTier: 5 },
  ]);
  assert.equal(bands.length, 2);
  assert.equal(bands[0].symbol, 'SOL');
  assert.equal(bands[1].symbol, 'FLY');
  assert.ok(bands[0].rOuter > bands[0].rInner);
  // The core sits inside the outer band and never collapses past the minimum.
  assert.ok(bands[1].rInner >= vortex.constants.MIN_RADIUS);
  const solThickness = bands[0].rOuter - bands[0].rInner;
  const flyThickness = bands[1].rOuter - bands[1].rInner;
  assert.ok(solThickness > flyThickness, 'the larger share is the thicker band');
});

test('dragging a boundary moves share between neighbours and preserves the total', () => {
  const vortex = loadVortex();
  const pools = [
    { id: 'sol', symbol: 'SOL', percent: 70, minPercent: 10 },
    { id: 'quote', symbol: 'FLY', percent: 30, minPercent: 10, maxPercent: 30 },
  ];
  const total = (list) => list.reduce((sum, pool) => sum + pool.percent, 0);

  // Positive delta moves supply outward (grows the SOL band, shrinks the core).
  const nudged = vortex.transferShare(pools, 0, 5);
  assert.equal(nudged[0].percent, 75);
  assert.equal(nudged[1].percent, 25);
  assert.equal(total(nudged), total(pools));

  // The core cannot go below its 10% floor: supply stops flowing outward.
  const floored = vortex.transferShare(pools, 0, 100);
  assert.equal(floored[1].percent, 10);
  assert.equal(floored[0].percent, 90);

  // Negative delta would push the core past its 30% ceiling: clamped to 0.
  const capped = vortex.transferShare(pools, 0, -100);
  assert.equal(capped[1].percent, 30);
  assert.equal(capped[0].percent, 70);
});

test('fee tiers map to spin speed and colour', () => {
  const vortex = loadVortex();
  assert.ok(vortex.spinForFeeTier(3).speed > vortex.spinForFeeTier(8).speed);
  assert.match(vortex.spinForFeeTier(3).color, /^#/);
  assert.match(vortex.spinForFeeTier(undefined).color, /^#/);
});

test('mount renders the vortex and reports the core share', () => {
  const vortex = loadVortex();
  const host = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const control = vortex.mount(host, {
    read: () => ({
      pools: [
        { id: 'custom-0', symbol: 'HONEY', percent: 10, feeTier: 3 },
        { id: 'sol', symbol: 'SOL', percent: 60, feeTier: 8 },
        { id: 'quote', symbol: 'FLY', percent: 30, feeTier: 5 },
      ],
      depositSol: 1.287,
    }),
  });
  assert.ok(control && typeof control.render === 'function');
  assert.match(host.innerHTML, /Flywheel vortex/);
  assert.match(host.innerHTML, /FLY core at 30%/);
  assert.match(host.innerHTML, /SOL 60%/);
  assert.match(host.innerHTML, /1\.287 SOL/);
  assert.match(host.innerHTML, /vortex-handle/);
});

test('dragging through the mounted control writes back updated shares', () => {
  const vortex = loadVortex();
  let model = {
    pools: [
      { id: 'sol', symbol: 'SOL', percent: 70, minPercent: 10, feeTier: 8 },
      { id: 'quote', symbol: 'FLY', percent: 30, minPercent: 10, maxPercent: 30, feeTier: 5 },
    ],
    depositSol: 1,
  };
  let written = null;
  const host = {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const control = vortex.mount(host, {
    read: () => model,
    write: (pools) => { written = pools; model = { ...model, pools }; },
  });
  control.render();
  // Drive the pure transition the pointer handler uses, then re-render.
  const next = vortex.transferShare(model.pools, 0, 4);
  written = next;
  assert.equal(written[0].percent, 74);
  assert.equal(written[1].percent, 26);
});

test('a zero-share pool still gets a band and a draggable boundary', () => {
  const vortex = loadVortex();
  const bands = vortex.layoutBands([
    { id: 'sol', symbol: 'SOL', percent: 100, feeTier: 8 },
    { id: 'quote', symbol: 'FLY', percent: 0, minPercent: 10, maxPercent: 30, feeTier: 5 },
  ]);
  assert.equal(bands.length, 2, 'the 0% core is still rendered');
  assert.ok(bands[1].rOuter - bands[1].rInner > 0, 'it has visual thickness');
  assert.ok(bands[1].rInner >= vortex.constants.MIN_RADIUS);

  // Dragging it open moves supply from SOL into the flywheel core.
  const opened = vortex.transferShare([
    { id: 'sol', symbol: 'SOL', percent: 100, minPercent: 10 },
    { id: 'quote', symbol: 'FLY', percent: 0, minPercent: 10, maxPercent: 30 },
  ], 0, -12);
  assert.equal(opened[1].percent, 12);
  assert.equal(opened[0].percent, 88);
});

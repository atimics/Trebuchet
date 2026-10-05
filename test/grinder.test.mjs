import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { calibrateVanityRate } from '../vanityKeygen.js';

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const vanity = read('public/v2/features/launch/vanity.js');
const prepare = read('public/v2/features/launch/prepare.js');
const slice = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start} should be extractable`);
  return source.slice(from, to);
};

function page({ saved = null } = {}) {
  const storage = new Map(saved ? [['trebuchet:v2:vanity-rate', String(saved)]] : []);
  const cancelled = [];
  const state = { grindJobs: [], vanityRunning: false, vanitySource: null, apiStatus: 'connected',
    apiClient: { cancelVanityGrind: async () => { cancelled.push(true); } } };
  const started = [];
  const context = vm.createContext({
    state, renderAll: () => {}, renderVanityCandidates: () => {},
    window: { localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } },
    escapeHtml: (value) => String(value), fullAddress: (value) => value,
    Date,
  });
  vm.runInContext([
    slice(vanity, 'function formatVanityAttempts', '\n// From the real odds'),
    slice(vanity, '// The live rate is measured over this window', 'const VANITY_VISIBLE_CANDIDATE_LIMIT'),
    slice(vanity, '// The speed to plan with', 'function vanityPatternEstimate'),
    slice(vanity, '// The grind area:', '\nfunction renderVanityCandidates'),
    slice(prepare, '// Grinds are jobs:', '// The Grind button'),
    slice(prepare, 'function runNextGrindJob()', '// Measure this computer'),
  ].join('\n'), context);
  context.runVanityGrind = async (job) => { job.status = 'running'; job.startedAt = Date.now() - 4000; started.push(job.id); };
  return { context, state, storage, started, cancelled };
}

const job = (id, extra = {}) => ({ id, target: id, prefix: '', suffix: id, expected: 1_000_000, status: 'queued', attempts: 0, rate: null, ...extra });

test('machines differ too much to guess: no speed until this computer measures one', () => {
  const blank = page();
  assert.equal(blank.context.vanityPlanningRate(), null);
  assert.match(blank.context.grindAreaHtml({ canGrind: true, estimate: { targetLength: 3, invalid: [], expectedAttempts: 195_112, p95: 584_513, prefix: '', suffix: 'abc' } }), /Speed not measured[\s\S]*Calibrate/);
  blank.context.rememberVanityRate(86_417_569.6);
  assert.equal(blank.context.vanityPlanningRate(), 86_417_570);
  assert.match(blank.context.grindAreaHtml({ canGrind: true, estimate: { targetLength: 3, invalid: [], expectedAttempts: 86_417_570 * 30, p95: 86_417_570 * 90, prefix: '', suffix: 'abc' } }), /This computer: 86.4M\/s[\s\S]*~30s, 95% by ~2m/);
  assert.doesNotMatch(vanity, /hardwareConcurrency|PER_CORE/);
});

test('grinds queue: one runs, the next starts when it ends, and a queued one can be removed', async () => {
  const { context, state, started } = page();
  state.grindJobs = [job('A'), job('B'), job('C')];
  context.runNextGrindJob();
  assert.deepEqual(started, ['A']);
  assert.equal(context.runningGrindJob().id, 'A');
  await context.stopGrindJob('C');
  assert.deepEqual(state.grindJobs.map((item) => item.id), ['A', 'B'], 'a queued grind is just removed');
  context.finishGrindJob(state.grindJobs[0], 'found', { publicKey: 'Addr', attempts: 900_000 });
  assert.deepEqual(started, ['A', 'B'], 'the next queued grind starts');
  assert.equal(state.grindJobs[0].status, 'found');
});

test('stopping a grind keeps its stats on screen until dismissed with the ×', async () => {
  const { context, state, cancelled } = page({ saved: 80_000_000 });
  state.grindJobs = [job('A', { status: 'running', startedAt: Date.now() - 4000, attempts: 320_000_000, rate: 80_000_000, expected: 656_000_000 })];
  state.vanityRunning = true;
  await context.stopGrindJob('A');
  assert.equal(state.grindJobs[0].status, 'stopped');
  assert.equal(cancelled.length, 1, 'the server grind is cancelled');
  assert.equal(state.vanityRunning, false);
  const html = context.grindJobHtml(state.grindJobs[0]);
  assert.match(html, /Stopped · 320M tries in 4s · 80M\/s · 49% of expected/);
  assert.match(html, /data-action="dismiss-grind-job" data-job="A"[^>]*aria-label="Dismiss"/);
  context.dismissGrindJob('A');
  assert.deepEqual(state.grindJobs, []);
});

test('a running grind shows live tries, speed, and time to expected, with Stop', () => {
  const { context } = page();
  const html = context.grindJobHtml(job('A', { status: 'running', startedAt: Date.now() - 1500, attempts: 164_000_000, rate: 85_600_000, expected: 656_000_000 }));
  assert.match(html, /164M tries · 25% of expected · 85.6M\/s · ~6s to expected · 2s so far/);
  assert.match(html, /data-action="stop-grind-job"[\s\S]*Stop/);
});

test('calibration measures 3 seconds of the real grinder and saves nothing', async () => {
  let clock = 0;
  let resolveRun;
  let cancelledAt = null;
  const calls = [];
  const generate = (options) => {
    calls.push(options);
    // Bursts as the grinder reports them: 85M tries a second.
    for (let second = 1; second <= 3; second += 1) {
      clock = second * 1000;
      options.onProgress({ attempts: second * 85_000_000 });
    }
    return new Promise((_resolve, reject) => { resolveRun = () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })); });
  };
  const cancel = () => { cancelledAt = clock; resolveRun(); return true; };
  const result = await calibrateVanityRate({ seconds: 0.01, generate, cancel, now: () => clock });
  assert.equal(result.rate, 85_000_000);
  assert.equal(cancelledAt, 3000);
  assert.equal(calls[0].suffix, 'zzzzzzzzz', 'a pattern too long to match in a few seconds');
  assert.match(calls[0].splitPoint, /^[0-9a-f]{64}$/, 'a throwaway public point, no secret');
  const server = read('server.js');
  assert.match(server, /app\.post\('\/api\/v2\/vanity\/calibrate'/);
  assert.match(server, /busy \? 409 : 500/);
});

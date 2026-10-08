import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { journalStep, loadCrankJournal, saveSchedule, loadSchedule } from '../src/store.js';

const inMemory = () => {
  let rows = [];
  return {
    load: () => rows,
    save: (next) => { rows = Array.isArray(next) ? next : []; },
    rows: () => rows,
  };
};

test('journalStep appends once per (crankId, step) — an idempotent boundary', () => {
  const records = inMemory();
  const first = journalStep({ records: records.load(), save: records.save, crankId: 'c1', step: 'claim', state: 'confirmed', txId: 'sig1', lamports: 1000 });
  assert.equal(first.length, 1);
  const replay = journalStep({ records: records.load(), save: records.save, crankId: 'c1', step: 'claim', state: 'confirmed', txId: 'sig2', lamports: 9999 });
  assert.equal(replay.length, 1, 'replayed step does not double-write');
  assert.equal(records.rows()[0].txId, 'sig1');
  const next = journalStep({ records: records.load(), save: records.save, crankId: 'c1', step: 'route/buyback-burn', state: 'confirmed', txId: 'sig3' });
  assert.equal(next.length, 2);
});

test('loadCrankJournal filters by crank id', () => {
  const rows = [
    { crankId: 'c1', step: 'claim', state: 'confirmed' },
    { crankId: 'c2', step: 'claim', state: 'confirmed' },
  ];
  assert.equal(loadCrankJournal(rows, 'c2').length, 1);
});

test('saveSchedule replaces per scope and only stores validated schedules', () => {
  const records = inMemory();
  const scopeId = 'launch-A';
  saveSchedule(records.load(), records.save, { schema: 'trebuchet-flywheel-schedule/v1', mode: 'fee-routing', scopeId, outputs: [{ type: 'buyback-burn', pct: 100 }] });
  saveSchedule(records.load(), records.save, { schema: 'trebuchet-flywheel-schedule/v1', mode: 'fee-routing', scopeId, outputs: [{ type: 'transfer', pct: 100, wallet: 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j' }] });
  assert.equal(records.rows().length, 1, 'replaced, not appended');
  assert.equal(loadSchedule(records.load(), scopeId).outputs[0].type, 'transfer');
  assert.throws(() => saveSchedule(records.load(), records.save, { notA: 'schedule' }), /validated flywheel schedule/);
});

test('store helpers work against the real SQLite runtime store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claimer-test-'));
  const { openCrankCollections } = await import('../src/store.js');
  const { store, cranks, schedules } = openCrankCollections(dir);
  try {
    journalStep({ records: cranks.load(), save: cranks.save, crankId: 'real-1', step: 'claim', state: 'confirmed', txId: 'x' });
    assert.equal(loadCrankJournal(cranks.load(), 'real-1').length, 1);
    saveSchedule(schedules.load(), schedules.save, { schema: 'trebuchet-flywheel-schedule/v1', mode: 'static', scopeId: 's' });
    assert.ok(loadSchedule(schedules.load(), 's'));
  } finally {
    store.close();
  }
});
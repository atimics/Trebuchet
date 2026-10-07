// Crank journal and schedule storage for the claimer, on the runtime SQLite
// store. One journal row per crank step (claim, each route output); a crank
// resumes from its journal instead of retrying blind.

import { openRuntimeStore } from '@trebuchet/runtime/store';

export const CRANK_JOURNAL_NAMESPACE = 'runtime-flywheel-cranks/v1';
export const SCHEDULE_NAMESPACE = 'runtime-flywheel-schedules/v1';
const CRANK_SCHEMA = 'trebuchet-crank/v1';

export function openCrankCollections(profileDir) {
  const store = openRuntimeStore(profileDir);
  return { store, cranks: store.collection(CRANK_JOURNAL_NAMESPACE), schedules: store.collection(SCHEDULE_NAMESPACE) };
}

/**
 * Load the journal for one scope (a launch) and crank id.
 * Rows are [{ id, step, state, txId?, lamports?, error?, at }]; a step is a
 * claim or one route output. `state` is 'pending' | 'confirmed' | 'failed'.
 * Returns the rows for `crankId` or [].
 */
export function loadCrankJournal(records, crankId) {
  return (Array.isArray(records) ? records : []).filter((row) => row && row.crankId === crankId);
}

/**
 * Append a journal row idempotently: the same (crankId, step) is never
 * written twice, so a replayed crank cannot double-claim or double-route.
 */
export function journalStep({ records, save, crankId, step, state, txId = null, lamports = null, error = null, at = new Date().toISOString() }) {
  const existing = (Array.isArray(records) ? records : []).filter((row) => row && row.crankId === crankId && row.step === step);
  if (existing.length) return records;
  const next = [...(Array.isArray(records) ? records : [])];
  next.push({
    id: `crank:${crankId}:${step}`,
    schema: CRANK_SCHEMA,
    crankId,
    step,
    state,
    txId,
    lamports: Number.isFinite(Number(lamports)) ? Number(lamports) : null,
    error: error ? String(error).slice(0, 500) : null,
    at,
  });
  save(next);
  return next;
}

/**
 * Save or replace one schedule for a scope. The schedule is normalized at
 * save time by the caller; only fully validated schedules reach the store.
 */
export function saveSchedule(records, save, schedule) {
  if (!schedule || typeof schedule !== 'object' || !schedule.schema) {
    throw new Error('Only a validated flywheel schedule can be saved');
  }
  const scopeId = String(schedule.scopeId || 'default').trim();
  const others = (Array.isArray(records) ? records : []).filter((record) => !record || record.scopeId !== scopeId);
  const next = [...others, { ...schedule, scopeId, id: `schedule:${scopeId}` }];
  save(next);
  return next;
}

export function loadSchedule(records, scopeId) {
  return (Array.isArray(records) ? records : []).find((record) => record && record.scopeId === scopeId) || null;
}
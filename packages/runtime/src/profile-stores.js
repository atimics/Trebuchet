import path from 'node:path';
import { createLaunchJournalStore, normalizeJournal, sanitizeForJournal } from '@trebuchet/core/launch-journal';
import { createLaunchStore, normalizeEntry } from '@trebuchet/core/launch-store';
import { openRuntimeStore } from './store.js';

function profileStore(directory, { namespace, legacyFile, create, normalize, methods }) {
  const profile = path.resolve(directory);
  const filePath = path.join(profile, 'execution.sqlite');
  const api = { filePath };
  for (const method of methods) {
    api[method] = (...args) => {
      const db = openRuntimeStore(profile);
      try {
        db.importLegacyJson(legacyFile, namespace, normalize);
        const store = create({ filePath, storage: db.collection(namespace) });
        return store[method](...args);
      } finally { db.close(); }
    };
  }
  return api;
}
export function createProfileJournalStore(directory) {
  return profileStore(directory, {
    namespace: 'journals', legacyFile: 'launchJournals.json', create: createLaunchJournalStore,
    normalize(record) {
      if (!record || typeof record.walletPublicKey !== 'string' || !record.walletPublicKey) throw new Error('Legacy journal requires a wallet identity');
      return normalizeJournal(sanitizeForJournal(record));
    },
    methods: ['start', 'get', 'activeForWallet', 'update', 'upsertForWallet', 'recordEvent', 'list', 'archive'],
  });
}
export function createProfileLaunchStore(directory) {
  return profileStore(directory, {
    namespace: 'saved-launches', legacyFile: 'launches.json', create: createLaunchStore,
    normalize(record) {
      const entry = normalizeEntry(record);
      if (!entry) throw new Error('Legacy saved launch needs recovery');
      return entry;
    },
    methods: ['list', 'get', 'save', 'remove'],
  });
}

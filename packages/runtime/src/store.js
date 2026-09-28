import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class RecoveryStorageError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'RecoveryStorageError';
    this.code = 'RECOVERY_STORAGE_UNAVAILABLE';
  }
}
const now = () => new Date().toISOString();
const hash = (value) => createHash('sha256').update(value).digest('hex');

// Public execution records use a separate store from encrypted signer material.
export function publicJson(value) {
  const visit = (item, depth = 0) => {
    if (depth > 64) throw new TypeError('Execution record exceeds nesting limit');
    if (item === null || item === undefined || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('Execution numbers must be finite');
      return item;
    }
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));
    if (typeof item !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new TypeError('Execution records must contain JSON values');
    const output = Object.create(null);
    for (const key of Object.keys(item).sort()) {
      if (/(secret|private|mnemonic|passphrase)/i.test(key)) throw new TypeError('Store signer material in encrypted custody');
      output[key] = visit(item[key], depth + 1);
    }
    return output;
  };
  const serialized = JSON.stringify(visit(value));
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 5 * 1024 * 1024) throw new TypeError('Execution record exceeds size limit');
  return serialized;
}

export function operationId({ launchId, walletPublicKey, kind, index = 0, planDigest }) {
  for (const [key, value] of Object.entries({ launchId, walletPublicKey, kind, planDigest })) {
    if (typeof value !== 'string' || !value) throw new TypeError(`Operation requires ${key}`);
  }
  if (!Number.isSafeInteger(index) || index < 0) throw new TypeError('Operation index must be a whole number');
  return hash(publicJson({ launchId, walletPublicKey, kind, index, planDigest }));
}

export function openRuntimeStore(profileDir) {
  let directory = path.resolve(profileDir);
  let db;
  let depth = 0;
  const fail = (error) => error instanceof RecoveryStorageError ? error
    : new RecoveryStorageError('Execution storage needs recovery before further spending.', { cause: error });
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    directory = fs.realpathSync(directory);
    const file = path.join(directory, 'execution.sqlite');
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Execution database must be a regular file');
    db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) throw new Error('Execution database requires a newer Trebuchet runtime');
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS collections (namespace TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(namespace, id)) STRICT;
      CREATE TABLE IF NOT EXISTS migrations (source TEXT PRIMARY KEY, digest TEXT NOT NULL, imported_at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS launches (id TEXT PRIMARY KEY, wallet TEXT NOT NULL, network TEXT NOT NULL, plan_digest TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, launch_id TEXT NOT NULL REFERENCES launches(id), wallet TEXT NOT NULL,
        kind TEXT NOT NULL, intent_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','submitted','recovery_required','confirmed','failed')),
        body TEXT NOT NULL, evidence TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS wallet_active_operation ON operations(wallet) WHERE state IN ('prepared','submitted','recovery_required');
      CREATE TABLE IF NOT EXISTS transactions (
        signature TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id), wire TEXT NOT NULL,
        blockhash TEXT NOT NULL, last_valid_height INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('signed','submitted','confirmed','failed','expired')),
        receipt TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS operation_approvals (
        id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id), body TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 2;
      COMMIT;`);
  } catch (error) {
    try { db?.close(); } catch { /* retain the opening error */ }
    throw fail(error);
  }
  const transaction = (fn) => {
    if (depth) return fn();
    try {
      db.exec('BEGIN IMMEDIATE');
      depth++;
      const result = fn();
      if (result && typeof result.then === 'function') throw new TypeError('Storage transactions must finish synchronously');
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve the operation error */ }
      if (error.code && ['OPERATION_CONFLICT', 'OPERATION_IN_FLIGHT', 'INVALID_TRANSITION'].includes(error.code)) throw error;
      throw fail(error);
    } finally { depth = 0; }
  };
  const conflict = (message, code = 'OPERATION_CONFLICT') => { throw Object.assign(new Error(message), { code }); };
  const collection = (namespace) => ({
    transaction,
    load: () => {
      try { return db.prepare('SELECT body FROM collections WHERE namespace = ? ORDER BY rowid').all(namespace).map((row) => JSON.parse(row.body)); }
      catch (error) { throw fail(error); }
    },
    save: (records) => transaction(() => {
      const encoded = records.map((record) => ({ id: record.id, body: publicJson(record) }));
      if (encoded.some((record) => typeof record.id !== 'string' || !record.id)) throw new TypeError('Stored records require an id');
      db.prepare('DELETE FROM collections WHERE namespace = ?').run(namespace);
      const insert = db.prepare('INSERT INTO collections(namespace, id, body) VALUES (?, ?, ?)');
      for (const record of encoded) insert.run(namespace, record.id, record.body);
    }),
  });
  const decodeOperation = (row) => row ? {
    id: row.id, launchId: row.launch_id, walletPublicKey: row.wallet, kind: row.kind,
    intentDigest: row.intent_digest, state: row.state, payload: JSON.parse(row.body),
    evidence: row.evidence ? JSON.parse(row.evidence) : null, createdAt: row.created_at, updatedAt: row.updated_at,
  } : null;
  const getOperation = (id) => decodeOperation(db.prepare('SELECT * FROM operations WHERE id = ?').get(id));
  const store = {
    directory, transaction, collection,
    close() { db.close(); },
    importLegacyJson(sourceName, namespace, normalize = (record) => record) {
      if (path.basename(sourceName) !== sourceName) throw new TypeError('Legacy source must be a profile filename');
      return transaction(() => {
        if (db.prepare('SELECT source FROM migrations WHERE source = ?').get(sourceName)) return false;
        const file = path.join(directory, sourceName);
        let bytes;
        try { bytes = fs.readFileSync(file); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        const records = JSON.parse(bytes);
        if (!Array.isArray(records)) throw new TypeError('Legacy recovery data must contain an array');
        if (collection(namespace).load().length) throw new Error('Resolve existing SQLite records before importing legacy recovery data');
        collection(namespace).save(records.map(normalize));
        db.prepare('INSERT INTO migrations VALUES (?, ?, ?)').run(sourceName, hash(bytes), now());
        return true;
      });
    },
    saveLaunch({ id = randomUUID(), walletPublicKey, network, planDigest, config }) {
      if (!walletPublicKey || !['demo','devnet','mainnet','localnet'].includes(network) || !/^[a-f0-9]{64}$/.test(planDigest || '')) throw new TypeError('Launch requires a wallet, network, and plan digest');
      const body = publicJson(config);
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM launches WHERE id = ?').get(id);
        if (existing) {
          if (existing.wallet !== walletPublicKey || existing.network !== network || existing.plan_digest !== planDigest || existing.body !== body) conflict('Launch identity is immutable');
          return store.getLaunch(id);
        }
        db.prepare('INSERT INTO launches VALUES (?, ?, ?, ?, ?, ?)').run(id, walletPublicKey, network, planDigest, body, now());
        return store.getLaunch(id);
      });
    },
    getLaunch(id) {
      const row = db.prepare('SELECT * FROM launches WHERE id = ?').get(id);
      return row ? { id: row.id, walletPublicKey: row.wallet, network: row.network, planDigest: row.plan_digest, config: JSON.parse(row.body), createdAt: row.created_at } : null;
    },
    getWalletWorkflow(walletPublicKey) {
      return collection('runtime-wallet-workflows/v1').load().find((record) => record.walletPublicKey === walletPublicKey && record.state === 'active') || null;
    },
    reserveWalletWorkflow({ id, walletPublicKey, kind, context }) {
      return transaction(() => {
        if (![id, walletPublicKey, kind].every((value) => typeof value === 'string' && value)) throw new TypeError('Use a complete wallet workflow identity');
        const records = collection('runtime-wallet-workflows/v1'), all = records.load();
        const prior = all.find((record) => record.id === id), candidate = { id, walletPublicKey, kind, context, state: 'active' };
        if (prior) {
          if (publicJson(prior) !== publicJson(candidate)) conflict('Wallet workflow identity is immutable');
          return prior;
        }
        if (store.getWalletWorkflow(walletPublicKey) || store.getActiveOperation(walletPublicKey)) conflict('Recover the active wallet work first', 'OPERATION_IN_FLIGHT');
        records.save([...all, candidate]); return candidate;
      });
    },
    finishWalletWorkflow(id, evidence) {
      return transaction(() => {
        const records = collection('runtime-wallet-workflows/v1'), all = records.load(), index = all.findIndex((record) => record.id === id);
        if (index < 0) throw new Error('Use the saved wallet workflow');
        if (!evidence || typeof evidence !== 'object' || !Object.keys(evidence).length) throw new Error('Verify the workflow result before completion');
        if (all[index].state === 'confirmed') {
          if (publicJson(all[index].evidence) !== publicJson(evidence)) conflict('Preserve the confirmed workflow evidence');
          return;
        }
        if (store.getActiveOperation(all[index].walletPublicKey)) conflict('Recover the workflow transaction before completion', 'OPERATION_IN_FLIGHT');
        all[index] = { ...all[index], state: 'confirmed', evidence }; records.save(all);
      });
    },
    prepareOperation({ launchId, kind, index = 0, payload = {} }) {
      return transaction(() => {
        const launch = store.getLaunch(launchId);
        if (!launch) throw new Error('Launch must be stored before preparing an operation');
        const id = operationId({ launchId, walletPublicKey: launch.walletPublicKey, kind, index, planDigest: launch.planDigest });
        const body = publicJson(payload);
        const intentDigest = hash(body);
        const existing = getOperation(id);
        if (existing) {
          if (existing.intentDigest !== intentDigest) conflict('Operation input changed under the same identity');
          return existing;
        }
        const workflow = store.getWalletWorkflow(launch.walletPublicKey);
        if (workflow && launch.config.workflowId !== workflow.id) conflict('Recover the saved wallet workflow first', 'OPERATION_IN_FLIGHT');
        const active = db.prepare("SELECT id FROM operations WHERE wallet = ? AND state IN ('prepared','submitted','recovery_required')").get(launch.walletPublicKey);
        if (active) conflict('Wallet has an operation that requires completion or recovery', 'OPERATION_IN_FLIGHT');
        const timestamp = now();
        db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)').run(id, launchId, launch.walletPublicKey, kind, intentDigest, 'prepared', body, timestamp, timestamp);
        return getOperation(id);
      });
    },
    getOperation,
    listWalletOperations(walletPublicKey) {
      try {
        return db.prepare('SELECT * FROM operations WHERE wallet = ? ORDER BY created_at, rowid').all(walletPublicKey).map(decodeOperation);
      } catch (error) { throw fail(error); }
    },
    getActiveOperation(walletPublicKey) {
      return decodeOperation(db.prepare("SELECT * FROM operations WHERE wallet = ? AND state IN ('prepared','submitted','recovery_required')").get(walletPublicKey));
    },
    recordOperationApproval(operationId, approval) {
      return transaction(() => {
        if (!getOperation(operationId) || typeof approval?.id !== 'string' || !approval.id) throw new TypeError('An approval requires an operation and identity');
        const body = publicJson(approval);
        const prior = db.prepare('SELECT * FROM operation_approvals WHERE id = ?').get(approval.id);
        if (prior) {
          if (prior.operation_id !== operationId || prior.body !== body) conflict('Approval identity is immutable');
          return;
        }
        db.prepare('INSERT INTO operation_approvals VALUES (?, ?, ?, ?)').run(approval.id, operationId, body, now());
      });
    },
    getOperationApprovals(operationId) {
      return db.prepare('SELECT body FROM operation_approvals WHERE operation_id = ? ORDER BY rowid').all(operationId).map((row) => JSON.parse(row.body));
    },
    listOperations(launchId) {
      return db.prepare('SELECT * FROM operations WHERE launch_id = ? ORDER BY created_at, rowid').all(launchId).map(decodeOperation);
    },
    setOperationState(id, state, evidence = null) {
      const transitions = { prepared: ['submitted','recovery_required','confirmed','failed'], submitted: ['recovery_required','confirmed','failed'], recovery_required: ['submitted','confirmed','failed'], confirmed: [], failed: [] };
      return transaction(() => {
        const prior = getOperation(id);
        if (!prior || (!transitions[prior.state].includes(state) && prior.state !== state)) conflict('Operation needs a valid recovery transition', 'INVALID_TRANSITION');
        if (['confirmed','failed'].includes(state) && (!evidence || typeof evidence !== 'object' || !Object.keys(evidence).length)) throw new TypeError('Terminal operations require chain or failure evidence');
        if (['confirmed','failed'].includes(prior.state)) {
          if (publicJson(prior.evidence) !== publicJson(evidence)) conflict('Terminal operation evidence is immutable');
          return prior;
        }
        db.prepare('UPDATE operations SET state = ?, evidence = ?, updated_at = ? WHERE id = ?').run(state, evidence ? publicJson(evidence) : null, now(), id);
        return getOperation(id);
      });
    },
    recordSignedTransaction({ operationId: opId, signature, wire, blockhash, lastValidBlockHeight }) {
      return transaction(() => {
        const op = getOperation(opId);
        if (!op || !['prepared','submitted','recovery_required'].includes(op.state)) conflict('Transaction requires an active operation');
        if (!signature || !wire || !blockhash || !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 0) throw new TypeError('Signed transaction requires bytes, signature, blockhash, and expiry');
        const prior = db.prepare('SELECT * FROM transactions WHERE signature = ?').get(signature);
        if (prior) {
          if (prior.operation_id !== opId || prior.wire !== wire || prior.blockhash !== blockhash || prior.last_valid_height !== lastValidBlockHeight) conflict('Transaction signature already belongs to another payload');
          return store.getTransactions(opId).find((tx) => tx.signature === signature);
        }
        const pending = db.prepare("SELECT signature FROM transactions WHERE operation_id = ? AND state IN ('signed','submitted')").get(opId);
        if (pending) conflict('Reconcile the saved transaction before signing a replacement', 'OPERATION_IN_FLIGHT');
        const timestamp = now();
        db.prepare('INSERT INTO transactions VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)').run(signature, opId, wire, blockhash, lastValidBlockHeight, 'signed', timestamp, timestamp);
        return store.getTransactions(opId).find((tx) => tx.signature === signature);
      });
    },
    recordReceipt(signature, state, receipt) {
      return transaction(() => {
        const prior = db.prepare('SELECT * FROM transactions WHERE signature = ?').get(signature);
        if (!prior || !['submitted','confirmed','failed','expired'].includes(state)) conflict('Receipt requires a stored transaction');
        const body = publicJson(receipt);
        if (['confirmed','failed','expired'].includes(prior.state)) {
          if (prior.state !== state || prior.receipt !== body) conflict('Terminal transaction receipt is immutable');
          return;
        }
        db.prepare('UPDATE transactions SET state = ?, receipt = ?, updated_at = ? WHERE signature = ?').run(state, body, now(), signature);
      });
    },
    getTransactions(opId) {
      return db.prepare('SELECT * FROM transactions WHERE operation_id = ? ORDER BY rowid').all(opId).map((row) => ({ signature: row.signature, operationId: row.operation_id, wire: row.wire, blockhash: row.blockhash, lastValidBlockHeight: row.last_valid_height, state: row.state, receipt: row.receipt ? JSON.parse(row.receipt) : null }));
    },
  };
  return store;
}

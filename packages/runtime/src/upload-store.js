import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { publicJson, RecoveryStorageError } from './store.js';

export const UPLOAD_BYTE_LIMIT = 20 * 1024 * 1024;
export const uploadDigest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failure = (code, message) => Object.assign(new Error(message), { code });
const states = { prepared: ['funded', 'uploading'], funded: ['uploading'], uploading: ['confirmed'], confirmed: [] };

// Public asset bytes and signed data items share the profile's durable store.
// Signer material remains with the supplied host signer.
export function createUploadStore({ owner, store }) {
  if (store.directory !== owner.profile) throw new TypeError('Use the owned profile for upload recovery');
  const directory = path.join(store.directory, 'upload-data'), records = store.collection('runtime-uploads/v1');
  const syncDirectory = (name) => {
    if (process.platform === 'win32') return;
    const fd = fs.openSync(name, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const disk = (fn) => {
    owner.assertActive();
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error('Use the profile upload directory');
      return fn();
    } catch (cause) { throw new RecoveryStorageError('Preserve the upload bytes and recover storage before spending.', { cause }); }
  };
  const read = (digest) => disk(() => {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError('Use the saved upload content digest');
    const file = path.join(directory, digest);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > UPLOAD_BYTE_LIMIT) throw new Error('Read a bounded regular upload file');
      const bytes = fs.readFileSync(fd);
      if (uploadDigest(bytes) !== digest) throw new Error('The saved upload bytes require recovery');
      return bytes;
    } finally { fs.closeSync(fd); }
  });
  const get = (id) => records.load().find((record) => record.id === id) || null;
  return {
    get,
    read,
    active: (walletPublicKey) => records.load().find((record) => record.walletPublicKey === walletPublicKey && record.state !== 'confirmed') || null,
    put(bytes) {
      if (!(bytes instanceof Uint8Array) || bytes.length > UPLOAD_BYTE_LIMIT) throw new TypeError('Use bounded public upload bytes');
      const digest = uploadDigest(bytes);
      disk(() => {
        const file = path.join(directory, digest);
        let exists = false;
        try { fs.lstatSync(file); exists = true; } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
        if (exists) {
          read(digest);
          const fd = fs.openSync(file, 'r');
          try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        } else {
          const temporary = path.join(directory, `${digest}.${randomUUID()}.tmp`);
          const fd = fs.openSync(temporary, 'wx', 0o600);
          try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          fs.renameSync(temporary, file);
        }
        syncDirectory(directory); syncDirectory(store.directory);
      });
      return digest;
    },
    prepare(record) {
      owner.assertActive();
      read(record.plan.wireDigest);
      return records.transaction(() => {
        const all = records.load(), existing = all.find((value) => value.id === record.id);
        if (existing) {
          if (publicJson(existing.plan) !== publicJson(record.plan)) throw failure('OPERATION_CONFLICT', 'Use the saved upload plan');
          return existing;
        }
        if (all.some((value) => value.walletPublicKey === record.walletPublicKey && value.state !== 'confirmed')) throw failure('OPERATION_IN_FLIGHT', 'Recover the active wallet upload first');
        store.reserveWalletWorkflow({ id: record.id, walletPublicKey: record.walletPublicKey, kind: 'storage-upload', context: record.plan });
        const saved = { ...record, state: 'prepared', fundingReceipt: null, fundingAcknowledged: false, receipt: null, approvals: [] };
        records.save([...all, saved]); return saved;
      });
    },
    recordApproval(id, approval) {
      owner.assertActive();
      return records.transaction(() => {
        const all = records.load(), index = all.findIndex((value) => value.id === id), job = all[index];
        if (!job || !approval?.id) throw new Error('Use a prepared upload and complete approval');
        const prior = job.approvals.find((value) => value.id === approval.id);
        if (prior) {
          if (publicJson(prior) !== publicJson(approval)) throw failure('OPERATION_CONFLICT', 'Preserve the original upload approval');
          return;
        }
        all[index] = { ...job, approvals: [...job.approvals, JSON.parse(publicJson(approval))] };
        records.save(all);
      });
    },
    update(id, patch) {
      owner.assertActive();
      return records.transaction(() => {
        const all = records.load(), index = all.findIndex((value) => value.id === id), prior = all[index];
        if (!prior) throw new Error('Prepare the upload before updating recovery');
        if (Object.keys(patch).some((key) => !['state', 'fundingReceipt', 'fundingAcknowledged', 'receipt'].includes(key))) throw new Error('Preserve the saved upload identity and plan');
        const state = patch.state || prior.state;
        if (state !== prior.state && !states[prior.state]?.includes(state)) throw failure('INVALID_TRANSITION', 'Use a valid upload recovery transition');
        const saved = { ...prior, ...patch };
        if (prior.state === 'confirmed' && publicJson(saved) !== publicJson(prior)) throw failure('OPERATION_CONFLICT', 'Preserve the confirmed upload receipt');
        if (state === 'confirmed' && !saved.receipt) throw new Error('Save the verified storage receipt before completion');
        all[index] = saved; records.save(all);
        if (state === 'confirmed') store.finishWalletWorkflow(id, saved.receipt);
        return saved;
      });
    },
  };
}

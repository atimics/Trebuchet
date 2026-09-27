// nftService.js
//
// Chain work for NFT collections: grind asset keys, upload metadata to
// Arweave, create the Metaplex Core collection and assets, and verify them.
//
// Every asset and the collection are signed by raw Ed25519 scalars from
// split-key grinding. umi only needs a Signer, so scalarUmiSigner() adapts
// signWithScalar() to that interface; nothing else changes about the
// transactions.
//
// Jobs (grind, run) run in the background inside the local server. Their
// progress is kept in memory for polling; everything that must survive a
// restart (keys, URIs, signatures) is written to the collection record as it
// happens, so a rerun skips finished work.

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  keypairIdentity,
  publicKey as umiPublicKey,
  addTransactionSignature,
  createGenericFile,
} from '@metaplex-foundation/umi';
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys';
import {
  mplCore,
  create as createAsset,
  createCollection,
  fetchCollectionV1,
  deserializeAssetV1,
  ruleSet,
} from '@metaplex-foundation/mpl-core';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  createSplitSecret,
  combineSplitKey,
  scalarPublicKey,
  signWithScalar,
  base58Encode,
} from '@trebuchet/core/split-key';
import {
  addressMatchesVanity,
  nftMetadataJson,
  nftCostModel,
  vanityPatternAttempts,
  DEFAULT_GRIND_KEYS_PER_SEC,
  LAMPORTS_PER_SOL,
} from '@trebuchet/core/nft-plan';
import { generateVanityKeypair, cancelVanityGrind } from './vanityKeygen.js';
import * as store from './nftCollectionStore.js';
import {
  samplePriorityFeeMicroLamports,
  umiComputeBudgetIxs,
  priorityFeeLamports,
} from './priorityFees.js';
import { DEFAULT_IRYS_ADDRESS, DEVNET_IRYS_ADDRESS, networkImageUri } from './metadataUploadService.js';

export const CORE_CREATE_COMPUTE_UNITS = 60_000;
const MINT_CONCURRENCY = 4;
const VERIFY_CHUNK = 100;

const jobs = new Map();
let lastGrindRate = null;

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

export function grindRate() {
  return lastGrindRate || DEFAULT_GRIND_KEYS_PER_SEC;
}

export function jobStatus(id) {
  const job = jobs.get(id);
  if (!job) return null;
  const { cancel, ...rest } = job;
  return rest;
}

function startJob(id, kind, runner) {
  const existing = jobs.get(id);
  if (existing && existing.status === 'running') {
    throw Object.assign(new Error(`A ${existing.kind} job is already running for this collection`), { statusCode: 409 });
  }
  if (kind === 'grind') {
    for (const job of jobs.values()) {
      if (job.kind === 'grind' && job.status === 'running') {
        throw Object.assign(new Error('Another collection is grinding. Wait or cancel it.'), { statusCode: 409 });
      }
    }
  }
  const job = {
    kind,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    step: null,
    done: 0,
    total: 0,
    detail: null,
    error: null,
    cancelled: false,
  };
  job.cancel = () => {
    job.cancelled = true;
    if (kind === 'grind') cancelVanityGrind();
  };
  jobs.set(id, job);
  Promise.resolve()
    .then(() => runner(job))
    .then(() => {
      job.status = job.cancelled ? 'cancelled' : 'done';
    })
    .catch((error) => {
      job.status = job.cancelled || error?.code === 'CANCELLED' ? 'cancelled' : 'failed';
      job.error = job.status === 'failed' ? (error?.message || String(error)) : null;
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
    });
  return jobStatus(id);
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  job.cancel();
  return true;
}

export function isBusy(id) {
  return jobs.get(id)?.status === 'running';
}

/**
 * Coalesce per-item record changes. A collection of 10k items is several MB
 * of JSON; rewriting it after every item would dominate a run. Changes are
 * queued and written together every `every` changes or `ms` milliseconds.
 * Anything lost in a crash is recoverable: keys are re-ground, and uploads
 * or mints are re-checked against chain before they are redone.
 */
function batchedWriter(id, { every = 25, ms = 2000 } = {}) {
  let queue = [];
  let last = Date.now();
  const flush = () => {
    if (!queue.length) return;
    const pending = queue;
    queue = [];
    last = Date.now();
    store.update(id, (r) => {
      for (const change of pending) change(r);
    });
  };
  return {
    apply(change) {
      queue.push(change);
      if (queue.length >= every || Date.now() - last >= ms) flush();
    },
    flush,
  };
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** A umi Signer backed by a raw Ed25519 scalar (split-key result). */
export function scalarUmiSigner(scalar) {
  const bytes = Uint8Array.from(scalar);
  const pk = umiPublicKey(base58Encode(scalarPublicKey(bytes)));
  return {
    publicKey: pk,
    async signMessage(message) {
      return signWithScalar(bytes, message);
    },
    async signTransaction(transaction) {
      return addTransactionSignature(transaction, signWithScalar(bytes, transaction.serializedMessage), pk);
    },
    async signAllTransactions(transactions) {
      return Promise.all(transactions.map((tx) => this.signTransaction(tx)));
    },
  };
}

/**
 * One new key. With no pattern the customer's own scalar is the key; with a
 * pattern the grinder walks offsets from the public point only.
 */
export async function grindOneKey(vanity, { onProgress } = {}) {
  const { secretScalar, publicPoint } = createSplitSecret();
  if (!vanity || vanity.mode === 'none') {
    return { scalar: secretScalar, address: base58Encode(publicPoint), attempts: 1, elapsedSec: 0 };
  }
  const result = await generateVanityKeypair({
    prefix: vanity.mode === 'prefix' ? vanity.pattern : undefined,
    suffix: vanity.mode === 'suffix' ? vanity.pattern : undefined,
    caseInsensitive: vanity.caseInsensitive,
    splitPoint: hex(publicPoint),
    onProgress,
  });
  const combined = combineSplitKey({
    secretScalar,
    publicPoint,
    offset: Uint8Array.from(Buffer.from(result.offset, 'hex')),
  });
  if (combined.address !== result.publicKey || !addressMatchesVanity(combined.address, vanity)) {
    throw new Error('Grinder returned an offset that does not produce the pattern');
  }
  if (Number(result.elapsedSec) > 0.2 && Number(result.attempts) > 0) {
    lastGrindRate = Number(result.attempts) / Number(result.elapsedSec);
  }
  return {
    scalar: combined.scalar,
    address: combined.address,
    attempts: Number(result.attempts) || null,
    elapsedSec: Number(result.elapsedSec) || null,
  };
}

function patternLabel(vanity) {
  return vanity && vanity.mode !== 'none'
    ? `${vanity.mode}:${vanity.pattern}${vanity.caseInsensitive ? ':any-case' : ''}`
    : 'none';
}

/** Grind the collection key (if missing) and every item key still missing. */
export function startGrind(id) {
  return startJob(id, 'grind', async (job) => {
    const record = store.get(id);
    const { collectionVanity, itemVanity } = record.config;
    const needCollection = !record.collectionKey;
    const itemIndexes = record.items.filter((item) => !item.key).map((item) => item.index);
    job.total = (needCollection ? 1 : 0) + itemIndexes.length;
    job.expectedAttemptsEach = vanityPatternAttempts(itemVanity);

    if (needCollection) {
      job.step = 'collection';
      job.detail = 'Collection address';
      const key = await grindOneKey(collectionVanity, {
        onProgress: ({ attempts }) => { job.attempts = attempts; },
      });
      if (job.cancelled) return;
      store.update(id, (r) => {
        r.collectionKey = store.keyRecord({ ...key, pattern: patternLabel(collectionVanity) });
      });
      job.done += 1;
      job.lastAddress = key.address;
    }

    job.step = 'items';
    const writer = batchedWriter(id, { every: 100 });
    try {
      for (const index of itemIndexes) {
        if (job.cancelled) return;
        job.detail = `Item #${index}`;
        const key = await grindOneKey(itemVanity);
        if (job.cancelled) return;
        const keyRecord = store.keyRecord({ ...key, pattern: patternLabel(itemVanity) });
        writer.apply((r) => {
          const item = r.items.find((it) => it.index === index);
          if (item && !item.key) item.key = keyRecord;
        });
        job.done += 1;
        job.lastAddress = key.address;
        job.rate = grindRate();
      }
    } finally {
      writer.flush();
    }
  });
}

// ---------------------------------------------------------------------------
// umi and uploads
// ---------------------------------------------------------------------------

function isLocalRpc(rpcUrl) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(String(rpcUrl));
}

export function createNftUmi({ rpcUrl, payerSecretKey }) {
  const umi = createUmi(rpcUrl, { commitment: 'confirmed' }).use(mplCore());
  const keypair = umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(payerSecretKey));
  umi.use(keypairIdentity(keypair));
  if (isLocalRpc(rpcUrl) && process.env.TREBUCHET_NFT_LOCAL_UPLOADER === '1') {
    umi.uploader = localTestUploader();
  } else {
    const address = rpcUrl.includes('devnet') ? DEVNET_IRYS_ADDRESS : DEFAULT_IRYS_ADDRESS;
    umi.use(irysUploader({ address, timeout: 120000 }));
  }
  return umi;
}

// Localnet only (tests): content-addressed fake URIs, no network. Arweave
// cannot serve a local validator, so this is the only way to exercise the
// full run offline. Never used unless the RPC is localhost AND the env flag
// is set.
function localTestUploader() {
  const uriFor = (bytes) => `https://local.invalid/${Buffer.from(bytes).subarray(0, 16).toString('hex')}-${bytes.length}`;
  return {
    async upload(files) {
      return files.map((f) => uriFor(f.buffer));
    },
    async uploadJson(json) {
      return uriFor(Buffer.from(JSON.stringify(json)));
    },
    async getUploadPrice() {
      return { basisPoints: 0n, identifier: 'SOL', decimals: 9 };
    },
    async getUploadPriceFromBytes() {
      return { basisPoints: 0n, identifier: 'SOL', decimals: 9 };
    },
    async fund() {},
    async getBalance() {
      return { basisPoints: 0n, identifier: 'SOL', decimals: 9 };
    },
  };
}

function imageFile(id, name, type) {
  const bytes = store.readImage(id, name, type);
  if (!bytes) throw new Error(`Image ${name}.${type} is missing; import it again.`);
  return createGenericFile(bytes, `${name}.${type}`, { contentType: `image/${type}` });
}

/** Bytes still to upload (images + a JSON allowance per item). */
export function pendingUploadBytes(record) {
  let bytes = 0;
  if (!record.collectionMetadataUri) bytes += (record.cover?.bytes || 0) + 2048;
  for (const item of record.items) {
    if (!item.metadataUri) bytes += (item.imageUri ? 0 : item.imageBytes || 0) + 2048;
  }
  return bytes;
}

export async function storagePriceLamports(umi, bytes) {
  if (bytes <= 0) return 0;
  const price = umi.uploader.getUploadPriceFromBytes
    ? await umi.uploader.getUploadPriceFromBytes(bytes)
    : { basisPoints: 0n };
  return Number(price.basisPoints);
}

// ---------------------------------------------------------------------------
// Estimate
// ---------------------------------------------------------------------------

export async function estimate(id, { rpcUrl, payerSecretKey, walletPublicKey }) {
  const record = store.get(id);
  const umi = createNftUmi({ rpcUrl, payerSecretKey });
  const connection = new Connection(rpcUrl, 'confirmed');
  const bytes = pendingUploadBytes(record);
  let storageLamports = null;
  let storageError = null;
  try {
    storageLamports = await storagePriceLamports(umi, bytes);
  } catch (error) {
    storageError = error?.message || String(error);
  }
  const microLamports = await samplePriorityFeeMicroLamports(connection);
  const mintedCount = record.items.filter((item) => item.mintSignature).length;
  const model = nftCostModel({
    itemCount: record.items.length,
    collectionCreated: Boolean(record.collectionSignature),
    mintedCount,
    storageLamports,
    priorityLamportsEach: priorityFeeLamports(CORE_CREATE_COMPUTE_UNITS, microLamports),
  });
  const balanceLamports = await connection.getBalance(new PublicKey(walletPublicKey));
  return {
    ...model,
    uploadBytes: bytes,
    storageError,
    priorityMicroLamports: microLamports,
    balanceSol: balanceLamports / LAMPORTS_PER_SOL,
    shortfallSol: Math.max(0, model.totalLamports - balanceLamports) / LAMPORTS_PER_SOL,
    walletPublicKey,
    estimatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Run: upload, create collection, mint
// ---------------------------------------------------------------------------

function sigString(result) {
  return bs58.encode(Buffer.from(result.signature));
}

async function accountExists(connection, address) {
  return Boolean(await connection.getAccountInfo(new PublicKey(address), 'confirmed'));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

async function uploadMetadata(id, umi, job, rpcUrl) {
  let record = store.get(id);
  const { config } = record;
  job.step = 'upload';
  job.total = record.items.length + 1;
  job.done = record.items.filter((it) => it.metadataUri).length + (record.collectionMetadataUri ? 1 : 0);

  const bytes = pendingUploadBytes(record);
  if (bytes > 0 && umi.uploader.fund) {
    job.detail = 'Funding Arweave upload';
    const price = await umi.uploader.getUploadPriceFromBytes(bytes);
    await umi.uploader.fund(price, false);
  }

  if (!record.collectionMetadataUri) {
    job.detail = 'Collection metadata';
    let imageUri = record.collectionImageUri;
    if (!imageUri && record.cover) {
      [imageUri] = await withTimeout(umi.uploader.upload([imageFile(id, 'cover', record.cover.type)]), 120000, 'Cover upload');
      imageUri = networkImageUri(imageUri, rpcUrl);
      store.update(id, (r) => { r.collectionImageUri = imageUri; });
    }
    const json = nftMetadataJson({
      name: config.name,
      symbol: config.symbol,
      description: config.description,
      imageUri: imageUri || '',
      imageType: record.cover?.type,
      externalUrl: config.externalUrl,
      royaltyBps: config.royaltyBps,
      creators: config.creators,
    });
    const uri = await withTimeout(umi.uploader.uploadJson(json), 120000, 'Collection JSON upload');
    store.update(id, (r) => { r.collectionMetadataUri = uri; });
    job.done += 1;
  }

  record = store.get(id);
  const writer = batchedWriter(id, { every: 10 });
  try {
    await uploadItems(record, umi, job, rpcUrl, writer);
  } finally {
    writer.flush();
  }
}

async function uploadItems(record, umi, job, rpcUrl, writer) {
  const { id, config } = record;
  for (const item of record.items) {
    if (job.cancelled) return;
    if (item.metadataUri) continue;
    job.detail = `Item #${item.index}`;
    let imageUri = item.imageUri;
    if (!imageUri) {
      [imageUri] = await withTimeout(umi.uploader.upload([imageFile(id, String(item.index), item.imageType)]), 120000, `Image #${item.index} upload`);
      imageUri = networkImageUri(imageUri, rpcUrl);
      writer.apply((r) => { r.items.find((it) => it.index === item.index).imageUri = imageUri; });
    }
    const json = nftMetadataJson({
      name: item.name,
      symbol: config.symbol,
      description: item.description || config.description,
      imageUri,
      imageType: item.imageType,
      attributes: item.attributes,
      externalUrl: config.externalUrl,
      royaltyBps: config.royaltyBps,
      creators: config.creators,
    });
    const uri = await withTimeout(umi.uploader.uploadJson(json), 120000, `JSON #${item.index} upload`);
    writer.apply((r) => { r.items.find((it) => it.index === item.index).metadataUri = uri; });
    job.done += 1;
  }
}

function royaltiesPlugin(config) {
  return {
    type: 'Royalties',
    basisPoints: config.royaltyBps,
    creators: config.creators.map((c) => ({ address: umiPublicKey(c.address), percentage: c.percentage })),
    ruleSet: ruleSet('None'),
  };
}

async function createCollectionStep(id, umi, connection, job, computeIxs) {
  const record = store.get(id);
  if (record.collectionSignature) return;
  job.step = 'collection';
  job.detail = 'Create collection';
  const scalar = store.keyScalar(record.collectionKey);
  if (!scalar) throw new Error('Collection key is missing or locked. Unlock your PIN or grind it again.');
  const address = record.collectionKey.address;
  if (await accountExists(connection, address)) {
    // A previous attempt landed but its signature was not recorded.
    store.update(id, (r) => { r.collectionSignature = 'confirmed-before-record'; });
    return;
  }
  const result = await createCollection(umi, {
    collection: scalarUmiSigner(scalar),
    name: record.config.name,
    uri: record.collectionMetadataUri,
    plugins: record.config.creators.length ? [royaltiesPlugin(record.config)] : [],
  }).prepend(computeIxs).sendAndConfirm(umi, { confirm: { commitment: 'confirmed' } });
  store.update(id, (r) => {
    r.collectionSignature = sigString(result);
    r.collectionCreatedAt = new Date().toISOString();
  });
}

async function mintItems(id, umi, connection, job, computeIxs, { minBalanceLamports }) {
  const record = store.get(id);
  const collectionAddress = umiPublicKey(record.collectionKey.address);
  const collection = await fetchCollectionV1(umi, collectionAddress);
  const owner = record.config.ownerAddress ? umiPublicKey(record.config.ownerAddress) : undefined;
  const byIndex = new Map(record.items.map((it) => [it.index, it]));
  const queue = record.items.filter((it) => !it.mintSignature).map((it) => it.index);
  job.step = 'mint';
  job.total = record.items.length;
  job.done = record.items.length - queue.length;
  job.failed = 0;
  const payer = new PublicKey(umi.identity.publicKey.toString());
  const writer = batchedWriter(id, { every: 20 });
  let halt = null;

  const recordMint = (index, signature) => writer.apply((r) => {
    const it = r.items.find((x) => x.index === index);
    it.mintSignature = it.mintSignature || signature;
    it.mintedAt = it.mintedAt || new Date().toISOString();
    it.mintError = null;
  });

  const mintOne = async (index) => {
    const item = byIndex.get(index);
    if (!item?.key) throw new Error(`Item #${index} has no address`);
    if (!item.metadataUri) throw new Error(`Item #${index} has no metadata URI`);
    if (await accountExists(connection, item.key.address)) {
      // Landed earlier but the signature was never recorded.
      recordMint(index, 'confirmed-before-record');
      return;
    }
    const scalar = store.keyScalar(item.key);
    if (!scalar) throw new Error(`Item #${index} key is locked or missing`);
    const result = await createAsset(umi, {
      asset: scalarUmiSigner(scalar),
      collection,
      name: item.name,
      uri: item.metadataUri,
      ...(owner ? { owner } : {}),
    }).prepend(computeIxs).sendAndConfirm(umi, { confirm: { commitment: 'confirmed' } });
    recordMint(index, sigString(result));
  };

  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length && !job.cancelled && !halt) {
      const index = queue[cursor++];
      job.detail = `Item #${index}`;
      if (minBalanceLamports > 0 && (await connection.getBalance(payer)) < minBalanceLamports) {
        halt = new Error('The run reached its approved spend cap. Estimate again and approve a new cap to continue.');
        return;
      }
      try {
        await mintOne(index);
        job.done += 1;
      } catch (error) {
        job.failed += 1;
        writer.apply((r) => {
          const it = r.items.find((x) => x.index === index);
          if (it) it.mintError = String(error?.message || error).slice(0, 300);
        });
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: MINT_CONCURRENCY }, worker));
  } finally {
    writer.flush();
  }
  if (halt) throw halt;
  const failed = store.get(id).items.filter((it) => !it.mintSignature).length;
  if (failed && !job.cancelled) job.detail = `${failed} item${failed === 1 ? '' : 's'} not minted; run again to retry`;
}

export function startRun(id, { rpcUrl, payerSecretKey, maxSpendSol }) {
  return startJob(id, 'run', async (job) => {
    const umi = createNftUmi({ rpcUrl, payerSecretKey });
    const connection = new Connection(rpcUrl, 'confirmed');
    const genesisHash = await connection.getGenesisHash();
    const record = store.get(id);
    if (record.genesisHash && record.genesisHash !== genesisHash) {
      throw new Error('This collection was started on a different network. Switch the RPC back first.');
    }
    if (!record.genesisHash) store.update(id, (r) => { r.genesisHash = genesisHash; });
    const walletPublicKey = umi.identity.publicKey.toString();
    if (record.walletPublicKey && record.walletPublicKey !== walletPublicKey) {
      throw new Error(`This collection is signed by ${record.walletPublicKey}. Use that wallet.`);
    }
    store.update(id, (r) => {
      r.walletPublicKey = walletPublicKey;
      r.run = { startedAt: job.startedAt, maxSpendSol };
    });

    const balanceAtStart = await connection.getBalance(new PublicKey(walletPublicKey));
    const minBalanceLamports = Number.isFinite(maxSpendSol) && maxSpendSol > 0
      ? Math.max(0, balanceAtStart - Math.round(maxSpendSol * LAMPORTS_PER_SOL))
      : 0;

    const microLamports = await samplePriorityFeeMicroLamports(connection);
    const computeIxs = umiComputeBudgetIxs({ units: CORE_CREATE_COMPUTE_UNITS, microLamports });

    await uploadMetadata(id, umi, job, rpcUrl);
    if (job.cancelled) return;
    await createCollectionStep(id, umi, connection, job, computeIxs);
    if (job.cancelled) return;
    await mintItems(id, umi, connection, job, computeIxs, { minBalanceLamports });
    const spent = (balanceAtStart - (await connection.getBalance(new PublicKey(walletPublicKey)))) / LAMPORTS_PER_SOL;
    store.update(id, (r) => {
      r.run = { ...r.run, finishedAt: new Date().toISOString(), spentSol: spent + Number(r.run?.priorSpentSol || 0) };
    });
    job.spentSol = spent;
  });
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

function updateAuthorityAddress(ua) {
  return ua?.address ? ua.address.toString() : null;
}

async function uriResolves(uri) {
  if (!/^https:\/\//.test(uri) || uri.startsWith('https://local.invalid/')) return null;
  try {
    const response = await fetch(uri, { method: 'GET', signal: AbortSignal.timeout(15000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function verify(id, { rpcUrl, checkUris = true }) {
  const record = store.get(id);
  const umi = createUmi(rpcUrl, { commitment: 'confirmed' }).use(mplCore());
  const connection = new Connection(rpcUrl, 'confirmed');
  const { config } = record;
  const checks = {
    collection: { ok: false, detail: null },
    pattern: { passed: 0, failed: [] },
    membership: { passed: 0, failed: [] },
    name: { passed: 0, failed: [] },
    uri: { passed: 0, failed: [] },
    owner: { passed: 0, failed: [] },
    uriResolves: { passed: 0, failed: [], skipped: 0 },
    supply: { onChain: 0, expected: record.items.length },
  };

  if (record.collectionKey) {
    try {
      const collection = await fetchCollectionV1(umi, umiPublicKey(record.collectionKey.address));
      const royalties = collection.royalties;
      const royaltyOk = config.creators.length === 0 || royalties?.basisPoints === config.royaltyBps;
      checks.collection = {
        ok: collection.uri === record.collectionMetadataUri && collection.name === config.name && royaltyOk,
        name: collection.name,
        uri: collection.uri,
        royaltyBps: royalties?.basisPoints ?? null,
        updateAuthority: collection.updateAuthority.toString(),
        numMinted: collection.numMinted,
        currentSize: collection.currentSize,
        patternOk: addressMatchesVanity(record.collectionKey.address, config.collectionVanity),
        detail: royaltyOk ? null : 'Royalties plugin does not match the config',
      };
    } catch (error) {
      checks.collection = { ok: false, detail: error?.message || 'Collection not found on chain' };
    }
  }

  const minted = record.items.filter((it) => it.key);
  const expectedOwner = config.ownerAddress || record.walletPublicKey;
  for (let i = 0; i < minted.length; i += VERIFY_CHUNK) {
    const chunk = minted.slice(i, i + VERIFY_CHUNK);
    const infos = await connection.getMultipleAccountsInfo(chunk.map((it) => new PublicKey(it.key.address)), 'confirmed');
    chunk.forEach((item, j) => {
      const info = infos[j];
      if (!info) return;
      checks.supply.onChain += 1;
      let asset;
      try {
        asset = deserializeAssetV1({
          publicKey: umiPublicKey(item.key.address),
          executable: info.executable,
          owner: umiPublicKey(info.owner.toBase58()),
          lamports: { basisPoints: BigInt(info.lamports), identifier: 'SOL', decimals: 9 },
          data: Uint8Array.from(info.data),
        });
      } catch {
        checks.membership.failed.push(item.index);
        return;
      }
      const push = (key, ok) => (ok ? checks[key].passed++ : checks[key].failed.push(item.index));
      push('pattern', addressMatchesVanity(item.key.address, config.itemVanity));
      push('membership', asset.updateAuthority.type === 'Collection'
        && updateAuthorityAddress(asset.updateAuthority) === record.collectionKey?.address);
      push('name', asset.name === item.name);
      push('uri', asset.uri === item.metadataUri);
      push('owner', !expectedOwner || asset.owner.toString() === expectedOwner);
    });
  }

  if (checkUris) {
    const uris = [record.collectionMetadataUri, ...minted.map((it) => it.metadataUri)].filter(Boolean);
    let cursor = 0;
    const worker = async () => {
      while (cursor < uris.length) {
        const uri = uris[cursor++];
        const ok = await uriResolves(uri);
        if (ok === null) checks.uriResolves.skipped++;
        else if (ok) checks.uriResolves.passed++;
        else checks.uriResolves.failed.push(uri);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  }

  const allItems = record.items.length;
  const itemOk = (key) => checks[key].passed === allItems && checks[key].failed.length === 0;
  const passed = checks.collection.ok
    && checks.supply.onChain === allItems
    && ['pattern', 'membership', 'name', 'uri', 'owner'].every(itemOk)
    && checks.uriResolves.failed.length === 0;
  const verification = {
    passed,
    checkedAt: new Date().toISOString(),
    genesisHash: await connection.getGenesisHash(),
    checks,
  };
  store.update(id, (r) => { r.verification = verification; });
  return verification;
}

/** A self-contained proof document: config, addresses, signatures, checks. */
export function proofDocument(id) {
  const record = store.publicView(store.get(id));
  return {
    schema: 'trebuchet.nft-collection-proof.v1',
    generatedAt: new Date().toISOString(),
    standard: 'metaplex-core',
    genesisHash: record.genesisHash,
    config: record.config,
    wallet: record.walletPublicKey,
    collection: {
      address: record.collectionKey?.address || null,
      metadataUri: record.collectionMetadataUri,
      signature: record.collectionSignature,
    },
    items: record.items.map((it) => ({
      index: it.index,
      name: it.name,
      address: it.address,
      metadataUri: it.metadataUri || null,
      signature: it.mintSignature || null,
    })),
    verification: record.verification,
  };
}

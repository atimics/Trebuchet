// nftRoutes.js
//
// Local API for the v2 NFTs view. Registered from server.js with the
// server's own helpers so session, PIN and demo rules match the launcher.
//
// Money moves only in POST /run, which needs an unlocked PIN, a managed
// wallet, and a spend cap the renderer showed the operator.

import express from 'express';
import {
  normalizeCollectionConfig,
  collectionConfigIssues,
  normalizeItems,
  itemReviewIssues,
  traitDistribution,
  vanityOddsTable,
  vanityPatternAttempts,
  addressMatchesVanity,
  nftCostModel,
  isSolanaAddress,
} from '@trebuchet/core/nft-plan';
import { detectLogoImageMime } from '@trebuchet/core/validators';
import * as store from './nftCollectionStore.js';
import * as nftService from './nftService.js';

function detectImageType(bytes) {
  const mime = detectLogoImageMime(bytes);
  if (mime) return mime.replace('image/', '');
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF'
      && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function httpError(status, message, code) {
  return Object.assign(new Error(message), { statusCode: status, ...(code ? { code } : {}) });
}

function onChainStarted(record) {
  return Boolean(record.collectionSignature || record.items.some((it) => it.mintSignature));
}

function summary(record) {
  const minted = record.items.filter((it) => it.mintSignature).length;
  const ground = record.items.filter((it) => it.key).length;
  const uploaded = record.items.filter((it) => it.metadataUri).length;
  return {
    id: record.id,
    name: record.config.name,
    symbol: record.config.symbol,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    itemCount: record.items.length,
    ground,
    uploaded,
    minted,
    collectionAddress: record.collectionKey?.address || null,
    collectionCreated: Boolean(record.collectionSignature),
    verified: record.verification?.passed === true,
    job: nftService.jobStatus(record.id),
  };
}

function detail(record) {
  const view = store.publicView(record);
  const issues = collectionConfigIssues(record.config);
  const review = itemReviewIssues(record.items);
  const cost = nftCostModel({
    itemCount: record.items.length,
    collectionCreated: Boolean(record.collectionSignature),
    mintedCount: record.items.filter((it) => it.mintSignature).length,
  });
  return {
    ...view,
    summary: summary(record),
    configIssues: issues,
    review,
    traits: traitDistribution(record.items),
    cost,
    grind: {
      keysPerSec: nftService.grindRate(),
      collectionAttempts: vanityPatternAttempts(record.config.collectionVanity),
      itemAttempts: vanityPatternAttempts(record.config.itemVanity),
    },
    images: {
      cover: record.cover ? store.hasImage(record.id, 'cover', record.cover.type) : false,
      missing: record.items.filter((it) => !it.imageType || !store.hasImage(record.id, String(it.index), it.imageType)).map((it) => it.index),
    },
    job: nftService.jobStatus(record.id),
  };
}

export function registerNftRoutes(app, deps) {
  const {
    isDemoMode,
    rejectIfSecretPinLocked,
    sendErrorResponse,
    getRpcUrl,
    getManagedWallet,
  } = deps;

  const route = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      sendErrorResponse(res, error, error?.statusCode || 500);
    }
  };

  const rejectIfDemo = (res) => {
    if (!isDemoMode()) return false;
    res.status(409).json({
      success: false,
      code: 'NFT_PRACTICE_MODE',
      error: 'NFT minting needs a live network. Turn off practice mode in Settings.',
    });
    return true;
  };

  const payerFor = (walletPublicKey) => {
    if (!isSolanaAddress(walletPublicKey)) throw httpError(400, 'walletPublicKey required');
    const wallet = getManagedWallet(walletPublicKey);
    if (!wallet || !Array.isArray(wallet.secretKey)) {
      throw httpError(404, 'That wallet is not a Trebuchet-managed wallet with a stored key.');
    }
    return wallet.secretKey;
  };

  const rejectIfBusy = (id) => {
    if (nftService.isBusy(id)) throw httpError(409, 'A job is running for this collection. Wait or cancel it.', 'NFT_JOB_RUNNING');
  };

  app.get('/api/v2/nfts', route(async (_req, res) => {
    res.json({ success: true, collections: store.list().map(summary) });
  }));

  app.post('/api/v2/nfts', route(async (req, res) => {
    const config = normalizeCollectionConfig(req.body?.config || {});
    const record = store.create(config);
    res.json({ success: true, collection: detail(record) });
  }));

  // Cheap status for polling while a job runs; the full detail can be MBs.
  app.get('/api/v2/nfts/:id/job', route(async (req, res) => {
    const record = store.get(req.params.id);
    res.json({ success: true, job: nftService.jobStatus(record.id), summary: summary(record) });
  }));

  app.get('/api/v2/nfts/:id', route(async (req, res) => {
    res.json({ success: true, collection: detail(store.get(req.params.id)) });
  }));

  app.delete('/api/v2/nfts/:id', route(async (req, res) => {
    const record = store.get(req.params.id);
    rejectIfBusy(record.id);
    if (onChainStarted(record) && req.body?.confirmAddress !== record.collectionKey?.address) {
      throw httpError(409, 'This collection is on chain. Type its collection address to remove the local record.', 'NFT_CONFIRM_REQUIRED');
    }
    store.remove(record.id);
    res.json({ success: true });
  }));

  app.put('/api/v2/nfts/:id/config', route(async (req, res) => {
    const record = store.get(req.params.id);
    rejectIfBusy(record.id);
    const next = normalizeCollectionConfig({ ...record.config, ...(req.body?.config || {}) });
    if (req.body?.config && 'ownerAddress' in req.body.config) {
      const owner = String(req.body.config.ownerAddress || '').trim();
      if (owner && !isSolanaAddress(owner)) throw httpError(400, 'Owner must be a Solana address.');
      next.ownerAddress = owner || null;
    } else {
      next.ownerAddress = record.config.ownerAddress || null;
    }
    if (record.collectionSignature) {
      for (const key of ['name', 'royaltyBps', 'creators', 'collectionVanity']) {
        if (JSON.stringify(next[key]) !== JSON.stringify(record.config[key])) {
          throw httpError(409, 'The collection is on chain; its name, royalties, creators and address are fixed.');
        }
      }
    }
    if (record.items.some((it) => it.mintSignature) && JSON.stringify(next.itemVanity) !== JSON.stringify(record.config.itemVanity)) {
      throw httpError(409, 'Items are already minted with the current item pattern.');
    }
    const updated = store.update(record.id, (r) => {
      r.config = next;
      // Keys that no longer fit their pattern are discarded before anything uses them.
      if (r.collectionKey && !r.collectionSignature && !addressMatchesVanity(r.collectionKey.address, next.collectionVanity)) {
        r.collectionKey = null;
      }
      for (const item of r.items) {
        if (item.key && !item.mintSignature && !addressMatchesVanity(item.key.address, next.itemVanity)) item.key = null;
      }
      if (JSON.stringify(next) !== JSON.stringify(record.config)) {
        r.collectionMetadataUri = r.collectionSignature ? r.collectionMetadataUri : null;
      }
    });
    res.json({ success: true, collection: detail(updated) });
  }));

  app.post('/api/v2/nfts/:id/items', route(async (req, res) => {
    const record = store.get(req.params.id);
    rejectIfBusy(record.id);
    if (record.items.some((it) => it.mintSignature || it.metadataUri)) {
      throw httpError(409, 'Items are already uploaded or minted; they cannot be replaced.');
    }
    const items = normalizeItems(req.body?.items || []);
    const updated = store.update(record.id, (r) => {
      const oldKeys = new Map(r.items.map((it) => [it.index, it.key]));
      r.items = items.map((item) => ({ ...item, key: oldKeys.get(item.index) || null }));
      r.verification = null;
    });
    res.json({ success: true, collection: detail(updated) });
  }));

  app.post('/api/v2/nfts/:id/items/accept', route(async (req, res) => {
    const indexes = new Set((Array.isArray(req.body?.indexes) ? req.body.indexes : []).map(Number));
    const updated = store.update(req.params.id, (r) => {
      for (const item of r.items) if (indexes.has(item.index)) item.accepted = true;
    });
    res.json({ success: true, collection: detail(updated) });
  }));

  app.post('/api/v2/nfts/:id/items/:index', route(async (req, res) => {
    const index = Number(req.params.index);
    const patch = req.body?.item || {};
    const updated = store.update(req.params.id, (r) => {
      const item = r.items.find((it) => it.index === index);
      if (!item) throw httpError(404, 'Unknown item');
      if (item.metadataUri || item.mintSignature) throw httpError(409, 'This item is uploaded; its metadata is fixed.');
      const [normalized] = normalizeItems([{ ...item, ...patch, index }]);
      Object.assign(item, normalized, { key: item.key });
    });
    res.json({ success: true, collection: detail(updated) });
  }));

  app.put(
    '/api/v2/nfts/:id/images/:name',
    express.raw({ type: () => true, limit: '26mb' }),
    route(async (req, res) => {
      const record = store.get(req.params.id);
      rejectIfBusy(record.id);
      const name = req.params.name;
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const type = detectImageType(bytes);
      if (!type) throw httpError(400, 'Only PNG, JPEG, GIF or WebP images are accepted.');
      if (name === 'cover') {
        if (record.collectionMetadataUri) throw httpError(409, 'The collection metadata is uploaded; the cover is fixed.');
        const saved = store.saveImage(record.id, 'cover', type, bytes);
        store.update(record.id, (r) => { r.cover = { type, ...saved }; r.collectionImageUri = null; });
        return res.json({ success: true, type, ...saved });
      }
      const index = Number(name);
      const item = record.items.find((it) => it.index === index);
      if (!item) throw httpError(404, 'Unknown item');
      if (item.imageUri) throw httpError(409, 'This image is already uploaded.');
      const saved = store.saveImage(record.id, String(index), type, bytes);
      store.update(record.id, (r) => {
        const it = r.items.find((x) => x.index === index);
        Object.assign(it, { imageType: type, imageBytes: saved.bytes, imageSha256: saved.sha256 });
      });
      res.json({ success: true, type, ...saved });
    }),
  );

  app.get('/api/v2/nfts/:id/images/:name', route(async (req, res) => {
    const record = store.get(req.params.id);
    const name = req.params.name;
    const type = name === 'cover'
      ? record.cover?.type
      : record.items.find((it) => it.index === Number(name))?.imageType;
    const bytes = type ? store.readImage(record.id, name, type) : null;
    if (!bytes) throw httpError(404, 'No image');
    res.set('Content-Type', `image/${type}`);
    res.set('Cache-Control', 'private, max-age=60');
    res.send(bytes);
  }));

  app.get('/api/v2/nfts/:id/odds', route(async (req, res) => {
    const record = store.get(req.params.id);
    const target = req.query.target === 'collection' ? 'collection' : 'items';
    const rows = vanityOddsTable({
      mode: String(req.query.mode || 'suffix'),
      pattern: String(req.query.pattern || ''),
      caseInsensitive: req.query.caseInsensitive !== '0',
      itemCount: target === 'collection' ? 1 : Math.max(1, record.items.length),
      keysPerSec: nftService.grindRate(),
    });
    res.json({ success: true, rows, keysPerSec: nftService.grindRate() });
  }));

  app.post('/api/v2/nfts/:id/grind', route(async (req, res) => {
    if (rejectIfSecretPinLocked(res, 'grinding NFT addresses')) return;
    const record = store.get(req.params.id);
    if (!record.items.length) throw httpError(409, 'Import items first.');
    const job = nftService.startGrind(record.id);
    res.json({ success: true, job });
  }));

  app.post('/api/v2/nfts/:id/grind/cancel', route(async (req, res) => {
    res.json({ success: true, cancelled: nftService.cancelJob(req.params.id) });
  }));

  app.post('/api/v2/nfts/:id/estimate', route(async (req, res) => {
    if (rejectIfDemo(res)) return;
    if (rejectIfSecretPinLocked(res, 'estimating an NFT mint')) return;
    const record = store.get(req.params.id);
    const walletPublicKey = String(req.body?.walletPublicKey || '').trim();
    const payerSecretKey = payerFor(walletPublicKey);
    const estimate = await nftService.estimate(record.id, { rpcUrl: getRpcUrl(), payerSecretKey, walletPublicKey });
    res.json({ success: true, estimate });
  }));

  app.post('/api/v2/nfts/:id/run', route(async (req, res) => {
    if (rejectIfDemo(res)) return;
    if (rejectIfSecretPinLocked(res, 'minting NFTs')) return;
    const record = store.get(req.params.id);
    rejectIfBusy(record.id);
    const blockers = [
      ...collectionConfigIssues(record.config).filter((i) => i.level === 'error').map((i) => i.detail),
      ...itemReviewIssues(record.items).filter((i) => i.level === 'error' || i.level === 'warn').map((i) => (i.index === null ? i.detail : `#${i.index}: ${i.detail}`)),
    ];
    if (!record.items.length) blockers.push('No items imported.');
    if (!record.collectionKey || record.items.some((it) => !it.key)) blockers.push('Grind every address first.');
    if (blockers.length) {
      return res.status(409).json({ success: false, code: 'NFT_RUN_BLOCKED', error: blockers[0], blockers });
    }
    const walletPublicKey = String(req.body?.walletPublicKey || '').trim();
    const payerSecretKey = payerFor(walletPublicKey);
    const maxSpendSol = Number(req.body?.maxSpendSol);
    if (!(maxSpendSol > 0)) throw httpError(400, 'Review the estimate and approve a spend cap first.');
    const job = nftService.startRun(record.id, { rpcUrl: getRpcUrl(), payerSecretKey, maxSpendSol });
    res.json({ success: true, job });
  }));

  app.post('/api/v2/nfts/:id/run/cancel', route(async (req, res) => {
    res.json({ success: true, cancelled: nftService.cancelJob(req.params.id) });
  }));

  app.post('/api/v2/nfts/:id/verify', route(async (req, res) => {
    if (rejectIfDemo(res)) return;
    const record = store.get(req.params.id);
    const verification = await nftService.verify(record.id, {
      rpcUrl: getRpcUrl(),
      checkUris: req.body?.checkUris !== false,
    });
    res.json({ success: true, verification, collection: detail(store.get(record.id)) });
  }));

  app.get('/api/v2/nfts/:id/proof', route(async (req, res) => {
    res.json({ success: true, proof: nftService.proofDocument(req.params.id) });
  }));
}

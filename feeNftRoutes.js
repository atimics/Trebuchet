import fs from 'node:fs';
import * as store from './feeNftStore.js';
import * as service from './feeNftService.js';
import * as collections from './nftCollectionStore.js';

export function registerFeeNftRoutes(app, deps) {
  const { isDemoMode, rejectIfSecretPinLocked, getRpcUrl, getNetwork, getManagedWallet, sendErrorResponse, claim = () => {}, release = () => {} } = deps;
  const route = (handler) => async (req, res) => { try { await handler(req, res); } catch (e) { sendErrorResponse(res, e, e.statusCode || 400); } };
  const wallet = (address) => {
    const saved = getManagedWallet(String(address));
    if (!saved?.secretKey) throw Object.assign(new Error('Choose a Trebuchet signing wallet'), { statusCode: 404 });
    return saved.secretKey;
  };
  const live = (res) => {
    if (isDemoMode()) { res.status(409).json({ success: false, code: 'FEE_LIVE_NETWORK', error: 'Select a live network in Settings' }); return false; }
    return !rejectIfSecretPinLocked(res, 'creating or claiming fee NFTs');
  };
  app.get('/api/v2/fee-nfts', route(async (_req, res) => {
    const sample = JSON.parse(fs.readFileSync(new URL('./docs/airdrop-lists/sample.json', import.meta.url), 'utf8'));
    res.json({ success: true, programId: service.programId(), sample, collections: collections.list().map((c) => ({ id: c.id, name: c.config.name, count: c.items.length, minted: c.items.filter((i) => i.mintSignature).length })), vaults: store.list().map(store.publicView) });
  }));
  app.post('/api/v2/fee-nfts/prepare', route(async (req, res) => {
    if (!live(res)) return;
    const { walletPublicKey, collectionId, venue, nativeNftMint, recipients } = req.body || {};
    const network = getNetwork() === 'mainnet-beta' ? 'mainnet' : getNetwork();
    wallet(walletPublicKey);
    if (!['mainnet', 'devnet'].includes(network)) throw new Error('Choose mainnet or devnet');
    const record = await service.prepare({ rpcUrl: getRpcUrl(), network, walletPublicKey, collectionId, venue, nativeNftMint, recipients });
    res.json({ success: true, vault: store.publicView(record) });
  }));
  app.get('/api/v2/fee-nfts/:id', route(async (req, res) => {
    const record = store.get(req.params.id);
    res.json({ success: true, vault: await service.snapshot(record, getRpcUrl()) });
  }));
  app.post('/api/v2/fee-nfts/import', route(async (req, res) => {
    if (isDemoMode()) throw new Error('Select the fee collection’s live network');
    res.json({ success: true, vault: store.publicView(await service.importProof(req.body, getRpcUrl())) });
  }));
  app.post('/api/v2/fee-nfts/:id/prepare-claim', route(async (req, res) => {
    if (isDemoMode()) throw new Error('Select the fee collection’s live network');
    res.json({ success: true, ...await service.prepareHolderClaim(req.params.id, { ...req.body, rpcUrl: getRpcUrl(), action: 'claim' }) });
  }));
  app.post('/api/v2/fee-nfts/:id/prepare-harvest', route(async (req, res) => {
    if (isDemoMode()) throw new Error('Select the fee collection’s live network');
    res.json({ success: true, ...await service.prepareHolderClaim(req.params.id, { ...req.body, rpcUrl: getRpcUrl(), action: 'harvest' }) });
  }));
  app.post('/api/v2/fee-nfts/:id/run', route(async (req, res) => {
    if (!live(res)) return;
    const record = store.get(req.params.id);
    const input = req.body || {};
    if (input.approvedDigest !== record.plan.digest || input.confirmNativeNftMint !== record.plan.source.nativeNftMint || input.walletPublicKey !== record.plan.creator || !Number.isSafeInteger(input.maxSpendLamports) || input.maxSpendLamports <= 0) throw new Error('Review the backing NFT, plan and spend cap');
    const secretKey = wallet(input.walletPublicKey);
    claim(input.walletPublicKey, 'fee-nfts', record.id);
    try {
      const job = service.startRun(record.id, { ...input, rpcUrl: getRpcUrl(), secretKey, onFinish: () => release(input.walletPublicKey) });
      res.json({ success: true, job });
    } catch (e) { release(input.walletPublicKey); throw e; }
  }));
  app.post('/api/v2/fee-nfts/:id/:action(harvest|claim|recover)', route(async (req, res) => {
    if (!live(res)) return;
    const secretKey = wallet(req.body?.walletPublicKey);
    claim(req.body.walletPublicKey, 'fee-nfts', req.params.id);
    try { res.json({ success: true, ...await service.transact(req.params.id, { ...req.body, rpcUrl: getRpcUrl(), action: req.params.action, secretKey }) }); }
    finally { release(req.body.walletPublicKey); }
  }));
}

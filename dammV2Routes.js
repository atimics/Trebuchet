// dammV2Routes.js
//
// Local API for the lean Meteora launch. Registered from server.js with the
// server's own helpers so session, PIN and practice-mode rules match the launcher.
//
// Money moves only in POST /run (and the position claim, which signs with the
// wallet). /run needs an unlocked PIN, a managed wallet, a spend cap the operator
// saw, and a SOL price the operator saw that still matches the market.

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  DAMM_V2_DEFAULTS,
  LAMPORTS_PER_SOL,
  compareLaunchVenues,
  dammV2CostModel,
  dammV2DepthTable,
  dammV2Facts,
  dammV2Pricing,
  isAddress,
  normalizeDammV2Config,
} from '@trebuchet/core/damm-v2-plan';
import { FALLBACK_SOL_USD } from '@trebuchet/core/lp-constants';
import { buildV2LaunchPlan } from '@trebuchet/core/launch-plan';
import { detectLogoImageMime, LOGO_MAX_BYTES } from '@trebuchet/core/validators';
import * as store from './dammV2Store.js';
import * as launch from './dammV2Launch.js';
import * as service from './dammV2Service.js';

const PRICE_TOLERANCE = 0.15; // the approved SOL price may differ from the market by this much

function httpError(status, message, code) {
  return Object.assign(new Error(message), { statusCode: status, ...(code ? { code } : {}) });
}

/** The Raydium venue cost for the same single-pool launch, from the app's own plan builder. */
function raydiumVenueSol(config) {
  try {
    const plan = buildV2LaunchPlan({
      token: { name: config.token.name, symbol: config.token.symbol, supply: config.token.supply },
      mode: 'dry-run',
      launchSol: 0,
      poolTopology: { pools: [{
        quoteSymbol: 'SOL',
        quoteMint: 'So11111111111111111111111111111111111111112',
        supplyPercent: 100,
        distribution: [{ sharePercent: 100 }],
        ladder: { mode: 'off' },
        support: { mode: 'off' },
      }] },
    });
    return plan.operations.filter((op) => /pool|Fee Key/i.test(op.label)).reduce((sum, op) => sum + Number(op.costSol || 0), 0);
  } catch {
    return null;
  }
}

function checkLogo(dataUrl) {
  if (dataUrl == null || dataUrl === '') return null;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(dataUrl));
  if (!match) throw httpError(400, 'The logo must be an image file.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!detectLogoImageMime(bytes)) throw httpError(400, 'The logo must be a PNG, JPEG or GIF.');
  if (bytes.length > LOGO_MAX_BYTES) throw httpError(400, `The logo must be under ${Math.round(LOGO_MAX_BYTES / 1024)} KB. The app shrinks logos you pick in the launch form.`);
  return String(dataUrl);
}

export function registerDammV2Routes(app, deps) {
  const {
    isDemoMode,
    rejectIfSecretPinLocked,
    sendErrorResponse,
    getRpcUrl,
    getManagedWallet,
    createToken,
    finishToken,
    getVanityCandidate,
    removeVanityCandidate,
    getSolUsd,
    addCoin = () => {},
    destinationRejection = async () => null,
  } = deps;

  const route = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      sendErrorResponse(res, error, error?.statusCode || 500);
    }
  };

  const connection = () => new Connection(getRpcUrl(), 'confirmed');

  const liveSolUsd = async () => {
    try {
      const price = Number(await getSolUsd());
      return Number.isFinite(price) && price > 0 ? price : null;
    } catch {
      return null;
    }
  };

  const walletKeypair = (publicKey) => {
    if (!isAddress(publicKey)) throw httpError(400, 'walletPublicKey required');
    const wallet = getManagedWallet(publicKey);
    if (!wallet || !Array.isArray(wallet.secretKey)) {
      throw httpError(404, 'That wallet is not a Trebuchet-managed wallet with a stored key.');
    }
    return wallet.secretKey;
  };

  // Everything the form and the review step show for a config.
  function estimateFor(config, solUsd) {
    const price = solUsd || FALLBACK_SOL_USD;
    const pricing = dammV2Pricing({ supply: config.token.supply, startingMarketCapUsd: config.pool.startingMarketCapUsd, solUsd: price, rangeMultiple: config.pool.rangeMultiple, feeBps: config.pool.feeBps });
    const transfers = config.destination ? 1 : 0;
    const cost = dammV2CostModel({ keyTransfers: transfers });
    const raydium = raydiumVenueSol(config);
    return {
      solUsd: price,
      solUsdIsFallback: !solUsd,
      pricing: {
        startMarketCapSol: pricing.startMarketCapSol,
        startPriceSol: pricing.startPriceSol,
        startPriceUsd: pricing.startPriceUsd,
        endMarketCapUsd: pricing.endMarketCapUsd,
        depth: dammV2DepthTable(pricing),
        buys: [1, 10, 100].map((sol) => pricing.buy(sol)),
      },
      cost,
      comparison: raydium == null ? null : compareLaunchVenues({ raydiumVenueSol: raydium, dammVenueSol: cost.venueSol, solUsd: price }),
      facts: dammV2Facts(config),
    };
  }

  const summary = (record) => ({
    id: record.id,
    name: record.config.token.name,
    symbol: record.config.token.symbol,
    status: record.status,
    walletPublicKey: record.walletPublicKey,
    mint: record.steps.token?.mint || null,
    pool: record.steps.pool?.pool || null,
    updatedAt: record.updatedAt,
    error: record.error,
    job: launch.jobStatus(record.id),
  });

  const detail = async (record) => {
    const price = record.solUsd || (await liveSolUsd());
    return { ...store.publicView(record), summary: summary(record), estimate: estimateFor(record.config, price), job: launch.jobStatus(record.id) };
  };

  const rejectIfDemo = (res) => {
    if (!isDemoMode()) return false;
    res.status(409).json({
      success: false,
      code: 'DAMM_PRACTICE_MODE',
      error: 'A Meteora launch needs a live network. Turn off practice mode in Settings.',
    });
    return true;
  };

  app.get('/api/v2/damm/launches', route(async (_req, res) => {
    res.json({ success: true, launches: store.list().map(summary) });
  }));

  app.post('/api/v2/damm/estimate', route(async (req, res) => {
    const config = normalizeDammV2Config(req.body?.config || {});
    const price = Number(req.body?.solUsd) > 0 ? Number(req.body.solUsd) : await liveSolUsd();
    res.json({ success: true, config, defaults: DAMM_V2_DEFAULTS, estimate: estimateFor(config, price) });
  }));

  app.post('/api/v2/damm/launches', route(async (req, res) => {
    const config = normalizeDammV2Config(req.body?.config || {});
    const walletPublicKey = req.body?.walletPublicKey ? String(req.body.walletPublicKey) : null;
    if (walletPublicKey && !isAddress(walletPublicKey)) throw httpError(400, 'walletPublicKey does not look like a Solana address');
    const record = store.create({ config, walletPublicKey, logoDataUrl: checkLogo(req.body?.logoDataUrl) });
    res.json({ success: true, launch: await detail(record) });
  }));

  app.get('/api/v2/damm/launches/:id', route(async (req, res) => {
    res.json({ success: true, launch: await detail(store.get(req.params.id)) });
  }));

  app.get('/api/v2/damm/launches/:id/job', route(async (req, res) => {
    const record = store.get(req.params.id);
    res.json({ success: true, job: launch.jobStatus(record.id), status: record.status, steps: record.steps, events: record.events.slice(-25), error: record.error });
  }));

  app.post('/api/v2/damm/launches/:id/update', route(async (req, res) => {
    const record = store.get(req.params.id);
    if (record.status !== 'draft') throw httpError(409, 'Only a draft can be edited.');
    const patch = {};
    if (req.body?.config) patch.config = normalizeDammV2Config(req.body.config);
    if ('walletPublicKey' in (req.body || {})) {
      const wallet = req.body.walletPublicKey ? String(req.body.walletPublicKey) : null;
      if (wallet && !isAddress(wallet)) throw httpError(400, 'walletPublicKey does not look like a Solana address');
      patch.walletPublicKey = wallet;
    }
    if ('logoDataUrl' in (req.body || {})) patch.logoDataUrl = checkLogo(req.body.logoDataUrl);
    res.json({ success: true, launch: await detail(store.update(record.id, patch)) });
  }));

  app.post('/api/v2/damm/launches/:id/remove', route(async (req, res) => {
    store.remove(req.params.id);
    res.json({ success: true });
  }));

  app.post('/api/v2/damm/launches/:id/run', route(async (req, res) => {
    if (rejectIfDemo(res)) return;
    if (!isDemoMode() && rejectIfSecretPinLocked(res, 'running a Meteora launch')) return;
    const record = store.get(req.params.id);
    if (launch.isBusy(record.id)) throw httpError(409, 'This launch is already running.', 'DAMM_JOB_RUNNING');
    if (record.status === 'completed') throw httpError(409, 'This launch is already complete.', 'DAMM_ALREADY_COMPLETE');
    if (!record.walletPublicKey) throw httpError(400, 'Choose the launch wallet first.');
    const secretKey = walletKeypair(record.walletPublicKey);

    // The operator approves a spend cap and a SOL price. Both are checked here.
    const estimate = estimateFor(record.config, record.solUsd || Number(req.body?.solUsd));
    const approvedCap = Number(req.body?.maxSpendSol);
    if (!Number.isFinite(approvedCap) || approvedCap < estimate.cost.total) {
      throw httpError(400, `Approve at least ${estimate.cost.total.toFixed(4)} SOL. That is the most this launch can spend.`, 'DAMM_SPEND_CAP');
    }
    const approvedPrice = record.solUsd || Number(req.body?.solUsd);
    if (!(approvedPrice > 0)) throw httpError(400, 'solUsd is required: the SOL price you saw in the review.');
    const market = await liveSolUsd();
    if (!record.solUsd && market && Math.abs(approvedPrice - market) / market > PRICE_TOLERANCE) {
      throw httpError(409, `SOL is about $${market.toFixed(2)} now, not $${approvedPrice.toFixed(2)}. Review the starting price again.`, 'DAMM_PRICE_MOVED');
    }
    if (record.config.destination) {
      const reason = await destinationRejection(record.config.destination, record.walletPublicKey);
      if (reason) throw httpError(400, `Refusing to send the Fee Key: ${reason}`);
    }

    const chain = connection();
    const holdings = await launch.walletHoldings({ connection: chain, publicKey: record.walletPublicKey });
    const needed = Math.ceil(estimate.cost.total * LAMPORTS_PER_SOL);
    if (!record.steps.token?.complete && holdings.lamports < needed) {
      throw httpError(409, `The launch wallet has ${(holdings.lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL and needs ${estimate.cost.total.toFixed(4)}.`, 'DAMM_UNDERFUNDED');
    }

    launch.runLaunch({
      id: record.id,
      walletSecretKey: secretKey,
      deps: {
        connection: chain,
        createToken,
        finishToken,
        getVanityCandidate,
        removeVanityCandidate,
        addCoin,
        solUsd: approvedPrice,
      },
    }).catch((error) => console.error('Meteora launch failed:', error?.message || error));
    res.status(202).json({ success: true, started: true, job: launch.jobStatus(record.id) });
  }));

  // Unclaimed and claimed fees for a finished launch, read from the chain.
  app.get('/api/v2/damm/launches/:id/fees', route(async (req, res) => {
    const record = store.get(req.params.id);
    const step = record.steps.pool;
    if (!step?.complete) throw httpError(409, 'This launch has no pool yet.');
    const owners = [record.config.destination, record.walletPublicKey].filter(Boolean);
    const chain = connection();
    for (const owner of owners) {
      const rows = await service.listPositions({ connection: chain, owner });
      const hit = rows.find((row) => row.position === step.position);
      if (hit) {
        res.json({ success: true, holder: owner, position: hit, unclaimedSol: Number(hit.unclaimedQuoteLamports) / LAMPORTS_PER_SOL });
        return;
      }
    }
    res.json({ success: true, holder: null, position: null, unclaimedSol: 0 });
  }));

  app.post('/api/v2/damm/launches/:id/claim', route(async (req, res) => {
    if (rejectIfDemo(res)) return;
    if (!isDemoMode() && rejectIfSecretPinLocked(res, 'claiming Meteora fees')) return;
    const record = store.get(req.params.id);
    const step = record.steps.pool;
    if (!step?.complete) throw httpError(409, 'This launch has no pool yet.');
    const requested = req.body?.walletPublicKey ? String(req.body.walletPublicKey) : null;
    const candidates = requested ? [requested] : [record.config.destination, record.walletPublicKey].filter(Boolean);
    const chain = connection();
    for (const publicKey of candidates) {
      const wallet = getManagedWallet(publicKey);
      if (!wallet || !Array.isArray(wallet.secretKey)) continue;
      const rows = await service.listPositions({ connection: chain, owner: publicKey });
      if (!rows.some((row) => row.position === step.position)) continue;
      const claimed = await service.claimFees({ connection: chain, owner: Keypair.fromSecretKey(Uint8Array.from(wallet.secretKey)), position: step.position });
      store.appendEvent(record.id, { stage: 'fees_claimed', txId: claimed.signature, lamports: claimed.lamportsReceived });
      res.json({ success: true, wallet: publicKey, signature: claimed.signature, receivedSol: claimed.lamportsReceived / LAMPORTS_PER_SOL });
      return;
    }
    throw httpError(404, 'None of the wallets Trebuchet manages holds this Fee Key. Claim it from the wallet that does.');
  }));

  app.get('/api/v2/damm/positions', route(async (req, res) => {
    const owner = String(req.query.owner || '');
    if (!isAddress(owner)) throw httpError(400, 'owner required');
    new PublicKey(owner);
    res.json({ success: true, positions: await service.listPositions({ connection: connection(), owner }) });
  }));
}

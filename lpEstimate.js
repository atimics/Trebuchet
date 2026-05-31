// lpEstimate.js
//
// Funding estimator for Trebuchet launches. Given a set of pool allocations,
// computes the SOL and quote-token funding needed to execute the launch.
// Extracted from lpService.js so the estimation math can be tested in
// isolation (table-driven) without dragging in the Raydium SDK.
//
// Public API:
//   estimateRequiredFunding(opts) → { solLamports, byQuote, ... }
//
// DI seams (set before calling):
//   setPriceOracleForTests(fn)     — override getUsdPrice
//   setRouteDiscoveryForTests(fn)  — override discoverRaydiumRoute
//   resetTestFactories()           — clear all overrides

import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { discoverRaydiumRoute as _realDiscoverRaydiumRoute } from './swapService.js';
import { getUsdPrice as _realGetUsdPrice, KNOWN_QUOTES } from './lpService.js';
import {
  COST_POOL_RENT_SOL,
  COST_TICK_ARRAY_SOL,
  COST_POSITION_SOL,
  COST_LOCK_SOL,
  COST_TRANSFER_SOL,
  COST_BS_QUOTE_SOL,
  COST_TX_BUFFER_SOL,
  COST_TOKEN_CREATE_SOL,
  SAFETY_BUFFER_PCT,
  BS_BOOTSTRAP_USD,
  AUTOSWAP_TARGET_USD,
  BS_FALLBACK_WHOLE,
  AUTOSWAP_SIZING_MULTIPLIER,
  AUTOSWAP_CUSTOM_TARGET_MULTIPLIER,
  AUTOSWAP_CUSTOM_SIZING_MULTIPLIER,
  FALLBACK_SOL_USD,
  WSOL_MINT,
} from './lpConstants.js';

// ---------------------------------------------------------------------------
// DI seams for testing
// ---------------------------------------------------------------------------

let __priceOracleForTests = null;
let __routeDiscoveryForTests = null;

export function setPriceOracleForTests(fn) { __priceOracleForTests = fn; }
export function setRouteDiscoveryForTests(fn) { __routeDiscoveryForTests = fn; }
export function resetTestFactories() {
  __priceOracleForTests = null;
  __routeDiscoveryForTests = null;
}

function getUsdPrice(mint) {
  return __priceOracleForTests
    ? __priceOracleForTests(mint)
    : _realGetUsdPrice(mint);
}

function discoverRaydiumRoute(opts) {
  return __routeDiscoveryForTests
    ? __routeDiscoveryForTests(opts)
    : _realDiscoverRaydiumRoute(opts);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function estimateRequiredFunding({
  allocations,
  targetMarketCapUsd,
}) {
  const solBreakdown = [];
  const quoteBreakdown = [];
  const byQuote = {};
  const autoSwapPlan = [];
  let subtotal = 0;

  const addSol = (label, sol) => {
    solBreakdown.push({ label, sol });
    subtotal += sol;
  };

  let solUsd;
  try {
    const p = await getUsdPrice(WSOL_MINT);
    solUsd = p || new Decimal(FALLBACK_SOL_USD);
  } catch (e) {
    console.warn(`estimateRequiredFunding: SOL price fallback (${e.message})`);
    solUsd = new Decimal(FALLBACK_SOL_USD);
  }

  for (const [poolIdx, a] of allocations.entries()) {
    const slices = (a.distribution && a.distribution.length > 0)
      ? a.distribution
      : [{ sharePercent: 100 }];

    const qSym = (a.quoteToken || '').toUpperCase();
    const known = KNOWN_QUOTES[qSym];
    const isSol = (known && known.address === WSOL_MINT) || qSym === 'SOL';
    const quoteSymbol = known
      ? known.symbol
      : (a.quoteSymbolOverride || (a.quoteToken || '').slice(0, 6));
    const quoteAddr = known ? known.address : a.quoteToken;
    const quoteDecimals = known
      ? known.decimals
      : (a.quoteDecimalsOverride !== undefined && a.quoteDecimalsOverride !== null
          ? Number(a.quoteDecimalsOverride)
          : 6);

    const poolLabel = `Pool ${poolIdx + 1} (${quoteSymbol})`;

    addSol(`${poolLabel}: pool creation`, COST_POOL_RENT_SOL);
    addSol(`${poolLabel}: tick arrays (×2)`, 2 * COST_TICK_ARRAY_SOL);

    for (let s = 0; s < slices.length; s++) {
      addSol(
        `${poolLabel}: main slice ${s + 1}/${slices.length} (NFT mint + lock)`,
        COST_POSITION_SOL + COST_LOCK_SOL,
      );
      if (slices[s].recipient) {
        addSol(
          `${poolLabel}: slice ${s + 1} transfer to recipient`,
          COST_TRANSFER_SOL,
        );
      }
    }

    addSol(
      `${poolLabel}: bootstrap position (NFT mint + lock)`,
      COST_POSITION_SOL + COST_LOCK_SOL,
    );

    const ladderCfg = a.ladder || { mode: 'off' };
    let ladderBandCount = 0;
    if (ladderCfg.mode === 'simple') {
      ladderBandCount = Number(ladderCfg.bandCount) || 0;
    } else if (ladderCfg.mode === 'manual') {
      ladderBandCount = Array.isArray(ladderCfg.bands) ? ladderCfg.bands.length : 0;
    }
    for (let b = 0; b < ladderBandCount; b++) {
      addSol(
        `${poolLabel}: ladder band ${b + 1}/${ladderBandCount} (NFT mint + lock)`,
        COST_POSITION_SOL + COST_LOCK_SOL,
      );
    }

    const bsCfg = a.bootstrap || { mode: 'minimal' };
    const bsIsCustom = bsCfg.mode === 'custom';
    let bsActualUsd;
    if (bsIsCustom && Number(targetMarketCapUsd) > 0 && Number(bsCfg.supplyPercent) > 0) {
      bsActualUsd = (Number(bsCfg.supplyPercent) * Number(targetMarketCapUsd)) / 100;
    } else {
      bsActualUsd = BS_BOOTSTRAP_USD;
    }

    if (isSol) {
      let solCost;
      if (bsIsCustom) {
        solCost = bsActualUsd / Number(solUsd.toString());
      } else {
        solCost = COST_BS_QUOTE_SOL;
      }
      addSol(
        bsIsCustom
          ? `${poolLabel}: bootstrap support (~$${bsActualUsd.toFixed(2)} as SOL)`
          : `${poolLabel}: bootstrap quote-side (SOL, dust)`,
        solCost,
      );
    } else {
      let route = null;
      try {
        route = await discoverRaydiumRoute({
          quoteMint: quoteAddr,
          quoteDecimals,
          solUsd,
        });
      } catch (e) {
        console.warn(
          `estimateRequiredFunding: route discovery failed for ${quoteAddr}: ${e.message}`,
        );
      }

      let quoteUsd = null;
      if (a.quoteUsdOverride !== undefined && a.quoteUsdOverride !== null) {
        quoteUsd = new Decimal(a.quoteUsdOverride);
      } else if (route && route.effectiveQuoteUsd && route.effectiveQuoteUsd.gt(0)) {
        quoteUsd = route.effectiveQuoteUsd;
      } else {
        try {
          quoteUsd = await getUsdPrice(quoteAddr);
        } catch (e) {
          quoteUsd = null;
        }
      }

      const isAutoSwap = !!(route && route.available);
      let targetUsd;
      if (bsIsCustom) {
        targetUsd = isAutoSwap
          ? bsActualUsd * AUTOSWAP_CUSTOM_TARGET_MULTIPLIER
          : bsActualUsd;
      } else {
        targetUsd = isAutoSwap ? AUTOSWAP_TARGET_USD : BS_BOOTSTRAP_USD;
      }

      let targetWhole;
      if (quoteUsd && quoteUsd.gt(0)) {
        targetWhole = new Decimal(targetUsd).div(quoteUsd).toNumber();
      } else {
        targetWhole = isAutoSwap ? BS_FALLBACK_WHOLE * 2 : BS_FALLBACK_WHOLE;
      }
      const rawAmt = Math.ceil(targetWhole * Math.pow(10, quoteDecimals));

      if (isAutoSwap) {
        const spendMultiplier = bsIsCustom
          ? AUTOSWAP_CUSTOM_SIZING_MULTIPLIER
          : AUTOSWAP_SIZING_MULTIPLIER;
        const estSolSpend = new Decimal(targetUsd)
          .mul(spendMultiplier)
          .div(solUsd)
          .toNumber();
        const label = bsIsCustom
          ? `${poolLabel}: bootstrap support (auto-swap → ~$${bsActualUsd.toFixed(2)} ${quoteSymbol})`
          : `${poolLabel}: bootstrap quote-side (auto-swap → ~$${targetUsd} ${quoteSymbol})`;
        addSol(label, estSolSpend);

        let minWhole;
        if (quoteUsd && quoteUsd.gt(0)) {
          minWhole = new Decimal(bsActualUsd).div(quoteUsd).toNumber();
        } else {
          minWhole = BS_FALLBACK_WHOLE;
        }
        const minRaw = Math.ceil(minWhole * Math.pow(10, quoteDecimals));
        autoSwapPlan.push({
          allocationIndex: poolIdx,
          quoteMint: quoteAddr,
          quoteSymbol,
          quoteDecimals,
          targetRaw: String(rawAmt),
          minRaw: String(minRaw),
          quoteUsd: quoteUsd.toString(),
          solUsd: solUsd.toString(),
          poolId: 'trade-api',
          poolKind: 'route',
          estSolSpend,
          sizingMultiplier: bsIsCustom
            ? AUTOSWAP_CUSTOM_SIZING_MULTIPLIER
            : AUTOSWAP_SIZING_MULTIPLIER,
          bootstrapMode: bsIsCustom ? 'custom' : 'minimal',
        });
      } else {
        byQuote[quoteAddr] = (byQuote[quoteAddr] || 0) + rawAmt;
        const label = bsIsCustom
          ? `${poolLabel}: bootstrap support (~$${bsActualUsd.toFixed(2)})`
          : `${poolLabel}: bootstrap quote-side`;
        quoteBreakdown.push({
          label,
          symbol: quoteSymbol,
          amount: Number(Number(targetWhole).toPrecision(6)),
          mint: quoteAddr,
        });
      }
    }

    addSol(`${poolLabel}: network/priority fees`, COST_TX_BUFFER_SOL);
  }

  addSol('Token creation (mint + metadata)', COST_TOKEN_CREATE_SOL);

  const buffer = subtotal * SAFETY_BUFFER_PCT;
  solBreakdown.push({
    label: `Safety buffer (${(SAFETY_BUFFER_PCT * 100).toFixed(0)}%)`,
    sol: buffer,
  });
  const total = subtotal + buffer;

  return {
    solLamports: Math.ceil(total * LAMPORTS_PER_SOL),
    byQuote,
    totalSol: total,
    subtotalSol: subtotal,
    bufferSol: buffer,
    solBreakdown,
    quoteBreakdown,
    autoSwapPlan,
  };
}

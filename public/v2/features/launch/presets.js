// Four starting presets, each a bigger network than the last: Spark (token only), Anchor (one market
// and a funded bid), Constellation (three markets) and Vortex (five markets). They are starting
// points, not strategies tuned for return. The budget is the quote deposited into liquidity; setup
// costs (rent, fees, locking) come on top. 1x is a pair's start price.
//
// Per market: `share` is its % of the liquidity supply; `quoteSol` is the quote deposited, in SOL
// (a partner token's amount is its SOL value); `bands` are NEW-side ranges as [supply % of the
// market, low x, high x] (the main position takes the rest, from the start price up); `layers` are
// quote-side bids as [quote share %, low x, high x] below the start price. Every market uses the
// 0.25% fee tier and opens at the same price (no premium), so the markets agree at the start.
const LAUNCH_PRESET_TIER_INDEX = 1;

const CONSTELLATION_BANDS = [[35, 1, 3], [25, 2, 10], [10, 8, 40]];
const CONSTELLATION_LAYERS = [[70, 0.7, 1], [30, 0.25, 0.7]];
const VORTEX_BANDS = [[30, 1, 2], [25, 1.5, 5], [15, 4, 20], [10, 15, 100]];
const VORTEX_LAYERS = [[50, 0.8, 1], [30, 0.5, 0.8], [20, 0.2, 0.5]];

const LAUNCH_PRESETS = Object.freeze([
  {
    id: 'spark', name: 'Spark', budgetSol: 0, tagline: 'token-only launch',
    markets: [{ role: 'sol', share: 100, quoteSol: 0, bands: [], layers: [] }],
  },
  {
    id: 'anchor', name: 'Anchor', budgetSol: 1, tagline: 'single market + support',
    markets: [{ role: 'sol', share: 100, quoteSol: 1, bands: [[40, 1, 3], [20, 2, 10]], layers: [[100, 0.4, 1]] }],
  },
  {
    id: 'constellation', name: 'Constellation', budgetSol: 10, tagline: 'three connected markets',
    markets: [
      { role: 'sol', share: 80, quoteSol: 8, bands: CONSTELLATION_BANDS, layers: CONSTELLATION_LAYERS },
      { role: 'partner', share: 10, quoteSol: 1, bands: CONSTELLATION_BANDS, layers: CONSTELLATION_LAYERS },
      { role: 'partner', share: 10, quoteSol: 1, bands: CONSTELLATION_BANDS, layers: CONSTELLATION_LAYERS },
    ],
  },
  {
    id: 'vortex', name: 'Vortex', budgetSol: 100, tagline: 'five markets + layered liquidity',
    markets: [
      { role: 'sol', share: 80, quoteSol: 80, bands: VORTEX_BANDS, layers: VORTEX_LAYERS },
      ...[0, 1, 2, 3].map(() => ({ role: 'partner', share: 5, quoteSol: 5, bands: VORTEX_BANDS, layers: VORTEX_LAYERS })),
    ],
  },
]);

function launchPresetById(id) {
  return LAUNCH_PRESETS.find((preset) => preset.id === id) || null;
}

// The preset for a budget the buttons offer, or null for any other amount.
function launchPresetForBudget(budgetSol) {
  return LAUNCH_PRESETS.find((preset) => preset.budgetSol === Number(budgetSol)) || null;
}

// Distinct market-shaping positions: per market, the main position, each NEW-side band and each
// quote-side layer. (The tiny bootstrap that opens trading is not counted.)
function launchPresetPositionCount(preset) {
  return preset.markets.reduce((sum, market) => sum + 1 + market.bands.length + market.layers.length, 0);
}

function launchPresetBandsText(market) {
  return market.bands.map(([share, low, high]) => `${share}, ${low}, ${high}`).join('\n');
}

function launchPresetLayersText(market) {
  return market.layers.map(([share, low, high]) => `${share}, ${low}, ${high}`).join('\n');
}

// What each market gets, with its supply share scaled to the supply the pools may use.
function launchPresetMarketPlan(preset, liquidityPercent) {
  return preset.markets.map((market) => ({
    ...market,
    percent: Math.round(liquidityPercent * market.share) / 100,
    bandsText: launchPresetBandsText(market),
    layersText: launchPresetLayersText(market),
  }));
}

function launchPresetSummary(preset) {
  const markets = preset.markets.length;
  const positions = launchPresetPositionCount(preset);
  return `${markets} market${markets === 1 ? '' : 's'} · ${positions} position${positions === 1 ? '' : 's'}`;
}

// Partner tokens come from the hub list: the default hubs, then any token found in Discovery.
async function launchPresetPartners(count) {
  if (count <= 0) return [];
  try {
    const catalog = await state.apiClient?.listFlywheelHubs?.();
    const rows = hubPickerRows(catalog || {}, state.discovery?.records || []);
    return rows.slice(0, count).map((hub) => ({ mint: hub.mint, symbol: String(hub.symbol || hub.name || '').toUpperCase() }));
  } catch {
    return [];
  }
}

async function applyLaunchPreset(id, { announce = true } = {}) {
  const preset = launchPresetById(id);
  if (!preset) return;
  const partnerMarkets = preset.markets.filter((market) => market.role === 'partner');
  const partners = await launchPresetPartners(partnerMarkets.length);
  // Pools may use everything that is not held back for the team or an airdrop.
  const held = supplyEditorRows().filter((row) => row.kind === 'hold').reduce((sum, row) => sum + (Number(row.percent) || 0), 0);
  const plan = launchPresetMarketPlan(preset, Math.max(1, 100 - held));
  const solMarket = plan.find((market) => market.role === 'sol');

  if ($('#liquidityBudgetSol')) $('#liquidityBudgetSol').value = String(preset.budgetSol);
  if ($('#launchSol')) $('#launchSol').value = '0';
  if ($('#quotePoolPercent')) $('#quotePoolPercent').value = '0';
  if ($('#mainPoolPercent')) $('#mainPoolPercent').value = String(solMarket.percent);
  if ($('#sliceShares')) $('#sliceShares').value = '100';
  if ($('#ladderBands')) $('#ladderBands').value = '0';
  if ($('#supportSol')) $('#supportSol').value = String(solMarket.quoteSol);
  state.baseManualLadderText = solMarket.bandsText;
  state.baseSupportLayersText = solMarket.layersText;
  state.baseSupportDepth = '12';
  state.solPoolConfigIndex = LAUNCH_PRESET_TIER_INDEX;
  state.launchPresetId = preset.id;

  state.customPools = plan.filter((market) => market.role === 'partner').map((market, index) => {
    const partner = partners[index] || null;
    return {
      id: nextCustomPoolId(),
      quoteSymbol: partner?.symbol || 'QUOTE',
      quoteMint: partner?.mint || '',
      supplyPercent: market.percent,
      ammConfigIndex: LAUNCH_PRESET_TIER_INDEX,
      startPremiumPct: 0,
      sliceShares: '100',
      feeKeyRecipient: '',
      ladderBands: 0,
      ladderText: market.bandsText,
      supportSol: market.quoteSol,
      supportDepth: 12,
      supportLayersText: market.layersText,
    };
  });
  state.quoteTokenInfo = {};
  invalidateClassicOutputs();
  refreshClassicPreview({ includePoolEditor: true });
  renderAll();
  scheduleLaunchAutoSave();
  renderLaunchBudgetRecommendation();
  if (!announce) return;
  const missing = partnerMarkets.length - partners.length;
  notify(missing > 0
    ? `${preset.name} applied · pick ${missing} partner token${missing === 1 ? '' : 's'} on Pairs`
    : `${preset.name} applied · ${launchPresetSummary(preset)}`);
}

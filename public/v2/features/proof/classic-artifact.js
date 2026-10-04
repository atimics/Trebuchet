

function optionalBoolean(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

const CLASSIC_AUTHORITY_COMPARISON_FIELDS = Object.freeze([
  { key: 'mintAuthorityRenounced', label: 'Mint authority' },
  { key: 'freezeAuthorityDisabled', label: 'Freeze authority' },
  { key: 'metadataUpdateAuthorityRevoked', label: 'Metadata update authority' },
  { key: 'metadataImmutable', label: 'Metadata immutability' },
]);

function classicArtifactHasV2Marker(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return false;
  if (Array.isArray(value)) {
    return value.some((item) => classicArtifactHasV2Marker(item, depth + 1));
  }
  const source = String(value.source || '').trim();
  const schema = String(value.schema || '').trim();
  const kind = String(value.kind || '').trim();
  if (
    source === 'trebuchet-v2'
    || source === 'trebuchet-v2-field-verification'
    || schema === 'trebuchet-v2-proof'
    || kind === 'trebuchet-v2-proof'
    || value.classicRetirementGate
    || value.reportParityAudit
    || value.fieldVerification
  ) {
    return true;
  }
  return Object.values(value).some((item) => classicArtifactHasV2Marker(item, depth + 1));
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function comparisonReportCount(value, fallback = 0) {
  const number = numberOrNull(value);
  return number !== null && number >= 0 ? Math.floor(number) : fallback;
}

function comparisonReportCountIsExplicit(value) {
  return value !== undefined && value !== null && value !== '';
}

function stableHashString(value) {
  const text = String(value ?? '');
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    let codePoint = text.codePointAt(index);
    if (codePoint > 0xffff) index += 1;
    if (codePoint <= 0x7f) bytes.push(codePoint);
    else if (codePoint <= 0x7ff) bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    else if (codePoint <= 0xffff) bytes.push(0xe0 | (codePoint >>> 12), 0x80 | ((codePoint >>> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    else bytes.push(0xf0 | (codePoint >>> 18), 0x80 | ((codePoint >>> 12) & 0x3f), 0x80 | ((codePoint >>> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
  }
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff);
  const rotate = (word, bits) => (word >>> bits) | (word << (32 - bits));
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array(64).fill(0);
    for (let index = 0; index < 16; index += 1) {
      const cursor = offset + (index * 4);
      words[index] = ((bytes[cursor] << 24) | (bytes[cursor + 1] << 16) | (bytes[cursor + 2] << 8) | bytes[cursor + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotate(words[index - 15], 7) ^ rotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotate(words[index - 2], 17) ^ rotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
      const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((word, index) => { state[index] = (state[index] + word) >>> 0; });
  }
  return state.map((word) => word.toString(16).padStart(8, '0')).join('');
}

function normalizeComparisonAirdropEntry(row = {}) {
  return {
    wallet: row.wallet || row.recipient || row.address || null,
    tokens: numberOrNull(row.tokens),
    amountRaw: row.amountRaw == null ? null : String(row.amountRaw),
    txId: row.txId || row.signature || row.tx || null,
  };
}

function normalizeComparisonAirdrop(airdrop = {}) {
  return {
    recipients: Array.isArray(airdrop.recipients)
      ? airdrop.recipients.map(normalizeComparisonAirdropEntry).filter((row) => row.wallet)
      : [],
    transferred: Array.isArray(airdrop.transferred)
      ? airdrop.transferred.map(normalizeComparisonAirdropEntry).filter((row) => row.wallet)
      : [],
    failed: Array.isArray(airdrop.failed)
      ? airdrop.failed.map(normalizeComparisonAirdropEntry).filter((row) => row.wallet)
      : [],
    recipientsHash: typeof airdrop.recipientsHash === 'string' ? airdrop.recipientsHash : null,
    transferredHash: typeof airdrop.transferredHash === 'string' ? airdrop.transferredHash : null,
    failedHash: typeof airdrop.failedHash === 'string' ? airdrop.failedHash : null,
  };
}

function comparisonAirdropFingerprintList(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      wallet: row?.wallet || row?.recipient || row?.address || null,
      tokens: numberOrNull(row?.tokens),
      amountRaw: row?.amountRaw == null ? null : String(row.amountRaw),
      txId: row?.txId || row?.signature || row?.tx || null,
    }))
    .sort((a, b) => [
      a.wallet || '',
      String(a.tokens ?? ''),
      String(a.amountRaw ?? ''),
      a.txId || '',
    ].join('|').localeCompare([
      b.wallet || '',
      String(b.tokens ?? ''),
      String(b.amountRaw ?? ''),
      b.txId || '',
    ].join('|')));
}

function comparisonAirdropListHash(rows = []) {
  return stableHashString(JSON.stringify(comparisonAirdropFingerprintList(rows)));
}

function comparisonAirdropFingerprint(airdrop = {}) {
  const listHash = (key) => {
    const rows = airdrop?.[key];
    const storedHash = typeof airdrop?.[`${key}Hash`] === 'string' ? airdrop[`${key}Hash`].trim() : '';
    return (!Array.isArray(rows) || rows.length === 0) && storedHash ? storedHash : comparisonAirdropListHash(rows);
  };
  return {
    recipientsHash: listHash('recipients'),
    transferredHash: listHash('transferred'),
    failedHash: listHash('failed'),
  };
}

function comparisonTransferEvidenceRows(transfer = {}) {
  const rows = [];
  const tokenTransfers = Array.isArray(transfer?.tokenSweep?.transferred) ? transfer.tokenSweep.transferred : [];
  const nftTransfers = Array.isArray(transfer?.nftSweep?.transferred) ? transfer.nftSweep.transferred : [];
  const tokenErrors = Array.isArray(transfer?.tokenTransferErrors)
    ? transfer.tokenTransferErrors
    : Array.isArray(transfer?.tokenSweep?.errors) ? transfer.tokenSweep.errors : [];
  const nftErrors = Array.isArray(transfer?.nftTransferErrors)
    ? transfer.nftTransferErrors
    : Array.isArray(transfer?.nftSweep?.errors) ? transfer.nftSweep.errors : [];
  const solAmount = numberOrNull(transfer?.solSweep?.solTransferred ?? transfer?.solTransferred);
  const solTx = transfer?.solSweep?.txId || transfer?.solTxId || transfer?.txId || transfer?.signature || null;

  if (solAmount != null || solTx || transfer?.solSweepError) {
    rows.push({
      type: 'sol',
      asset: 'SOL',
      amount: solAmount,
      decimals: null,
      txId: solTx,
      status: transfer?.solSweepError || null,
      error: Boolean(transfer?.solSweepError),
    });
  }

  tokenTransfers.forEach((row) => {
    rows.push({
      type: 'token',
      asset: row.mint || row.tokenMint || null,
      amount: row.amount == null ? null : String(row.amount),
      decimals: numberOrNull(row.decimals),
      txId: row.txId || row.signature || null,
      status: 'transferred',
      error: false,
    });
  });

  nftTransfers.forEach((row) => {
    rows.push({
      type: 'nft',
      asset: row.mint || row.nftMint || null,
      amount: '1',
      programName: row.programName || null,
      txId: row.txId || row.signature || null,
      status: 'transferred',
      error: false,
    });
  });

  tokenErrors.forEach((row) => {
    rows.push({
      type: 'token',
      asset: row.mint || row.tokenMint || null,
      amount: null,
      decimals: numberOrNull(row.decimals),
      txId: row.txId || row.signature || null,
      status: row.error || row.reason || 'transfer failed',
      error: true,
    });
  });

  nftErrors.forEach((row) => {
    rows.push({
      type: 'nft',
      asset: row.mint || row.nftMint || null,
      amount: null,
      programName: row.programName || null,
      txId: row.txId || row.signature || null,
      status: row.error || row.reason || 'transfer failed',
      error: true,
    });
  });

  return rows.sort((a, b) => [
    a.type || '',
    a.asset || '',
    String(a.amount ?? ''),
    String(a.decimals ?? ''),
    a.programName || '',
    a.txId || '',
    a.status || '',
    String(a.error),
  ].join('|').localeCompare([
    b.type || '',
    b.asset || '',
    String(b.amount ?? ''),
    String(b.decimals ?? ''),
    b.programName || '',
    b.txId || '',
    b.status || '',
    String(b.error),
  ].join('|')));
}

function comparisonTransferEvidenceRecord(transfer = {}) {
  if (!transfer || typeof transfer !== 'object' || Object.keys(transfer).length === 0) return null;
  return {
    destinationWallet: transfer.destinationWallet || null,
    status: transfer.status || null,
    walletEmpty: optionalBoolean(transfer.walletEmpty),
    rows: comparisonTransferEvidenceRows(transfer),
  };
}

function comparisonTransferEvidenceHash(transfer = {}) {
  const record = comparisonTransferEvidenceRecord(transfer);
  return record ? stableHashString(JSON.stringify(record)) : null;
}

function normalizeComparisonPosition(position = {}, type = null, poolId = null) {
  return {
    poolId: poolId || position.poolId || null,
    type: position.type || type || null,
    sliceIndex: numberOrNull(position.sliceIndex),
    bandIndex: numberOrNull(position.bandIndex),
    supportIndex: numberOrNull(position.supportIndex),
    sharePercent: numberOrNull(position.sharePercent),
    supplyPercent: numberOrNull(position.supplyPercent),
    lowerMultiplier: numberOrNull(position.lowerMultiplier),
    upperMultiplier: numberOrNull(position.upperMultiplier),
    depthPct: numberOrNull(position.depthPct),
    positionNftMint: position.positionNftMint || position.nftMint || position.positionMint || null,
    feeKeyNftMint: position.feeKeyNftMint || position.feeKeyMint || null,
    locked: optionalBoolean(position.locked),
    recipient: position.recipient || null,
    transferredTo: position.transferredTo || null,
    tickLower: numberOrNull(position.tickLower),
    tickUpper: numberOrNull(position.tickUpper),
    openTx: position.openTx || position.txIds?.open || null,
    lockTx: position.lockTx || position.txIds?.lock || null,
    transferTx: position.transferTx || position.txIds?.transfer || null,
  };
}

function normalizeComparisonPool(pool = {}) {
  const txIds = pool.txIds || {};
  return {
    poolId: pool.poolId || pool.id || null,
    quote: pool.quote || pool.quoteSymbol || pool.quoteToken || null,
    quoteMint: pool.quoteMint || pool.quoteAddress || null,
    supplyPercent: numberOrNull(pool.supplyPercent),
    tickSpacing: numberOrNull(pool.tickSpacing),
    initialPrice: pool.initialPrice == null ? null : String(pool.initialPrice),
    launchedSide: pool.launchedSide || null,
    createPoolTx: pool.createPoolTx || txIds.createPool || null,
  };
}

function comparisonPoolFingerprint(pools = []) {
  return (Array.isArray(pools) ? pools : [])
    .map((pool) => ({
      poolId: pool?.poolId || null,
      quoteMint: pool?.quoteMint || null,
      supplyPercent: numberOrNull(pool?.supplyPercent),
      tickSpacing: numberOrNull(pool?.tickSpacing),
      initialPrice: pool?.initialPrice == null ? null : String(pool.initialPrice),
      launchedSide: pool?.launchedSide || null,
      createPoolTx: pool?.createPoolTx || null,
    }))
    .sort((a, b) => [
      a.poolId || '',
      a.quoteMint || '',
      String(a.tickSpacing ?? ''),
      String(a.initialPrice ?? ''),
    ].join('|').localeCompare([
      b.poolId || '',
      b.quoteMint || '',
      String(b.tickSpacing ?? ''),
      String(b.initialPrice ?? ''),
    ].join('|')));
}

function comparisonPositionsFromPools(pools = []) {
  return (Array.isArray(pools) ? pools : []).flatMap((pool) => {
    const poolId = pool?.poolId || pool?.id || null;
    if (Array.isArray(pool?.positions)) {
      return pool.positions.map((position) => normalizeComparisonPosition(position, position?.type, poolId));
    }
    return [
      ...(Array.isArray(pool?.mainPositions) ? pool.mainPositions.map((position) => normalizeComparisonPosition(position, 'main', poolId)) : []),
      ...(Array.isArray(pool?.ladderPositions) ? pool.ladderPositions.map((position) => normalizeComparisonPosition(position, 'ladder', poolId)) : []),
      ...(Array.isArray(pool?.supportPositions) ? pool.supportPositions.map((position) => normalizeComparisonPosition(position, 'support', poolId)) : []),
      ...(pool?.bootstrap ? [normalizeComparisonPosition(pool.bootstrap, 'bootstrap', poolId)] : []),
    ];
  });
}

function comparisonPositionFingerprint(positions = []) {
  return (Array.isArray(positions) ? positions : [])
    .map((position) => ({
      poolId: position?.poolId || null,
      type: position?.type || null,
      sliceIndex: numberOrNull(position?.sliceIndex),
      bandIndex: numberOrNull(position?.bandIndex),
      supportIndex: numberOrNull(position?.supportIndex),
      sharePercent: numberOrNull(position?.sharePercent),
      supplyPercent: numberOrNull(position?.supplyPercent),
      lowerMultiplier: numberOrNull(position?.lowerMultiplier),
      upperMultiplier: numberOrNull(position?.upperMultiplier),
      depthPct: numberOrNull(position?.depthPct),
      positionNftMint: position?.positionNftMint || null,
      feeKeyNftMint: position?.feeKeyNftMint || null,
      locked: optionalBoolean(position?.locked),
      recipient: position?.recipient || null,
      transferredTo: position?.transferredTo || null,
      tickLower: numberOrNull(position?.tickLower),
      tickUpper: numberOrNull(position?.tickUpper),
      openTx: position?.openTx || null,
      lockTx: position?.lockTx || null,
      transferTx: position?.transferTx || null,
    }))
    .sort((a, b) => [
      a.poolId || '',
      a.positionNftMint || '',
      a.feeKeyNftMint || '',
      a.type || '',
      String(a.sliceIndex ?? ''),
      String(a.bandIndex ?? ''),
      String(a.supportIndex ?? ''),
      String(a.sharePercent ?? ''),
      String(a.supplyPercent ?? ''),
      String(a.lowerMultiplier ?? ''),
      String(a.upperMultiplier ?? ''),
      String(a.depthPct ?? ''),
      String(a.tickLower ?? ''),
      String(a.tickUpper ?? ''),
      a.recipient || '',
      a.transferredTo || '',
      a.openTx || '',
      a.lockTx || '',
      a.transferTx || '',
    ].join('|').localeCompare([
      b.poolId || '',
      b.positionNftMint || '',
      b.feeKeyNftMint || '',
      b.type || '',
      String(b.sliceIndex ?? ''),
      String(b.bandIndex ?? ''),
      String(b.supportIndex ?? ''),
      String(b.sharePercent ?? ''),
      String(b.supplyPercent ?? ''),
      String(b.lowerMultiplier ?? ''),
      String(b.upperMultiplier ?? ''),
      String(b.depthPct ?? ''),
      String(b.tickLower ?? ''),
      String(b.tickUpper ?? ''),
      b.recipient || '',
      b.transferredTo || '',
      b.openTx || '',
      b.lockTx || '',
      b.transferTx || '',
    ].join('|')));
}

function comparisonAirdropHasHashOnlyRows(airdrop = {}, key) {
  const rows = Array.isArray(airdrop?.[key]) ? airdrop[key] : [];
  const hash = typeof airdrop?.[`${key}Hash`] === 'string' ? airdrop[`${key}Hash`].trim() : '';
  return Boolean(hash && rows.length === 0);
}

function comparisonAirdropNeedsFullRows(airdrop = {}) {
  const planned = Number(airdrop?.plannedRecipientCount || 0);
  const delivered = Number(airdrop?.deliveredCount || 0);
  const failed = Number(airdrop?.failedCount || 0);
  return Boolean(
    (planned > 0 && comparisonAirdropHasHashOnlyRows(airdrop, 'recipients'))
      || (delivered > 0 && comparisonAirdropHasHashOnlyRows(airdrop, 'transferred'))
      || (failed > 0 && comparisonAirdropHasHashOnlyRows(airdrop, 'failed'))
  );
}

function comparisonAirdropDeliveryEvidenceState(airdrop = {}) {
  const count = (value, fallback = 0) => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
  };
  const normalized = normalizeComparisonAirdrop(airdrop);
  const planned = count(airdrop?.plannedRecipientCount);
  const delivered = count(airdrop?.deliveredCount, normalized.transferred.length);
  const failed = count(airdrop?.failedCount, normalized.failed.length);
  const required = planned > 0 || delivered > 0 || failed > 0;
  const expectedCount = Math.max(planned, delivered);
  const recipientWallets = new Set([
    ...normalized.recipients,
    ...normalized.transferred,
    ...normalized.failed,
  ].map((row) => row.wallet).filter(Boolean));
  const deliveredWallets = new Set(normalized.transferred.map((row) => row.wallet).filter(Boolean));
  const transactionCount = normalized.transferred.filter((row) => row.txId).length;
  const missing = [];

  if (required) {
    if (failed > 0 || normalized.failed.length > 0) missing.push('zero failed recipients');
    if (recipientWallets.size < expectedCount) missing.push('recipient rows');
    if (deliveredWallets.size < expectedCount || normalized.transferred.length < expectedCount) missing.push('delivered rows');
    if (delivered < expectedCount) missing.push('delivered count');
    if (transactionCount < expectedCount) missing.push('transaction signatures');
    if (comparisonAirdropNeedsFullRows(airdrop)) missing.push('full airdrop rows');
  }

  return {
    required,
    complete: !required || missing.length === 0,
    planned,
    delivered,
    failed,
    pending: Math.max(0, planned - delivered - failed),
    expectedCount,
    recipientCount: recipientWallets.size,
    deliveredRowCount: normalized.transferred.length,
    transactionCount,
    missing,
  };
}

function comparisonLiquidityEvidenceState(proof = {}, {
  plannedPoolCount = null,
  plannedPositionCount = null,
} = {}) {
  const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const liquidity = proof?.liquidity && typeof proof.liquidity === 'object' ? proof.liquidity : {};
  const poolIds = [
    ...(Array.isArray(liquidity.poolIds) ? liquidity.poolIds : []),
    ...results.map((pool) => pool?.poolId || pool?.id).filter(Boolean),
  ].filter((value, index, list) => value && list.indexOf(value) === index);
  const poolRowCount = results.filter((pool) => pool?.poolId || pool?.id).length || poolIds.length;
  const positionRowCount = proofPositions(results);
  const lockedRowCount = proofLockedPositionCount(results);
  const feeKeyRowCount = proofFeeKeyCount(results);
  const poolCount = comparisonReportCount(liquidity.poolCount, poolRowCount);
  const positionCount = comparisonReportCount(liquidity.positionCount, positionRowCount);
  const lockedPositionCount = comparisonReportCount(liquidity.lockedPositionCount, lockedRowCount);
  const feeKeyCount = comparisonReportCount(liquidity.feeKeyCount, feeKeyRowCount);
  const missing = [];
  const addMissing = (value) => {
    if (!missing.includes(value)) missing.push(value);
  };
  const plannedPools = comparisonReportCount(plannedPoolCount, 0);
  const plannedPositions = comparisonReportCount(plannedPositionCount, 0);

  if (plannedPools > 0 && poolCount < plannedPools) addMissing('pool count');
  if (comparisonReportCountIsExplicit(liquidity.poolCount) && poolCount !== poolRowCount) addMissing('pool count');
  if (plannedPositions > 0 && positionCount < plannedPositions) addMissing('position count');
  if (comparisonReportCountIsExplicit(liquidity.positionCount) && positionCount !== positionRowCount) addMissing('position count');
  if (positionRowCount < positionCount) addMissing('position records');
  if (positionCount > 0 && lockedPositionCount < positionCount) addMissing('lock count');
  if (comparisonReportCountIsExplicit(liquidity.lockedPositionCount) && lockedPositionCount !== lockedRowCount) addMissing('lock count');
  if (lockedPositionCount > 0 && feeKeyCount < lockedPositionCount) addMissing('fee key count');
  if (comparisonReportCountIsExplicit(liquidity.feeKeyCount) && feeKeyCount !== feeKeyRowCount) addMissing('fee key count');

  return {
    complete: missing.length === 0,
    poolCount,
    poolRowCount,
    plannedPoolCount: plannedPools,
    positionCount,
    positionRowCount,
    plannedPositionCount: plannedPositions,
    lockedPositionCount,
    lockedRowCount,
    feeKeyCount,
    feeKeyRowCount,
    missing,
  };
}

function proofHasReportablePoolIdentity(proof = {}, config = currentLaunchConfig()) {
  if (!proof || typeof proof !== 'object') return false;
  const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const plannedPools = buildV2ReportPoolPlan(config, results, proof);
  const plannedPoolCount = Math.max(1, plannedPools.length || 0);
  const recordedPoolIds = launchProofPoolIds(proof);
  const liquidityEvidence = comparisonLiquidityEvidenceState(proof, { plannedPoolCount });
  return recordedPoolIds.length === plannedPoolCount
    && liquidityEvidence.poolCount === recordedPoolIds.length
    && !liquidityEvidence.missing.includes('pool count');
}

function v2LiquidityTransactionEvidenceCounts(results = []) {
  const pools = Array.isArray(results) ? results : [];
  const positions = pools.flatMap((pool) => v2ReportPositionList(pool));
  const feeKeyRecipientRows = pools.flatMap((pool) => (
    Array.isArray(pool?.mainPositions) ? pool.mainPositions : []
  )).filter((position) => String(position?.recipient || '').trim());
  return {
    poolCreateTxCount: pools.filter((pool) => (
      String(pool?.poolId || pool?.id || '').trim()
      && String(pool?.txIds?.createPool || pool?.createPoolTx || '').trim()
    )).length,
    openTxCount: positions.filter((position) => (
      String(position?.positionNftMint || position?.nftMint || position?.positionMint || '').trim()
      && String(position?.txIds?.open || position?.openTx || '').trim()
    )).length,
    lockTxCount: positions.filter((position) => (
      position?.locked === true
      && String(position?.txIds?.lock || position?.lockTx || '').trim()
    )).length,
    feeKeyRecipientRows,
    feeKeyRecipientTransferred: feeKeyRecipientRows.filter((position) => (
      String(position?.transferredTo || '').trim() === String(position?.recipient || '').trim()
      && String(position?.txIds?.transfer || position?.transferTx || '').trim()
    )).length,
  };
}

function proofHasReportPublishEvidence(proof = {}, config = currentLaunchConfig()) {
  if (!proofHasReportablePoolIdentity(proof, config)) return false;
  const tokenAuthorityFields = ['mintAuthorityRenounced', 'freezeAuthorityDisabled', 'metadataUpdateAuthorityRevoked', 'metadataImmutable'];
  if (!tokenAuthorityFields.every((field) => proof?.token?.[field] === true)) return false;
  const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const plannedPools = buildV2ReportPoolPlan(config, results, proof);
  const plannedPoolCount = Math.max(1, plannedPools.length || 0);
  const plannedPositionCount = plannedPools.reduce((sum, pool) => sum + Number(pool.plannedPositionCount || 0), 0);
  const txEvidence = v2LiquidityTransactionEvidenceCounts(results);
  const liquidityEvidence = comparisonLiquidityEvidenceState(proof, {
    plannedPoolCount,
    plannedPositionCount,
  });
  const recordedPositionCount = liquidityEvidence.positionCount;
  const lockedPositionCount = liquidityEvidence.lockedPositionCount;
  const feeKeyCount = liquidityEvidence.feeKeyCount;
  const feeKeyRecipientTarget = txEvidence.feeKeyRecipientRows.length;
  return Boolean(
    plannedPositionCount > 0
    && txEvidence.poolCreateTxCount >= plannedPoolCount
    && recordedPositionCount >= plannedPositionCount
    && txEvidence.openTxCount >= recordedPositionCount
    && !liquidityEvidence.missing.some((item) => ['position count', 'position records'].includes(item))
    && lockedPositionCount >= recordedPositionCount
    && txEvidence.lockTxCount >= recordedPositionCount
    && !liquidityEvidence.missing.includes('lock count')
    && feeKeyCount >= lockedPositionCount
    && !liquidityEvidence.missing.includes('fee key count')
    && txEvidence.feeKeyRecipientTransferred >= feeKeyRecipientTarget
  );
}

function proofCanCreateLocalDossier(proof = {}, config = currentLaunchConfig()) {
  if (!proof || typeof proof !== 'object') return false;
  if (!String(proof?.token?.mint || '').trim()) return false;
  const plannedPoolCount = Math.max(1, Number(config?.poolTopology?.pools?.length || 0));
  return launchProofPoolIds(proof).length >= plannedPoolCount;
}


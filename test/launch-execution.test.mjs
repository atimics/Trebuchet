import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createLaunchExecutionServices, claimLaunchOperation, LaunchRejection } from '../launchExecution.js';
import { RecoveryStorageError } from '../packages/runtime/src/store.js';

const wallet = Keypair.fromSeed(new Uint8Array(32).fill(6));
const destination = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58();
const input = { walletPublicKey: wallet.publicKey.toBase58(), name: 'Unit Token', symbol: 'UNIT', description: 'Unit', totalSupply: '1000', tokenMint: 'mint-a', tokenTotalSupply: '1000', tokenDecimals: 9, allocations: [{ quoteToken: 'SOL', supplyPercent: 100 }], priorResults: [], destinationWallet: destination };

function fixture() {
  const calls = [], writes = [], operations = new Map();
  const state = { empty: true, locked: false, failStage: null, removed: 0, cleared: 0, ended: 0,
    journal: { id: 'journal-a', token: { mint: 'mint-a', name: 'Unit Token', symbol: 'UNIT', totalSupply: '1000', metadataUri: 'uri-a', metadataAuthorityKept: true }, events: [] } };
  const launchJournal = {
    activeForWallet: () => state.journal,
    errorMessage: (error) => error.message,
    recordEvent: (_wallet, event) => { writes.push(event); },
    upsertForWallet: (_wallet, patch, event) => {
      if (patch.stage === state.failStage) throw new RecoveryStorageError('Injected storage failure');
      writes.push({ ...patch, event });
      state.journal = { ...state.journal, ...patch, token: { ...state.journal.token, ...patch.token } };
      return state.journal;
    },
  };
  const deps = {
    PublicKey, launchJournal,
    requireSecretPinUnlocked: () => { if (state.locked) throw new LaunchRejection(423, { success: false, code: 'SECRET_PIN_LOCKED', error: 'Unlock recovery storage.' }); },
    requireTokenCompleteForLiquidity: async () => {},
    claimLaunchOp: (key, op) => claimLaunchOperation(operations, key, op, 1000),
    clearLaunchOpInFlight: (key) => { state.cleared++; operations.delete(key); },
    resolveSigner: () => { calls.push('signer'); return { walletPublicKey: input.walletPublicKey, secretKeyArr: Array.from(wallet.secretKey) }; },
    normalizeTokenName: (v) => v, normalizeTokenSymbol: (v) => v, normalizeTokenDescription: (v) => v,
    normalizeWholeTokenSupply: (v) => v, normalizeMintFormat: () => 'token-2022',
    logoBase64FromCreateTokenInput: () => null,
    vanityAvailability: async () => ({ available: true }), vanityCaStore: { get: () => ({ secretKey: Array.from(wallet.secretKey) }), remove: () => { calls.push('candidate-remove'); } },
    createTokenWithMetaplex: async () => { calls.push('token'); return { tokenMint: 'mint-a', metadataUri: 'uri-a' }; },
    finishTokenCreation: async (args) => { calls.push(['finish', args]); return { isSafe: true, mintAuthorityRenounced: true }; },
    recordTokenJournalProgress: () => {}, registerOfficialBrandLaunch: () => {},
    launchFailureDetails: (error, context) => ({ message: error.message, ...context }),
    createPoolsAndPositions: async () => { calls.push('liquidity'); return { results: [{ poolId: 'pool-a' }] }; },
    recordLpJournalProgress: () => {}, lpProgressBegin: () => { calls.push('progress'); }, lpProgressEvent: () => {}, lpProgressEnd: () => { state.ended++; },
    revealSealedMetadataAfterLiquidity: async () => ({ success: true }),
    revealSealedMetadataForJournal: async (args) => { calls.push(['reveal', args]); return { metadataUri: 'uri-a' }; },
    materializePhase1RecoveryResults: () => ({ recoveredResults: [], blockedEvents: [] }),
    mergePriorResults: (old, recovered) => [...old, ...recovered],
    validateTransferAirdropPayload: () => {}, unsafeSweepDestinationReason: () => null,
    unverifiedDestinationReason: async () => null, findFundingWallet: async () => ({ funder: destination }),
    transferMetadataAuthority: async () => { calls.push('handoff'); },
    sweepNftsToDestination: async () => { calls.push('nfts'); return { transferred: [], errors: [] }; },
    sweepAllTokensToDestination: async () => { calls.push('tokens'); return { transferred: [], errors: [] }; },
    sweepSolToDestination: async () => { calls.push('sol'); return { solTransferred: 0.1 }; },
    finishSweepWithSolGate: async () => { calls.push('sol-gate'); return { solSweep: { solTransferred: 0.1 }, solSweepError: null, solSweepSkipped: null }; },
    checkWalletBalanceMultiToken: async (_key, options) => { assert.equal(options.commitment, 'finalized'); calls.push('verify-empty'); return { sol: state.empty ? 0 : 1, tokens: {} }; },
    isWalletEffectivelyEmpty: (balance) => balance.sol === 0,
    pendingWallets: { remove: () => { state.removed++; calls.push('remove-custody'); } },
    transferJournalSummary: (summary) => summary,
    airdropInFlight: () => false, markAirdropInFlight: () => {}, clearAirdropInFlight: () => {},
    airdropProgressBegin: () => {}, airdropProgressStep: () => {}, airdropProgressEnd: () => {},
    executeAirdrop: async ({ recipients }) => { calls.push(['airdrop', recipients]); return { transferred: recipients, failed: [] }; },
  };
  return { calls, writes, state, deps, operations, services: () => createLaunchExecutionServices(deps) };
}

test('all six ordinary services return results and release their wallet admission', async () => {
  for (const method of ['createToken', 'finishToken', 'revealMetadata', 'createLiquidity', 'resumeLiquidity', 'transferAssets']) {
    const f = fixture();
    const result = await f.services()[method]({ ...input });
    assert.equal(result.success, true, method);
    assert.equal(f.state.cleared, 1, method);
    assert.equal(f.operations.size, 0, method);
  }
});

test('concurrent liquidity requests preserve the active request and its progress', async () => {
  const f = fixture();
  let complete, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { complete = resolve; });
  f.deps.createPoolsAndPositions = async () => { entered(); await gate; return { results: [{ poolId: 'pool-a' }] }; };
  const services = f.services();
  const first = services.createLiquidity(input);
  await started;
  const priorWrites = f.writes.length;
  await assert.rejects(services.resumeLiquidity(input), (error) => error instanceof LaunchRejection && error.statusCode === 409 && error.code === 'OP_IN_FLIGHT');
  assert.equal(f.writes.length, priorWrites);
  assert.equal(f.state.ended, 0);
  assert.equal(f.state.cleared, 0);
  assert.equal(f.operations.get(input.walletPublicKey).op, 'create-lp');
  complete();
  assert.equal((await first).success, true);
  assert.equal(f.state.ended, 1);
  assert.equal(f.operations.size, 0);
});

test('early input and custody checks preserve journals and stop before signing', async () => {
  const f = fixture();
  f.state.locked = true;
  await assert.rejects(f.services().createToken(input), { code: 'SECRET_PIN_LOCKED' });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.writes, []);
  f.state.locked = false;
  await assert.rejects(f.services().transferAssets({ ...input, destinationWallet: 'bad-address' }), (error) => error instanceof LaunchRejection && error.statusCode === 400);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.writes, []);
});

test('a rejected liquidity recipient stops before wallet admission', async () => {
  const f = fixture();
  f.deps.unverifiedDestinationReason = async () => 'Prove the destination first.';
  await assert.rejects(f.services().createLiquidity({ ...input, allocations: [{ distribution: [{ recipient: destination }] }] }), (error) => error instanceof LaunchRejection && error.statusCode === 400);
  assert.equal(f.operations.size, 0);
  assert.equal(f.state.cleared, 0);
  assert.equal(f.state.ended, 0);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.calls, ['signer']);
});

test('a failed initial journal commit stops token creation and releases admission', async () => {
  const f = fixture();
  f.state.failStage = 'token_create_started';
  await assert.rejects(f.services().createToken(input), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(f.calls.includes('token'), false);
  assert.equal(f.operations.size, 0);
});

test('token recovery receives saved metadata authority choices and records its result', async () => {
  const f = fixture();
  await f.services().finishToken(input);
  const args = f.calls.find((call) => Array.isArray(call) && call[0] === 'finish')[1];
  assert.equal(args.keepMetadataAuthority, true);
  assert.equal(args.tokenMint, f.state.journal.token.mint);
  assert.equal(args.metadataUri, 'uri-a');
  assert.equal(f.state.journal.stage, 'token_created');
});

test('an existing vanity mint is adopted through the service failure path', async () => {
  const f = fixture();
  f.deps.createTokenWithMetaplex = async () => { throw new Error('account already in use'); };
  await assert.rejects(f.services().createToken({ ...input, vanityCAPublicKey: 'mint-saved' }), { code: 'TOKEN_ACCOUNT_ALREADY_EXISTS' });
  assert.equal(f.state.journal.token.mint, 'mint-saved');
  assert.equal(f.state.journal.stage, 'token_account_exists');
  assert.equal(f.calls.includes('candidate-remove'), false);
  assert.equal(f.operations.size, 0);
});

test('liquidity failures retain public recovery details for every caller', async () => {
  const f = fixture();
  const partialResults = [{ poolId: 'existing-pool' }], lockFailures = [{ nftMint: 'position-a' }];
  f.deps.createPoolsAndPositions = async () => { throw Object.assign(new Error('Lock needs recovery'), { code: 'LOCK_PENDING', failedPhase: 'locks', partialResults, lockFailures, statusCode: 503 }); };
  await assert.rejects(f.services().createLiquidity(input), (error) => {
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, 'LOCK_PENDING');
    assert.deepEqual(error.payload.partialResults, partialResults);
    assert.deepEqual(error.payload.lockFailures, lockFailures);
    return true;
  });
  assert.equal(f.state.journal.stage, 'lp_locks_failed');
  assert.equal(f.state.ended, 1);
  assert.equal(f.operations.size, 0);
});

test('metadata authority handoff finishes before asset transfer', async () => {
  const f = fixture();
  f.deps.transferMetadataAuthority = async () => { throw new Error('Handoff failed'); };
  await assert.rejects(f.services().transferAssets({ ...input, keepMetadataAuthorityMint: 'mint-a' }), /Handoff failed/);
  assert.equal(f.calls.includes('nfts'), false);
  assert.equal(f.state.removed, 0);
  assert.equal(f.operations.size, 0);
});

test('transfer resumes its airdrop with the remaining recipients', async () => {
  const f = fixture();
  const a = { wallet: destination, tokens: 1 }, b = { wallet: input.walletPublicKey, tokens: 2 };
  f.state.journal.airdrop = { transferred: [a], failed: [] };
  const result = await f.services().transferAssets({ ...input, airdrop: { tokenMint: 'mint-a', tokenDecimals: 9, recipients: [a, b] } });
  assert.deepEqual(f.calls.find((call) => Array.isArray(call) && call[0] === 'airdrop')[1], [b]);
  assert.deepEqual(result.airdrop.transferred, [a, b]);
  assert.equal(result.walletEmpty, true);
});

test('recovery material stays available until the final empty-wallet receipt is committed', async () => {
  const f = fixture();
  f.state.failStage = 'transfer_completed';
  await assert.rejects(f.services().transferAssets(input), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(f.state.removed, 0);
});

test('a remaining wallet balance keeps recovery material and reports partial transfer', async () => {
  const f = fixture();
  f.state.empty = false;
  const result = await f.services().transferAssets(input);
  assert.equal(result.walletEmpty, false);
  assert.equal(result.hasPartialFailure, true);
  assert.equal(f.state.removed, 0);
});

for (const method of ['createLiquidity', 'resumeLiquidity']) {
  test(`${method} stops at a failed liquidity checkpoint`, async () => {
    const f = fixture();
    const failure = new RecoveryStorageError('checkpoint write failed');
    let laterTransactions = 0;
    f.deps.recordLpJournalProgress = () => { throw failure; };
    f.deps.createPoolsAndPositions = async ({ onProgress }) => {
      onProgress({ stage: 'pool_create_done', poolId: 'pool-a' });
      laterTransactions++;
      return { results: [] };
    };
    await assert.rejects(f.services()[method](input), (error) => error === failure);
    assert.equal(laterTransactions, 0);
    assert.equal(f.operations.size, 0);
    assert.equal(f.writes.some((event) => /_failed$/.test(event.stage)), false);
  });
}

test('a failed airdrop receipt stops before the token and SOL sweeps', async () => {
  const f = fixture();
  const failure = new RecoveryStorageError('airdrop receipt write failed');
  f.deps.launchJournal.upsertForWallet = (_key, patch) => {
    if (patch.airdrop) throw failure;
  };
  await assert.rejects(f.services().transferAssets({
    ...input, airdrop: { tokenMint: input.tokenMint, tokenDecimals: 9, recipients: [{ wallet: destination, tokens: 1 }] },
  }), (error) => error === failure);
  assert.equal(f.calls.includes('tokens'), false);
  assert.equal(f.calls.includes('sol-gate'), false);
  assert.equal(f.state.removed, 0);
});

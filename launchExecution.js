import { throwIfExecutionPaused } from './chainRetry.js';
import { mergeTransferReceipts } from './sweepOrchestrator.js';
// Live launch services use ordinary inputs and shared host interfaces.
// HTTP routes translate the result; the runtime can call these methods directly.

export class LaunchRejection extends Error {
  constructor(statusCode, payload) {
    super(payload.error || 'Launch needs attention');
    this.name = 'LaunchRejection';
    this.statusCode = statusCode;
    this.payload = payload;
    if (payload.code) this.code = payload.code;
  }
}

export function claimLaunchOperation(operations, walletPublicKey, operation, now = Date.now()) {
  if (!walletPublicKey) throw new LaunchRejection(400, { success: false, error: 'A launch wallet is required.' });
  const current = operations.get(walletPublicKey);
  if (current) {
    const runningForSec = Math.round((now - current.startedAt) / 1000);
    throw new LaunchRejection(409, {
      success: false, code: 'OP_IN_FLIGHT', op: current.op, runningForSec,
      error: `This wallet is running '${current.op}' (${runningForSec}s). Wait for that operation to finish.`,
    });
  }
  operations.set(walletPublicKey, { op: operation, startedAt: now });
}

function serviceError(error, fallbackStatus = 500) {
  if (error?.statusCode || error?.status) return error;
  return Object.assign(error, { statusCode: fallbackStatus });
}

export function createLaunchExecutionServices({
  PublicKey,
  airdropInFlight,
  airdropProgressBegin,
  airdropProgressEnd,
  airdropProgressStep,
  checkWalletBalanceMultiToken,
  claimLaunchOp,
  clearAirdropInFlight,
  clearLaunchOpInFlight,
  createPoolsAndPositions,
  createTokenWithMetaplex,
  executeAirdrop,
  prepareAirdrop,
  reconcileAirdrop,
  findFundingWallet,
  finishSweepWithSolGate,
  finishTokenCreation,
  isWalletEffectivelyEmpty,
  launchFailureDetails,
  launchJournal,
  logoBase64FromCreateTokenInput,
  lpProgressBegin,
  lpProgressEnd,
  lpProgressEvent,
  markAirdropInFlight,
  materializePhase1RecoveryResults,
  mergePriorResults,
  normalizeMintFormat,
  normalizeTokenDescription,
  normalizeTokenName,
  normalizeTokenSymbol,
  normalizeVanityTargetBase58,
  normalizeWholeTokenSupply,
  pendingWallets,
  recordLpJournalProgress,
  recordTokenJournalProgress,
  reconcileWalletOperation,
  reconcileBeforeLiquidity,
  getTransferReceipts,
  registerOfficialBrandLaunch,
  requireSecretPinUnlocked,
  requireTokenCompleteForLiquidity,
  resolveSigner,
  revealSealedMetadataAfterLiquidity,
  revealSealedMetadataForJournal,
  sweepAllTokensToDestination,
  sweepNftsToDestination,
  sweepSolToDestination,
  transferJournalSummary,
  transferMetadataAuthority,
  unsafeSweepDestinationReason,
  unverifiedDestinationReason,
  validateTransferAirdropPayload,
  vanityAvailability,
  vanityCaStore,
}) {
  async function finishToken(input = {}) {
    let walletPublicKey = null;
    let claimedLaunchOp = false;
    try {
      if (input.walletPublicKey) requireSecretPinUnlocked('finishing an interrupted token creation');
      const resolvedSigner = resolveSigner({
        tempWalletSecretKey: input.tempWalletSecretKey,
        walletPublicKey: input.walletPublicKey,
      });
      const { secretKeyArr } = resolvedSigner;
      walletPublicKey = resolvedSigner.walletPublicKey;
      if (!walletPublicKey) {
        throw new LaunchRejection(400, { success: false, error: 'walletPublicKey or tempWalletSecretKey required' });
      }
      claimLaunchOp(walletPublicKey, 'finish-token-creation');
      claimedLaunchOp = true;

      const journal = launchJournal.activeForWallet(walletPublicKey);
      if (!journal || !journal.token || !journal.token.mint) {
        throw new LaunchRejection(409, {
          success: false,
          error: 'No interrupted token creation found for this wallet (no recorded mint).',
        });
      }
      const { mint, name, symbol, totalSupply } = journal.token;
      const metadataUri = journal.token.onChainMetadataUri || journal.token.metadataUri;
      if (totalSupply == null) {
        throw new LaunchRejection(409, {
          success: false,
          error: 'The recorded token entry is missing its supply; cannot safely finish it.',
        });
      }

      const status = await finishTokenCreation({
        tempWalletSecretKey: secretKeyArr,
        tokenMint: mint,
        name,
        symbol,
        totalSupply,
        metadataUri,
        metadataHash: journal.token.metadataHash,
        journalEvents: journal.events || [],
        sealedLaunch: journal.token.sealedLaunch === true,
        keepMetadataAuthority: journal.token?.metadataAuthorityKept === true,
        onProgress: (event) => recordTokenJournalProgress(walletPublicKey, event),
      });

      // Reflect the finished state back into the journal. Merge onto the existing
      // token record so the name/symbol/uri already there are preserved. Once the
      // mint authority is renounced the token is usable, so we move the stage back
      // to 'token_created' and let the normal flow continue.
      launchJournal.upsertForWallet(
        walletPublicKey,
        {
          status: 'active',
          stage: status.mintAuthorityRenounced ? 'token_created' : 'token_create_finished',
          error: null,
          token: {
            ...journal.token,
            mintAuthorityRenounced: status.mintAuthorityRenounced,
            mintFormat: status.mintFormat || journal.token.mintFormat,
            tokenProgram: status.tokenProgram || journal.token.tokenProgram,
            metadataStandard: status.metadataStandard || journal.token.metadataStandard,
            metadataPointerAuthorityRevoked: status.metadataPointerAuthorityRevoked
              ?? journal.token.metadataPointerAuthorityRevoked,
            metadataUpdateAuthorityRevoked: status.updateAuthorityRevoked,
            metadataImmutable: status.updateAuthorityRevoked && journal.token.sealedLaunch !== true,
            sealedMetadataPending: status.sealedMetadataPending === true,
            isSafe: status.isSafe,
          },
        },
        {
          stage: 'token_create_finished',
          isSafe: status.isSafe,
          steps: status.steps,
          sanity: status.sanity,
        },
      );

      return { success: true, ...status };
    } catch (error) {
      throwIfExecutionPaused(error);
      if (error instanceof LaunchRejection) throw error;
      console.error('Error finishing token creation:', error);
      const accountStillSettling = /InvalidAccountData|invalid account data for instruction/i.test(
        [error?.message, ...(Array.isArray(error?.logs) ? error.logs : [])].filter(Boolean).join(' '),
      );
      const publicMessage = accountStillSettling
        ? 'Solana RPC has not finished propagating the token account yet. The existing mint is preserved and no supply was duplicated. Wait a few seconds, then choose Finish token safely again.'
        : error?.message || 'Trebuchet could not finish the interrupted token.';
      if (walletPublicKey) {
        launchJournal.upsertForWallet(
          walletPublicKey,
          {
            status: 'failed',
            stage: 'token_finish_failed',
            error: publicMessage,
            errorDetails: launchFailureDetails(error, { failedPhase: 'finish_token' }),
          },
          { stage: 'token_finish_failed', error: publicMessage },
        );
      }
      if (accountStillSettling) {
        const friendlyError = new Error(publicMessage);
        friendlyError.code = 'TOKEN_ACCOUNT_SETTLING';
        friendlyError.statusCode = 409;
        friendlyError.errorDetails = launchFailureDetails(error, { failedPhase: 'finish_token' });
        throw serviceError(friendlyError, 409);
      } else {
        throw serviceError(error);
      }
    } finally {
      if (claimedLaunchOp && walletPublicKey) {
        clearLaunchOpInFlight(walletPublicKey);
      }
    }
  }

  async function revealMetadata(input = {}) {
    let walletPublicKey = null;
    let claimedLaunchOp = false;
    try {
      if (input.walletPublicKey) requireSecretPinUnlocked('revealing and locking sealed token metadata');
      const signer = resolveSigner({
        tempWalletSecretKey: input.tempWalletSecretKey,
        walletPublicKey: input.walletPublicKey,
      });
      walletPublicKey = signer.walletPublicKey;
      claimLaunchOp(walletPublicKey, 'reveal-sealed-metadata');
      claimedLaunchOp = true;
      const result = await revealSealedMetadataForJournal({
        walletPublicKey,
        secretKeyArr: signer.secretKeyArr,
      });
      return { success: true, ...result };
    } catch (error) {
      throwIfExecutionPaused(error);
      if (error instanceof LaunchRejection) throw error;
      if (walletPublicKey && error?.code !== 'SEALED_METADATA_WAITING_FOR_LOCKS') {
        launchJournal.upsertForWallet(
          walletPublicKey,
          {
            status: 'active',
            stage: 'metadata_reveal_failed',
            error: launchJournal.errorMessage(error),
            errorDetails: launchFailureDetails(error, { failedPhase: 'metadata_reveal' }),
            token: { sealedMetadataPending: true },
          },
          { stage: 'metadata_reveal_failed', error: launchJournal.errorMessage(error) },
        );
      }
      throw serviceError(error, error.statusCode || 500);
    } finally {
      if (claimedLaunchOp && walletPublicKey) clearLaunchOpInFlight(walletPublicKey);
    }
  }

  async function createToken(input = {}, { logoFile } = {}) {
    let walletPublicKey = null;
    let claimedLaunchOp = false;
    try {
      const {
        tempWalletSecretKey,
        name,
        symbol,
        description,
        totalSupply,
        vanityPrefix,
        vanitySuffix,
        vanityCAKeypair: vanityCAKeypairRaw,
        vanityCAPublicKey,
        sealedLaunch,
        mintFormat,
        allocations: allocationsRaw,
        targetMarketCapUsd,
      } = input;

      const useSealedLaunch = sealedLaunch === true || sealedLaunch === 'true' || sealedLaunch === '1';
      const normalizedMintFormat = normalizeMintFormat(mintFormat);

      if (input.walletPublicKey || vanityCAPublicKey) requireSecretPinUnlocked('creating a token with saved recovery secrets');

      let normalizedVanityPrefix = String(vanityPrefix ?? '').trim();
      let normalizedVanitySuffix = String(vanitySuffix ?? '').trim();
      if (normalizedVanityPrefix || normalizedVanitySuffix) {
        try {
          ({ prefix: normalizedVanityPrefix, suffix: normalizedVanitySuffix } =
            normalizeVanityTargetBase58(normalizedVanityPrefix, normalizedVanitySuffix));
        } catch (error) {
          throw new LaunchRejection(400, { success: false, error: error.message });
        }
      }

      // If the caller asked for a fresh vanity grind (prefix/suffix) but the
      // binary isn't built, reject up front with the same 503 the dedicated
      // vanity endpoints use. Pre-ground vanity keypairs (vanityCAKeypair)
      // are fine without the binary — they were ground elsewhere and we're
      // just consuming the keypair, not running the grinder again here.
      if (normalizedVanityPrefix || normalizedVanitySuffix) {
        const vanity = await vanityAvailability();
        if (!vanity.available) {
          throw new LaunchRejection(503, {
            success: false,
            error: 'Vanity address generation is not available in this build. '
              + 'The vanity_keygen binary is not built — run `npm run build:c` '
              + '(requires gcc or clang). End-user release builds include the binary.',
          });
        }
      }

      const normalizedName = normalizeTokenName(name);
      const normalizedSymbol = normalizeTokenSymbol(symbol);
      const normalizedDescription = normalizeTokenDescription(description);
      const normalizedTotalSupply = normalizeWholeTokenSupply(totalSupply, 9);
      console.log('Creating token:', {
        name: normalizedName,
        symbol: normalizedSymbol,
        totalSupply: normalizedTotalSupply,
      });

      const logoBase64 = logoBase64FromCreateTokenInput(input, logoFile);

      const { secretKeyArr: tempWalletSecretKeyArr, walletPublicKey: resolvedWalletPublicKey } =
        resolveSigner({ tempWalletSecretKey, walletPublicKey: input.walletPublicKey });
      walletPublicKey = resolvedWalletPublicKey;
      // Per-wallet mutex — token creation runs several transactions over
      // 30-60s. A duplicate submit would mint a second, orphaned token and
      // double-spend the wallet's rent SOL.
      claimLaunchOp(walletPublicKey, 'create-token');
      claimedLaunchOp = true;
      launchJournal.upsertForWallet(
        walletPublicKey,
        {
          status: 'active',
          stage: 'token_create_started',
          token: {
            name: normalizedName,
            symbol: normalizedSymbol,
            totalSupply: normalizedTotalSupply,
            // User's metadata-authority choice, recorded up front so the
            // finish/resume path honors it even if creation crashes before
            // reaching the revoke step. FormData fields arrive as strings.
            metadataAuthorityKept: input.keepMetadataAuthority === 'true',
            decimals: 9,
            mintFormat: normalizedMintFormat,
            sealedLaunch: useSealedLaunch,
            sealedMetadataPending: useSealedLaunch,
          },
          vanityPrefix: vanityPrefix || null,
          vanitySuffix: vanitySuffix || null,
        },
        {
          stage: 'token_create_started',
          name: normalizedName,
          symbol: normalizedSymbol,
          totalSupply: normalizedTotalSupply,
        },
      );

      let vanityCAKeypair = vanityCAKeypairRaw ? JSON.parse(vanityCAKeypairRaw) : null;
      let vanityCAScalar = null;
      if (!vanityCAKeypair && vanityCAPublicKey) {
        const candidate = vanityCaStore.get(vanityCAPublicKey);
        if (!candidate) {
          throw new LaunchRejection(404, { success: false, error: 'Saved Vanity CA not found' });
        }
        if (candidate.keyType === 'scalar') {
          if (!Array.isArray(candidate.scalar)) {
            throw new LaunchRejection(409, { success: false, error: 'Saved Vanity CA secret could not be decrypted' });
          }
          vanityCAScalar = candidate.scalar;
        } else {
          if (!Array.isArray(candidate.secretKey)) {
            throw new LaunchRejection(409, {
              success: false,
              error: 'Saved Vanity CA secret could not be decrypted',
            });
          }
          vanityCAKeypair = candidate.secretKey;
        }
      }

      const result = await createTokenWithMetaplex({
        tempWalletSecretKey: tempWalletSecretKeyArr,
        name: normalizedName,
        symbol: normalizedSymbol,
        description: normalizedDescription,
        totalSupply: normalizedTotalSupply,
        logoBase64,
        vanityPrefix: normalizedVanityPrefix || null,
        vanitySuffix: normalizedVanitySuffix || null,
        vanityCAKeypair,
        vanityCAScalar,
        sealedLaunch: useSealedLaunch,
        mintFormat: normalizedMintFormat,
        keepMetadataAuthority: input.keepMetadataAuthority === 'true',
        onProgress: (event) => recordTokenJournalProgress(walletPublicKey, event),
      });
      if (vanityCAPublicKey) {
        vanityCaStore.remove(vanityCAPublicKey);
      }

      // Parse pool allocations if the frontend sent them, so the
      // crash-resume path can pick up the pool plan from the journal.
      let poolPlan = null;
      let allocations = null;
      if (allocationsRaw) {
        try { allocations = JSON.parse(allocationsRaw); } catch (_) {}
      }
      if (allocations && Array.isArray(allocations) && allocations.length > 0) {
        poolPlan = {
          tokenMint: result.tokenMint,
          tokenDecimals: 9,
          tokenTotalSupply: normalizedTotalSupply,
          targetMarketCapUsd: targetMarketCapUsd ? String(targetMarketCapUsd) : undefined,
          allocations,
          lockPositions: true,
        };
      }

      const journalPatch = {
        status: 'active',
        stage: 'token_created',
        error: null,
        token: {
          mint: result.tokenMint,
          name: normalizedName,
          symbol: normalizedSymbol,
          totalSupply: normalizedTotalSupply,
          decimals: 9,
          metadataUri: result.metadataUri,
          metadataHash: result.metadataHash || null,
          imageUri: result.imageUri || null,
          onChainMetadataUri: result.onChainMetadataUri || result.metadataUri,
          mintFormat: result.mintFormat,
          tokenProgram: result.tokenProgram,
          metadataStandard: result.metadataStandard,
          metadataPointerAuthorityRevoked: result.metadataPointerAuthorityRevoked,
          isSafe: result.isSafe,
          mintAuthorityRenounced: result.mintAuthorityRenounced,
          freezeAuthorityDisabled: result.freezeAuthorityDisabled,
          metadataUpdateAuthorityRevoked: result.metadataUpdateAuthorityRevoked,
          metadataImmutable: result.metadataImmutable,
          sealedLaunch: result.sealedLaunch === true,
          sealedMetadataPending: result.sealedMetadataPending === true,
        },
      };
      // Keep a pool plan saved before the mint; only fill one in when missing.
      if (poolPlan && !launchJournal.activeForWallet(walletPublicKey)?.poolPlan) {
        journalPatch.poolPlan = poolPlan;
      }

      launchJournal.upsertForWallet(
        walletPublicKey,
        journalPatch,
        { stage: 'token_created', tokenMint: result.tokenMint, metadataUri: result.metadataUri },
      );

      const brandJournal = launchJournal.activeForWallet(walletPublicKey);
      registerOfficialBrandLaunch({
        journal: brandJournal,
        secretKey: tempWalletSecretKeyArr,
        token: brandJournal?.token || {
          mint: result.tokenMint,
          name: normalizedName,
          symbol: normalizedSymbol,
          totalSupply: normalizedTotalSupply,
          decimals: 9,
          metadataUri: result.metadataUri,
          metadataHash: result.metadataHash,
          imageUri: result.imageUri,
          sealedLaunch: result.sealedLaunch === true,
        },
      });

      return {
        success: true,
        name: normalizedName,
        symbol: normalizedSymbol,
        totalSupply: normalizedTotalSupply,
        ...result,
      };
    } catch (error) {
      throwIfExecutionPaused(error);
      if (error instanceof LaunchRejection) throw error;
      console.error('Error creating token:', error);
      if (walletPublicKey) {
        // A mint account can already exist on-chain when an earlier attempt
        // created it but the launch did not finish (lost confirmation, crash,
        // or a failure after the account landed). Without this, the app keeps
        // retrying create-token and dies on "already in use" forever, even
        // though the app can finish an existing mint. Adopt the known address
        // so readiness routes to finish-token-creation instead.
        const existingMint = String(error?.tokenMint || input.vanityCAPublicKey || '').trim();
        const accountAlreadyInUse = /already in use|custom program error: 0x0/i.test(error?.message || '');
        if (existingMint && accountAlreadyInUse) {
          launchJournal.upsertForWallet(
            walletPublicKey,
            {
              status: 'active',
              stage: 'token_account_exists',
              token: { mint: existingMint },
              error: null,
              errorDetails: null,
            },
            {
              stage: 'token_account_adopted',
              tokenMint: existingMint,
              detail: 'Mint account already exists on-chain; adopting it so the interrupted token can be finished instead of re-created.',
            },
          );
          throw serviceError(Object.assign(
            new Error(`${error.message}\n\nTrebuchet found an existing mint at this address and switched to finishing it. Reload the launch view and run "Finish interrupted token" instead of creating.`),
            { statusCode: error.statusCode, code: 'TOKEN_ACCOUNT_ALREADY_EXISTS', tokenMint: existingMint },
          ));
        }
        launchJournal.upsertForWallet(
          walletPublicKey,
          {
            status: 'failed',
            stage: 'token_create_failed',
            error: error.message,
          },
          { stage: 'token_create_failed', error: error.message },
        );
      }
      throw serviceError(error);
    } finally {
      // Release the per-wallet operation lock if we claimed it.
      if (claimedLaunchOp && walletPublicKey) {
        clearLaunchOpInFlight(walletPublicKey);
      }
    }
  }

  async function createLiquidity(input = {}) {

    let walletPublicKey = null;
    let claimedLaunchOp = false;
    try {
      const {
        tempWalletSecretKey,
        tokenMint,
        tokenDecimals,
        tokenTotalSupply,
        targetMarketCapUsd,
        allocations,
        lockPositions,
      } = input;

      console.log('Creating LP for token:', tokenMint);
      console.log(`Allocations: ${(allocations || []).map((allocation) => `${allocation.quoteSymbolOverride || allocation.quoteToken || '?'} ${allocation.supplyPercent}%`).join(', ')}`);

      await requireTokenCompleteForLiquidity({
        tokenMint,
        tokenTotalSupply,
        tokenDecimals: tokenDecimals || 9,
      });

      if (input.walletPublicKey) requireSecretPinUnlocked('creating liquidity pools with a saved launch wallet');
      const { secretKeyArr, walletPublicKey: resolvedWalletPublicKey } =
        resolveSigner({ tempWalletSecretKey, walletPublicKey: input.walletPublicKey });
      walletPublicKey = resolvedWalletPublicKey;
      // Fee Keys sent to a slice recipient leave the launch wallet for good, so
      // each recipient must be a proven wallet, like the final sweep.
      const feeKeyRecipients = [...new Set((Array.isArray(allocations) ? allocations : [])
        .flatMap((allocation) => (Array.isArray(allocation?.distribution) ? allocation.distribution : []))
        .map((slice) => String(slice?.recipient || '').trim())
        .filter(Boolean))];
      if (feeKeyRecipients.length) {
        const funder = (await findFundingWallet(walletPublicKey).catch(() => null))?.funder || null;
        for (const recipient of feeKeyRecipients) {
          const reason = unsafeSweepDestinationReason(recipient, { launchWallet: walletPublicKey })
            || await unverifiedDestinationReason(recipient, walletPublicKey, { funder });
          if (reason) {
            walletPublicKey = null;
            throw new LaunchRejection(400, { success: false, error: `Refusing to send Fee Keys: ${reason}` });
          }
        }
      }
      // Per-wallet mutex: reject if any other launch operation is running
      // for this wallet (a prior create-lp that's still going after a
      // renderer reload, a transfer, an acquire job). See the long comment
      // on launchOpsInFlight for why this matters. On rejection the
      // response has already been sent — bail out without touching the
      // journal (the running operation owns it). claimedLaunchOp tells the
      // finally block whether WE hold the lock (and must release it) or
      // someone else does (leave it alone).
      claimLaunchOp(walletPublicKey, 'create-lp');
      claimedLaunchOp = true;
      await reconcileBeforeLiquidity({ tempWalletSecretKey: secretKeyArr, tokenMint });
      const poolPlan = {
        tokenMint,
        tokenDecimals: tokenDecimals || 9,
        tokenTotalSupply,
        targetMarketCapUsd,
        allocations,
        lockPositions: lockPositions !== false,
        // The configured airdrop (recipients + token identity), journaled so
        // a resume after an app restart can restore the plan — the transfer
        // step otherwise builds it from frontend state that didn't survive.
        // Plan data only; the airdrop executes in /api/transfer-assets.
        airdropPlan: (input.airdrop
          && Array.isArray(input.airdrop.recipients)
          && input.airdrop.recipients.length > 0)
          ? input.airdrop
          : null,
      };
      launchJournal.upsertForWallet(
        walletPublicKey,
        {
          status: 'active',
          stage: 'lp_create_started',
          poolPlan,
          error: null,
          errorDetails: null,
        },
        { stage: 'lp_create_started', tokenMint, allocationCount: allocations?.length || 0 },
      );

      // Begin live LP progress tracking. Same in-memory Map the demo uses;
      // the frontend polls /api/lp-progress during the create-lp call and
      // ticks rows from pending → done as events arrive. Real-mode events
      // already have the stage names the frontend translator expects
      // (pool_create_done, main_open_done, etc.) so no shape conversion
      // is needed. End in finally below.
      lpProgressBegin(walletPublicKey);

      const result = await createPoolsAndPositions({
        tempWalletSecretKey: secretKeyArr,
        tokenMint,
        tokenDecimals: tokenDecimals || 9,
        tokenTotalSupply,
        targetMarketCapUsd,
        allocations,
        lockPositions: lockPositions !== false,
        onProgress: (event) => {
          // Journal: durable record for recovery if the launch dies.
          recordLpJournalProgress(walletPublicKey, event);
          // Live progress tracker: drives the frontend's per-row updates.
          try { lpProgressEvent(walletPublicKey, event); }
          catch (_) { /* UI progress is best-effort. */ }
        },
      });

      launchJournal.upsertForWallet(
        walletPublicKey,
        {
          status: 'active',
          stage: 'lp_created',
          error: null,
          errorDetails: null,
          lp: {
            results: result.results || [],
            partialResults: null,
            failedPhase: null,
            failedAllocationIndex: null,
            bootstrapFailures: null,
            lockFailures: null,
            transferFailures: null,
          },
        },
        { stage: 'lp_created', poolCount: result.results?.length || 0 },
      );

      let metadataReveal = null;
      try {
        metadataReveal = await revealSealedMetadataAfterLiquidity({
          walletPublicKey,
          secretKeyArr,
        });
      } catch (revealError) {
        throwIfExecutionPaused(revealError);
        metadataReveal = { success: false, error: launchJournal.errorMessage(revealError) };
        launchJournal.upsertForWallet(
          walletPublicKey,
          {
            status: 'active',
            stage: 'metadata_reveal_failed',
            error: metadataReveal.error,
            token: { sealedMetadataPending: true },
          },
          { stage: 'metadata_reveal_failed', error: metadataReveal.error },
        );
      }

      return { success: true, ...result, metadataReveal };
    } catch (error) {
      throwIfExecutionPaused(error);
      if (error instanceof LaunchRejection) throw error;
      const message = launchJournal.errorMessage(error);
      const errorDetails = launchFailureDetails(error, {
        route: 'create-lp',
        failedPhase: error.failedPhase || 'unknown',
        failedAllocationIndex: error.failedAllocationIndex ?? null,
        partialResultCount: error.partialResults?.length || 0,
      });
      console.error('Error creating LP:', error);
      if (walletPublicKey) {
        launchJournal.upsertForWallet(
          walletPublicKey,
          {
            status: 'failed',
            stage: `lp_${error.failedPhase || 'unknown'}_failed`,
            error: message,
            errorDetails,
            lp: {
              partialResults: error.partialResults || [],
              failedAllocationIndex: error.failedAllocationIndex,
              failedAllocation: error.failedAllocation,
              failedPhase: error.failedPhase,
              bootstrapFailures: error.bootstrapFailures || null,
              lockFailures: error.lockFailures || null,
              transferFailures: error.transferFailures || null,
            },
          },
          {
            stage: `lp_${error.failedPhase || 'unknown'}_failed`,
            error: message,
            errorDetails,
            failedPhase: error.failedPhase,
            partialResultCount: error.partialResults?.length || 0,
          },
        );
      }
      throw new LaunchRejection(error.statusCode || 500, {
        success: false,
        ...(error.code ? { code: error.code } : {}),
        ...(error.code === 'SECRET_PIN_LOCKED' ? { secretPinLocked: true } : {}),
        error: message,
        errorDetails,
        partialResults: error.partialResults || [],
        failedAllocationIndex: error.failedAllocationIndex,
        failedAllocation: error.failedAllocation,
        // 'pre_flight', 'main_positions', 'bootstrap', 'locks', or 'transfers' —
        // tells the frontend which phase failed so it can render the progress
        // tree correctly and decide retry semantics:
        //   - pre_flight: nothing on-chain happened, fix config and retry
        //   - main_positions: pool may have been created, current behaviour
        //     is to require a sweep; mid-Phase-1 partial recovery is a
        //     larger refactor for later
        //   - bootstrap: main positions intact, retry bootstraps only
        //   - locks: positions all open, retry the lock phase only
        //   - transfers: positions locked, un-transferred Fee Keys will
        //     sweep to user's destination (transfer failure is non-blocking)
        failedPhase: error.failedPhase,
        // When phase 2 reports multiple failed bootstraps, the orchestrator
        // attaches the full list here. Phase 1 only ever has one failure
        // (it aborts on first failure) so failedAllocationIndex is enough
        // there; phase 2 keeps going past individual failures and may have
        // several. Frontend uses this to mark every failed pool's bootstrap
        // row, not just one.
        bootstrapFailures: error.bootstrapFailures || null,
        // Phase 3 and Phase 4 failure arrays. Same shape as
        // bootstrapFailures: each entry pinpoints which allocation/slice
        // failed and why. The frontend uses these to render per-position
        // failure markers and offer targeted retry.
        lockFailures: error.lockFailures || null,
        transferFailures: error.transferFailures || null,
      });
    } finally {
      // Always end the live LP progress tracker so the frontend's poll
      // sees status='done' and stops. The tracker auto-cleans 30 seconds
      // later, leaving time for any in-flight poll to see the final state.
      if (claimedLaunchOp && walletPublicKey) {
        try { lpProgressEnd(walletPublicKey); }
        catch (_) { /* UI cleanup is best-effort. */ }
      }
      // Release the per-wallet operation lock — but only if WE claimed it.
      // A 409 rejection path never sets claimedLaunchOp, so we don't
      // release a lock owned by the still-running operation.
      if (claimedLaunchOp && walletPublicKey) {
        clearLaunchOpInFlight(walletPublicKey);
      }
    }
  }

  async function resumeLiquidity(input = {}) {

    let walletPublicKey = null;
    let claimedLaunchOp = false;
    try {
      const {
        tempWalletSecretKey,
        tokenMint,
        tokenDecimals,
        tokenTotalSupply,
        targetMarketCapUsd,
        allocations,
        lockPositions,
        priorResults,
      } = input;

      if (!Array.isArray(allocations) || allocations.length === 0) {
        throw new Error('allocations array is required');
      }
      if (!Array.isArray(priorResults)) {
        throw new Error('priorResults must be an array (use [] for a fresh launch)');
      }
      await requireTokenCompleteForLiquidity({
        tokenMint,
        tokenTotalSupply,
        tokenDecimals: tokenDecimals || 9,
      });

      console.log(
        `Resuming launch for ${tokenMint}: ${priorResults.length}/${allocations.length} ` +
          `allocation(s) carried over from prior attempt`,
      );

      if (input.walletPublicKey) requireSecretPinUnlocked('resuming a launch with a saved launch wallet');
      const { secretKeyArr, walletPublicKey: resolvedWalletPublicKey } =
        resolveSigner({ tempWalletSecretKey, walletPublicKey: input.walletPublicKey });
      walletPublicKey = resolvedWalletPublicKey;
      // Per-wallet mutex — same protection as /api/create-lp. The classic
      // hazard here: the original create-lp is still running after a UI
      // reload, the user recovers the wallet and clicks Resume. Without
      // this guard, two orchestrators would race over the same positions.
      claimLaunchOp(walletPublicKey, 'resume-launch');
      claimedLaunchOp = true;
      await reconcileBeforeLiquidity({ tempWalletSecretKey: secretKeyArr, tokenMint });

      const activeJournal = launchJournal.activeForWallet(walletPublicKey);
      const phase1Recovery = materializePhase1RecoveryResults(
        activeJournal || {},
        priorResults,
        allocations,
      );
      let effectivePriorResults = mergePriorResults(priorResults, phase1Recovery.recoveredResults);
      if (phase1Recovery.blockedEvents.length > 0) {
        const pools = phase1Recovery.blockedEvents.map((event) => event.poolId).filter(Boolean).join(', ');
        const message =
          'This launch recorded ambiguous partial pool state that Trebuchet cannot safely ' +
          'resume automatically without risking duplicate or skipped LP work. ' +
          `Sweep the launch wallet or recover the existing LP positions manually${pools ? `; recorded pool(s): ${pools}` : ''}.`;
        const errorDetails = {
          code: 'UNSAFE_PARTIAL_POOL_STATE',
          route: 'resume-launch',
          failedPhase: 'main_positions',
          priorResultCount: effectivePriorResults.length,
          unsafePoolEvents: phase1Recovery.blockedEvents,
        };
        launchJournal.upsertForWallet(
          walletPublicKey,
          {
            status: 'failed',
            stage: 'lp_main_positions_failed',
            error: message,
            errorDetails,
            lp: {
              priorResults: effectivePriorResults,
              failedPhase: 'main_positions',
            },
          },
          {
            stage: 'lp_resume_blocked_unsafe_partial',
            error: message,
            errorDetails,
            failedPhase: 'main_positions',
            priorResultCount: effectivePriorResults.length,
            unsafePoolEventCount: phase1Recovery.blockedEvents.length,
          },
        );
        throw new LaunchRejection(409, {
          success: false,
          code: 'UNSAFE_PARTIAL_POOL_STATE',
          manualRecoveryRequired: true,
          failedPhase: 'main_positions',
          partialResults: effectivePriorResults,
          unsafePoolEvents: phase1Recovery.blockedEvents,
          error: message,
          errorDetails,
        });
      }
      if (phase1Recovery.recoveredResults.length > 0) {
        launchJournal.upsertForWallet(
          walletPublicKey,
          {
            lp: {
              partialResults: effectivePriorResults,
              priorResults: effectivePriorResults,
            },
          },
          {
            stage: 'lp_phase1_recovery_prepared',
            recoveredAllocationCount: phase1Recovery.recoveredResults.length,
            priorResultCount: effectivePriorResults.length,
          },
        );
      }

      launchJournal.upsertForWallet(
        walletPublicKey,
        {
          status: 'active',
          stage: 'lp_resume_started',
          error: null,
          errorDetails: null,
          poolPlan: {
            tokenMint,
            tokenDecimals: tokenDecimals || 9,
            tokenTotalSupply,
            targetMarketCapUsd,
            allocations,
            lockPositions: lockPositions !== false,
          },
          lp: phase1Recovery.recoveredResults.length > 0
            ? { priorResults: effectivePriorResults, partialResults: effectivePriorResults }
            : { priorResults: effectivePriorResults },
        },
        {
          stage: 'lp_resume_started',
          tokenMint,
          priorResultCount: effectivePriorResults.length,
          allocationCount: allocations.length,
          phase1RecoveryCount: phase1Recovery.recoveredResults.length,
        },
      );

      // Begin live LP progress tracking for the resume too. The frontend
      // polls /api/lp-progress identically whether this is a fresh launch
      // or a resume, so the events surface as live row updates.
      lpProgressBegin(walletPublicKey);

      const result = await createPoolsAndPositions({
        tempWalletSecretKey: secretKeyArr,
        tokenMint,
        tokenDecimals: tokenDecimals || 9,
        tokenTotalSupply,
        targetMarketCapUsd,
        allocations,
        lockPositions: lockPositions !== false,
        priorResults: effectivePriorResults,
        onProgress: (event) => {
          recordLpJournalProgress(walletPublicKey, event);
          try { lpProgressEvent(walletPublicKey, event); }
          catch (_) { /* UI progress is best-effort. */ }
        },
      });

      launchJournal.upsertForWallet(
        walletPublicKey,
        {
          status: 'active',
          stage: 'lp_created',
          error: null,
          errorDetails: null,
          lp: {
            results: result.results || [],
            partialResults: null,
            failedPhase: null,
            failedAllocationIndex: null,
            bootstrapFailures: null,
            lockFailures: null,
            transferFailures: null,
          },
        },
        { stage: 'lp_created', poolCount: result.results?.length || 0 },
      );

      let metadataReveal = null;
      try {
        metadataReveal = await revealSealedMetadataAfterLiquidity({
          walletPublicKey,
          secretKeyArr,
        });
      } catch (revealError) {
        throwIfExecutionPaused(revealError);
        metadataReveal = { success: false, error: launchJournal.errorMessage(revealError) };
        launchJournal.upsertForWallet(
          walletPublicKey,
          {
            status: 'active',
            stage: 'metadata_reveal_failed',
            error: metadataReveal.error,
            token: { sealedMetadataPending: true },
          },
          { stage: 'metadata_reveal_failed', error: metadataReveal.error },
        );
      }

      return { success: true, ...result, metadataReveal };
    } catch (error) {
      throwIfExecutionPaused(error);
      if (error instanceof LaunchRejection) throw error;
      const message = launchJournal.errorMessage(error);
      const errorDetails = launchFailureDetails(error, {
        route: 'resume-launch',
        failedPhase: error.failedPhase || 'resume',
        failedAllocationIndex: error.failedAllocationIndex ?? null,
        partialResultCount: error.partialResults?.length || 0,
      });
      console.error('Error resuming launch:', error);
      if (walletPublicKey) {
        launchJournal.upsertForWallet(
          walletPublicKey,
          {
            status: 'failed',
            stage: `lp_${error.failedPhase || 'resume'}_failed`,
            error: message,
            errorDetails,
            lp: {
              partialResults: error.partialResults || [],
              failedAllocationIndex: error.failedAllocationIndex,
              failedAllocation: error.failedAllocation,
              failedPhase: error.failedPhase,
              bootstrapFailures: error.bootstrapFailures || null,
              lockFailures: error.lockFailures || null,
              transferFailures: error.transferFailures || null,
            },
          },
          {
            stage: `lp_${error.failedPhase || 'resume'}_failed`,
            error: message,
            errorDetails,
            failedPhase: error.failedPhase,
            partialResultCount: error.partialResults?.length || 0,
          },
        );
      }
      throw new LaunchRejection(error.statusCode || 500, {
        success: false,
        ...(error.code ? { code: error.code } : {}),
        ...(error.code === 'SECRET_PIN_LOCKED' ? { secretPinLocked: true } : {}),
        error: message,
        errorDetails,
        partialResults: error.partialResults || [],
        failedAllocationIndex: error.failedAllocationIndex,
        failedAllocation: error.failedAllocation,
        failedPhase: error.failedPhase,
        bootstrapFailures: error.bootstrapFailures || null,
        lockFailures: error.lockFailures || null,
        transferFailures: error.transferFailures || null,
      });
    } finally {
      // Same end-the-tracker pattern as /api/create-lp above. Resumes use
      // the same lpProgress Map keyed by wallet pubkey, so a resume that
      // succeeds (or fails) cleanly tears down the tracker without
      // requiring the frontend to know which endpoint fired the work.
      if (claimedLaunchOp && walletPublicKey) {
        try { lpProgressEnd(walletPublicKey); }
        catch (_) { /* UI cleanup is best-effort. */ }
      }
      // Release the per-wallet operation lock if we claimed it (409
      // rejections never claim, so they never release someone else's).
      if (claimedLaunchOp && walletPublicKey) {
        clearLaunchOpInFlight(walletPublicKey);
      }
    }
  }

  async function runAirdrop(input = {}) {
    let walletPublicKey = null, claimed = false, tracking = false;
    try {
      try { validateTransferAirdropPayload(input); }
      catch (error) { throw new LaunchRejection(400, { success: false, error: error.message }); }
      if (!input.tempWalletSecretKey && !input.walletPublicKey) throw new LaunchRejection(400, { success: false, error: 'Provide a saved launch wallet or its signer.' });
      if (!Array.isArray(input.recipients) || !input.recipients.length) throw new LaunchRejection(400, { success: false, error: 'Provide the airdrop recipients.' });
      if (input.walletPublicKey) requireSecretPinUnlocked('running an airdrop with a saved wallet');
      const signer = resolveSigner(input);
      walletPublicKey = signer.walletPublicKey;
      claimLaunchOp(walletPublicKey, 'run-airdrop'); claimed = true;
      prepareAirdrop({ walletPublicKey, airdrop: input });
      await reconcileAirdrop({ tempWalletSecretKey: signer.secretKeyArr, tokenMint: input.tokenMint });
      const priorAirdrop = launchJournal.activeForWallet(walletPublicKey)?.airdrop || {};
      const priorDelivered = priorAirdrop.transferred || [], deliveredWallets = new Set(priorDelivered.map((row) => row.wallet));
      const recipients = input.recipients;
      const pendingRecipients = recipients.filter((r) => !deliveredWallets.has(r.wallet));
      markAirdropInFlight(walletPublicKey); tracking = true;
      airdropProgressBegin(walletPublicKey, pendingRecipients.length);
      const result = pendingRecipients.length ? await executeAirdrop({ ...input, tempWalletSecretKey: signer.secretKeyArr, recipients: pendingRecipients,
        onProgress: (value) => airdropProgressStep(walletPublicKey, value) }) : { transferred: [], failed: [] };
      const retried = new Set(pendingRecipients.map((row) => row.wallet));
      const mergedAirdrop = { transferred: [...priorDelivered, ...result.transferred],
        failed: [...(priorAirdrop.failed || []).filter((row) => !retried.has(row.wallet)), ...result.failed] };
      launchJournal.upsertForWallet(walletPublicKey, { airdrop: mergedAirdrop }, {
        stage: 'airdrop_retry', retried: pendingRecipients.length, delivered: result.transferred.length, stillFailed: result.failed.length,
      });
      return { success: true, airdrop: mergedAirdrop };
    } catch (error) { throw serviceError(error); }
    finally {
      if (tracking) { clearAirdropInFlight(walletPublicKey); airdropProgressEnd(walletPublicKey); }
      if (claimed) clearLaunchOpInFlight(walletPublicKey);
    }
  }

  async function transferAssets(input = {}) {

    let walletPublicKey = null;
    let claimedLaunchOp = false;
    try {
      const {
        tempWalletSecretKey,
        destinationWallet: rawDestinationWallet,
        // tokenMint kept in payload for backward compat with the frontend,
        // but no longer used to decide what to transfer — the new
        // sweepAllTokensToDestination picks up every fungible token, not
        // just the launched mint. The frontend still passes it.
      } = input;
      let destinationWallet = String(rawDestinationWallet || '').trim();
      // A malformed explicit destination is rejected before the signer loads.
      if (destinationWallet) {
        try {
          new PublicKey(destinationWallet);
        } catch {
          throw new LaunchRejection(400, { success: false, error: 'destinationWallet must be a valid Solana address' });
        }
      }
      try {
        validateTransferAirdropPayload(input.airdrop);
      } catch (error) {
        throw new LaunchRejection(400, { success: false, error: error.message });
      }

      if (input.walletPublicKey) requireSecretPinUnlocked('transferring assets with a saved launch wallet');
      const { secretKeyArr, walletPublicKey: resolvedWalletPublicKey } =
        resolveSigner({ tempWalletSecretKey, walletPublicKey: input.walletPublicKey });
      walletPublicKey = resolvedWalletPublicKey;

      // No return wallet set: everything goes back to the wallet that funded
      // the launch wallet. Never sweep to a guess.
      let resolvedFromFunder = false;
      if (!destinationWallet) {
        const funding = await findFundingWallet(walletPublicKey).catch(() => null);
        destinationWallet = String(funding?.funder || '').trim();
        if (!destinationWallet) {
          throw new LaunchRejection(400, {
            success: false,
            error: 'destinationWallet required: no return wallet is set and the wallet that funded this launch wallet could not be found. Sign with your wallet in Trebuchet, then retry.',
          });
        }
        resolvedFromFunder = true;
        console.log('No return wallet set; returning assets to the funding wallet:', destinationWallet);
      }
      // Last line of defense: this is where assets actually leave the wallet.
      const unsafeDestination = unsafeSweepDestinationReason(destinationWallet, { launchWallet: walletPublicKey });
      if (unsafeDestination) {
        throw new LaunchRejection(400, { success: false, error: `Refusing to sweep: ${unsafeDestination}` });
      }
      const unverifiedDestination = resolvedFromFunder
        ? null
        : await unverifiedDestinationReason(destinationWallet, walletPublicKey);
      if (unverifiedDestination) {
        throw new LaunchRejection(400, { success: false, error: `Refusing to sweep: ${unverifiedDestination}` });
      }

      console.log('Transferring assets to:', destinationWallet);
      // Per-wallet mutex — a sweep running concurrently with a still-running
      // create-lp/resume would pull tokens and SOL out from under the launch
      // mid-flight, guaranteeing a half-finished launch. Reject with 409 and
      // let the running operation finish first.
      claimLaunchOp(walletPublicKey, 'transfer-assets');
      claimedLaunchOp = true;
      launchJournal.upsertForWallet(
        walletPublicKey,
        {
          status: 'active',
          stage: 'transfer_started',
          transfer: { destinationWallet },
        },
        { stage: 'transfer_started', destinationWallet },
      );
      input = { ...input, airdrop: prepareAirdrop({ walletPublicKey, airdrop: input.airdrop }) };
      await reconcileWalletOperation({ tempWalletSecretKey: secretKeyArr, destinationWallet });

      // 0. Metadata authority handoff (keep-authority launches only). The
      //    update authority currently sits on the launch wallet, which this
      //    transfer is about to empty and destroy. Hand it to the destination
      //    FIRST; on failure abort the whole transfer — nothing has been
      //    swept yet, so the user just retries, instead of losing the only
      //    key that can ever change the token's name/logo.
      if (typeof input.keepMetadataAuthorityMint === 'string'
          && input.keepMetadataAuthorityMint) {
        console.log('Transferring metadata update authority to destination...');
        const handoff = await transferMetadataAuthority({
          tempWalletSecretKey: secretKeyArr,
          tokenMint: input.keepMetadataAuthorityMint,
          newAuthority: destinationWallet,
        });
        launchJournal.upsertForWallet(
          walletPublicKey,
          { stage: 'metadata_authority_transferred', token: { metadataAuthority: destinationWallet, metadataAuthorityOperationId: handoff.operationId, metadataAuthorityTransactionId: handoff.txId } },
          { stage: 'metadata_authority_transferred', destinationWallet, operationId: handoff.operationId, txId: handoff.txId },
        );
      }

      // 1. NFTs first. Fee Keys especially — these are the most valuable
      //    sweep items and we want them locked in before risking SOL.
      const nftSweep = await sweepNftsToDestination({
        tempWalletSecretKey: secretKeyArr,
        destinationWallet,
      });

      // 1.5. Airdrop, if configured. Inserted BEFORE the token sweep
      //      because the airdrop sends the launched token to the recipient
      //      wallets from the ephemeral wallet's balance — those tokens
      //      must still be present. The optional `airdrop` payload carries
      //      the token mint, decimals, program info, and recipient list;
      //      when absent (no airdrop configured / simple mode without
      //      airdrop / customize mode) this step is a clean no-op.
      //
      //      Partial failures don't abort the transfer. Failed recipients
      //      are returned in `airdropResult.failed` so the frontend can
      //      offer a retry. Un-airdropped tokens stay in the launch wallet
      //      and get picked up by the token sweep below, so even if the
      //      user gives up on retrying, the funds aren't stranded — they
      //      reach the destination wallet via the standard sweep path.
      let airdropResult = null;
      if (input.airdrop
          && Array.isArray(input.airdrop.recipients)
          && input.airdrop.recipients.length > 0
          && input.airdrop.tokenMint
          && Number.isFinite(input.airdrop.tokenDecimals)) {
        // Concurrency guard: reject if another airdrop is currently
        // running for this same launch wallet. Without this, a user
        // clicking Transfer Assets twice (or a slow network triggering
        // a double-submit) could send overlapping airdrops and
        // double-pay recipients whose first-pass tx already landed.
        if (airdropInFlight(walletPublicKey)) {
          console.warn(
            `Rejecting concurrent airdrop request for wallet ${walletPublicKey} `
            + `— another airdrop is already in flight.`,
          );
          airdropResult = {
            transferred: [],
            failed: input.airdrop.recipients.map((r) => ({
              wallet: r.wallet,
              tokens: r.tokens,
              amountRaw: null,
              error: 'Another airdrop is already running for this launch wallet. '
                + 'Wait for it to complete before retrying.',
            })),
          };
        } else {
          // Per-recipient idempotency: the transfer endpoint is re-runnable
          // after a partial failure, and the frontend re-sends the FULL
          // airdrop payload each attempt. Filter out recipients the journal
          // already records as delivered so a transfer retry can never
          // double-pay. (parseAirdropCsv dedupes wallets client-side, so
          // wallet address is a safe unique key.)
          const priorAirdrop = launchJournal.activeForWallet(walletPublicKey)?.airdrop || null;
          const priorDelivered = Array.isArray(priorAirdrop?.transferred)
            ? priorAirdrop.transferred
            : [];
          const deliveredWallets = new Set(priorDelivered.map((t) => t.wallet));
          const pendingRecipients = input.airdrop.recipients.filter(
            (r) => !deliveredWallets.has(r.wallet),
          );
          if (priorDelivered.length > 0) {
            console.log(
              `Airdrop retry-safety: ${priorDelivered.length} recipient(s) already `
              + `delivered per journal — sending to ${pendingRecipients.length} remaining.`,
            );
          }

          if (pendingRecipients.length === 0) {
            // Everything already delivered in a prior attempt — skip the
            // execution entirely and report the journal's record so the
            // frontend/report still see the full result.
            airdropResult = { transferred: priorDelivered, failed: [] };
            launchJournal.recordEvent(walletPublicKey, {
              stage: 'airdrop_skipped_already_delivered',
              delivered: priorDelivered.length,
            });
          } else {
          // Record airdrop start in the journal so a crashed-mid-airdrop
          // case is debuggable from the journal alone. recordEvent appends
          // to the wallet's event stream without mutating the top-level
          // status (the transfer is still active overall).
          launchJournal.recordEvent(walletPublicKey, {
            stage: 'airdrop_started',
            recipients: pendingRecipients.length,
            tokenMint: input.airdrop.tokenMint,
          });
          markAirdropInFlight(walletPublicKey);
          airdropProgressBegin(walletPublicKey, pendingRecipients.length);
          try {
            airdropResult = await executeAirdrop({
              tempWalletSecretKey: secretKeyArr,
              tokenMint: input.airdrop.tokenMint,
              tokenDecimals: input.airdrop.tokenDecimals,
              isToken2022: !!input.airdrop.isToken2022,
              recipients: pendingRecipients,
              onProgress: (s) => airdropProgressStep(walletPublicKey, s),
            });
            // Merge previously-delivered recipients back in so the response
            // and the journal carry the COMPLETE picture, not just this
            // attempt's slice.
            airdropResult = {
              transferred: [...priorDelivered, ...airdropResult.transferred],
              failed: airdropResult.failed,
            };
            console.log(
              `Airdrop summary: ${airdropResult.transferred.length} delivered, `
              + `${airdropResult.failed.length} failed`,
            );
            // Record completion. Includes a partial flag so the journal
            // viewer can distinguish a fully-clean airdrop from one that
            // had per-recipient failures. The full per-recipient record is
            // persisted on journal.airdrop (the patch below) so transfer
            // retries can skip delivered wallets and an app restart can
            // restore the report's airdrop section and the retry button.
            launchJournal.upsertForWallet(
              walletPublicKey,
              { airdrop: airdropResult },
              {
                stage: 'airdrop_completed',
                delivered: airdropResult.transferred.length,
                failed: airdropResult.failed.length,
                partial: airdropResult.failed.length > 0,
              },
            );
          } catch (e) {
            throwIfExecutionPaused(e);
            // An UNEXPECTED airdrop failure (one that bypassed per-recipient
            // try/catch — likely a bad mint or connection init failure)
            // shouldn't abort the rest of the sweep. We log it and mark
            // every remaining recipient as failed so the user sees what
            // happened; previously-delivered recipients stay delivered.
            console.error('Airdrop step failed unexpectedly:', e.message);
            launchJournal.recordEvent(walletPublicKey, {
              stage: 'airdrop_crashed',
              error: e.message,
            });
            airdropResult = {
              transferred: priorDelivered,
              failed: pendingRecipients.map((r) => ({
                wallet: r.wallet,
                tokens: r.tokens,
                amountRaw: null,
                error: `Airdrop step crashed: ${e.message}`,
              })),
            };
          } finally {
            // ALWAYS clear the in-flight flag so a future retry isn't
            // blocked. The flag's purpose is to serialize concurrent
            // attempts, not to prevent legitimate re-runs.
            clearAirdropInFlight(walletPublicKey);
            // Flip the progress tracker to 'done' so the frontend's
            // poller sees the terminal state on its next call. The
            // tracker auto-clears itself after ~10s of being done.
            airdropProgressEnd(walletPublicKey);
          }
          }
        }
      }

      // 2. All fungible tokens — launched token + any auto-swapped quote
      //    tokens that weren't fully consumed by the bootstrap positions.
      const tokenSweep = await sweepAllTokensToDestination({
        tempWalletSecretKey: secretKeyArr,
        destinationWallet,
      });

      // 2.5 + 3. Straggler pass, SOL gate, and (gated) SOL sweep. The logic
      //    lives in sweepOrchestrator.js as a pure dependency-injected unit —
      //    see that module for the invariant and its rationale. Production
      //    deps are the real walletHelpers functions; the journal recorder is
      //    a closure over this wallet.
      const {
        solSweep, solSweepError, solSweepSkipped,
      } = await finishSweepWithSolGate({
        walletPublicKey,
        tempWalletSecretKey: secretKeyArr,
        destinationWallet,
        nftSweep,
        tokenSweep,
        deps: {
          sweepNfts: sweepNftsToDestination,
          sweepTokens: sweepAllTokensToDestination,
          sweepSol: sweepSolToDestination,
          enumerate: (pk, opts) => checkWalletBalanceMultiToken(pk, opts),
          recordEvent: (event) => launchJournal.recordEvent(walletPublicKey, event),
        },
      });

      // Receipts survive a restart even when the transferred assets have
      // left the source wallet. Commit this complete report before cleanup.
      mergeTransferReceipts({ nftSweep, tokenSweep, receipts: (await getTransferReceipts(walletPublicKey)).filter((receipt) => receipt.action?.context?.purpose !== 'airdrop') });

      // 4. Verify the wallet is on-chain empty before clearing the
      //    recovery cache entry. Anything still there → leave the cached
      //    key in place so the user has another shot at recovery.
      //    A balance-check failure also keeps the entry (conservative).
      let walletEmpty = false;
      try {
        const remaining = await checkWalletBalanceMultiToken(
          walletPublicKey, { commitment: 'finalized' },
        );
        if (isWalletEffectivelyEmpty(remaining)) {
          walletEmpty = true;
        } else {
          console.warn(
            `Wallet ${walletPublicKey} not empty after sweep; keeping recovery entry. ` +
            `SOL=${remaining.sol}, tokens=${Object.keys(remaining.tokens).length}`,
          );
        }
      } catch (e) {
        throwIfExecutionPaused(e);
        console.warn('Post-sweep verification failed; keeping recovery entry:', e.message);
      }

      // Response shape: preserve the historic top-level fields the
      // frontend already displays ({tokensTransferred, solTransferred,
      // nftSweep}), plus the new per-token detail under tokenSweep so
      // future UI iterations can show per-token results.
      const tokensTransferred = tokenSweep.transferred.length;
      const solTransferred = solSweep.solTransferred;
      const airdropFailedCount = airdropResult
        ? airdropResult.failed.length
        // No airdrop in this request (the new flow runs it as a separate
        // /api/run-airdrop call before the sweep) — read the persistent
        // record instead so failed recipients still mark the transfer
        // partial, same as when the airdrop ran in-process.
        : (launchJournal.activeForWallet(walletPublicKey)?.airdrop?.failed?.length || 0);
      const hasPartialFailure =
        !!solSweepError ||
        !!solSweepSkipped ||
        (tokenSweep.errors || []).length > 0 ||
        (nftSweep.errors || []).length > 0 ||
        airdropFailedCount > 0 ||
        !walletEmpty;
      launchJournal.upsertForWallet(
        walletPublicKey,
        {
          status: hasPartialFailure ? 'failed' : 'completed',
          stage: hasPartialFailure ? 'transfer_partial' : 'transfer_completed',
          error: hasPartialFailure
            ? (solSweepError || solSweepSkipped || 'wallet still has recoverable assets')
            : null,
          transfer: transferJournalSummary({
            destinationWallet,
            tokensTransferred,
            solTransferred,
            nftSweep,
            tokenSweep,
            solSweep,
            solSweepError,
            solSweepSkipped,
            walletEmpty,
          }),
        },
        {
          stage: hasPartialFailure ? 'transfer_partial' : 'transfer_completed',
          destinationWallet,
          tokensTransferred,
          solTransferred,
          nftsTransferred: nftSweep?.transferred?.length || 0,
          walletEmpty,
        },
      );
      // Keep recovery custody until the final chain observation is durable.
      if (walletEmpty) pendingWallets.remove(walletPublicKey);
      return {
        success: true,
        tokensTransferred,
        solTransferred,
        // When set, the SOL sweep was DELIBERATELY skipped because assets
        // remain (or their absence couldn't be verified): the SOL stays in the
        // launch wallet so a retry can pay its own fees. The frontend shows
        // this string; it explicitly says nothing has been lost.
        solSweepSkipped,
        destinationWallet,
        nftSweep,
        tokenSweep,
        solSweep,
        solSweepError,
        walletEmpty,
        hasPartialFailure,
        airdrop: airdropResult,
      };
    } catch (error) {
      throwIfExecutionPaused(error);
      if (error instanceof LaunchRejection) throw error;
      console.error('Error transferring assets:', error);
      if (walletPublicKey) {
        launchJournal.upsertForWallet(
          walletPublicKey,
          {
            status: 'failed',
            stage: 'transfer_failed',
            error: error.message,
          },
          { stage: 'transfer_failed', error: error.message },
        );
      }
      throw serviceError(error);
    } finally {
      // Release the per-wallet operation lock if we claimed it. 409
      // rejections never claim, so a rejected duplicate doesn't release
      // the lock held by the operation that's actually running.
      if (claimedLaunchOp && walletPublicKey) {
        clearLaunchOpInFlight(walletPublicKey);
      }
    }
  }

  return { finishToken, revealMetadata, createToken, createLiquidity, resumeLiquidity, transferAssets, runAirdrop };
}

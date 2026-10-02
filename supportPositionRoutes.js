export function installSupportPositionRoutes(app, { runtime, isDemoMode, demoChainService, coinStore, pendingWallets,
  findSolClmmPoolForToken, previewSolSupport, resolveSigner, rejectIfSecretPinLocked, claim, release, sendErrorResponse }) {
  const requireRuntime = () => {
    if (!runtime) throw Object.assign(new Error('Start the owned runtime before adding support.'), { code: 'EXECUTION_RECOVERY_REQUIRED', statusCode: 409 });
    return runtime;
  };
  const onError = (res, error) => {
    const status = error.statusCode || (['SUPPORT_PLAN_CHANGED', 'SUPPORT_POSITION_EXISTS', 'OPERATION_IN_FLIGHT', 'EXECUTION_APPROVAL_REQUIRED', 'INSUFFICIENT_FUNDS', 'CHAIN_STATE_UNAVAILABLE', 'TRANSACTION_FAILED'].includes(error.code) ? 409 : 400);
    if (error.jobId) return res.status(status).json({ success: false, code: error.code || 'EXECUTION_INTERRUPTED', error: error.message, jobId: error.jobId });
    return sendErrorResponse(res, error, status);
  };
  async function resolveSupportPoolId(body = {}) {
    const poolId = String(body.poolId || '').trim();
    if (poolId) return poolId;
    const tokenMint = String(body.tokenMint || '').trim();
    if (!tokenMint) throw new Error('poolId or tokenMint is required');
    const found = await findSolClmmPoolForToken(tokenMint);
    if (!found) throw new Error('No Raydium concentrated-liquidity SOL pool was found for that token.');
    return found;
  }

  app.post('/api/v2/support/preview', async (req, res) => {
    try {
      const body = req.body || {};
      const walletPublicKey = String(body.walletPublicKey || '').trim() || null;
      if (isDemoMode()) {
        // Practice reads real pools (read-only) and simulates only the send,
        // with the practice wallet's balance. Practice coins have no real
        // pool, so they plan against a sample one.
        let plan = null;
        try {
          const poolId = await resolveSupportPoolId(body);
          plan = await previewSolSupport({ walletPublicKey: null, poolId, solAmount: body.solAmount, depthPct: body.depthPct });
        } catch {
          plan = null;
        }
        if (!plan) return res.json({ success: true, plan: demoChainService.planDemoSolSupport({ ...body, walletPublicKey }) });
        return res.json({ success: true, plan: demoChainService.practiceSupportPlan(plan, walletPublicKey) });
      }
      const poolId = await resolveSupportPoolId(body);
      const plan = await previewSolSupport({
        walletPublicKey,
        poolId,
        solAmount: body.solAmount,
        depthPct: body.depthPct,
      });
      res.json({ success: true, plan });
    } catch (error) {
      sendErrorResponse(res, error, 400);
    }
  });


  app.get('/api/v2/support/jobs', (req, res) => {
    try {
      const wallets = pendingWallets.list().map((wallet) => wallet.publicKey).filter((wallet) => !req.query.walletPublicKey || wallet === req.query.walletPublicKey);
      res.json({ success: true, jobs: isDemoMode() ? [] : requireRuntime().list(wallets) });
    } catch (error) { onError(res, error); }
  });
  app.get('/api/v2/support/jobs/:jobId', (req, res) => {
    try {
      const job = requireRuntime().get(req.params.jobId);
      if (!job) return res.status(404).json({ success: false, error: 'Use a saved support job.' });
      res.json({ success: true, job });
    } catch (error) { onError(res, error); }
  });
  app.post('/api/v2/support/prepare', async (req, res) => {
    const body = req.body || {}, walletPublicKey = String(body.walletPublicKey || '').trim(); let claimed = false;
    try {
      if (isDemoMode()) return res.json({ success: true, job: { practice: true } });
      if (rejectIfSecretPinLocked(res, 'preparing support with a saved wallet')) return;
      const { keypair } = resolveSigner({ walletPublicKey });
      if (keypair.publicKey.toBase58() !== walletPublicKey) throw Object.assign(new Error('Use the selected support wallet.'), { code: 'WALLET_MISMATCH', statusCode: 409 });
      claim(walletPublicKey, 'support-position'); claimed = true;
      const poolId = await resolveSupportPoolId(body);
      const job = await requireRuntime().prepare({ ownerKeypair: keypair, poolId, solAmount: body.solAmount, depthPct: body.depthPct, requestId: body.requestId, lookupTables: body.lookupTables });
      res.json({ success: true, job });
    } catch (error) { onError(res, error); }
    finally { if (claimed) release(walletPublicKey); }
  });
  app.post('/api/v2/support/open', async (req, res) => {
    const body = req.body || {}, walletPublicKey = String(body.walletPublicKey || '').trim(); let claimed = false;
    try {
      if (isDemoMode()) {
        const result = demoChainService.openDemoSolSupport({ ...body, walletPublicKey });
        if (body.tokenMint || result.token?.mint) coinStore.recordEvent(String(body.tokenMint || result.token.mint), { type: 'support_added', practice: true,
          poolId: result.poolId, txId: null, sol: Number(result.depositLamports) / 1e9, tickLower: result.tickLower, tickUpper: result.tickUpper });
        return res.json({ success: true, result });
      }
      if (rejectIfSecretPinLocked(res, 'adding support with a saved wallet')) return;
      const job = requireRuntime().get(body.jobId);
      if (!job || job.walletPublicKey !== walletPublicKey) throw Object.assign(new Error('Prepare and confirm the saved support position first.'), { code: 'EXECUTION_APPROVAL_REQUIRED', statusCode: 409 });
      const { keypair } = resolveSigner({ walletPublicKey });
      if (keypair.publicKey.toBase58() !== walletPublicKey) throw Object.assign(new Error('Use the saved support wallet.'), { code: 'WALLET_MISMATCH', statusCode: 409 });
      claim(walletPublicKey, 'support-position', job.jobId); claimed = true;
      const result = await runtime.execute({ id: job.jobId, ownerKeypair: keypair, planDigest: body.planDigest, maxSpendLamports: body.maxSpendLamports });
      if (result.status === 'confirmed' && !coinStore.get(job.tokenMint)?.events?.some((event) => event.jobId === job.jobId)) {
        coinStore.recordEvent(job.tokenMint, { type: 'support_added', jobId: job.jobId, poolId: job.poolId, nftMint: job.nftMint,
          txId: result.txId, walletPublicKey, sol: Number(result.depositedRaw) / 1e9, tickLower: job.tickLower, tickUpper: job.tickUpper,
          feeLamports: result.feeLamports, outcome: 'landed' });
      }
      res.json({ success: result.status === 'confirmed', result });
    } catch (error) { onError(res, error); }
    finally { if (claimed) release(walletPublicKey); }
  });
}

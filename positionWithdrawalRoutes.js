export function installPositionWithdrawalRoutes(app, { runtime, isDemoMode, demoChainService, coinStore, pendingWallets,
  resolveSigner, rejectIfSecretPinLocked, claim, release, sendErrorResponse }) {
  const requireRuntime = () => {
    if (!runtime) throw Object.assign(new Error('Start the owned runtime before position withdrawal.'), { code: 'EXECUTION_RECOVERY_REQUIRED', statusCode: 409 });
    return runtime;
  };
  const onError = (res, error) => {
    const status = error.statusCode || (['POSITION_CHANGED', 'POSITION_NOT_FOUND', 'OPERATION_IN_FLIGHT', 'EXECUTION_APPROVAL_REQUIRED', 'CHAIN_STATE_UNAVAILABLE', 'TRANSACTION_FAILED'].includes(error.code) ? 409 : 400);
    if (error.jobId) return res.status(status).json({ success: false, code: error.code || 'EXECUTION_INTERRUPTED', error: error.message, jobId: error.jobId });
    return sendErrorResponse(res, error, status);
  };
  app.get('/api/v2/positions/withdrawals', (req, res) => {
    try { res.json({ success: true, withdrawals: isDemoMode() ? [] : requireRuntime().list(pendingWallets.records().map((wallet) => wallet.publicKey), req.query.tokenMint) }); }
    catch (error) { onError(res, error); }
  });
  app.get('/api/v2/positions/withdrawals/:jobId', (req, res) => {
    try {
      const job = requireRuntime().get(req.params.jobId);
      if (!job) return res.status(404).json({ success: false, error: 'Use a saved withdrawal job.' });
      res.json({ success: true, job });
    } catch (error) { onError(res, error); }
  });
  app.post('/api/v2/positions/withdraw/prepare', async (req, res) => {
    const body = req.body || {}; let claimed = false;
    try {
      if (isDemoMode()) return res.json({ success: true, job: { practice: true } });
      claim(body.walletPublicKey, 'withdraw-position'); claimed = true;
      res.json({ success: true, job: await requireRuntime().prepare(body) });
    } catch (error) { onError(res, error); }
    finally { if (claimed) release(body.walletPublicKey); }
  });
  app.post('/api/v2/positions/withdraw', async (req, res) => {
    const body = req.body || {}, walletPublicKey = String(body.walletPublicKey || '').trim(); let claimed = false;
    try {
      if (isDemoMode()) {
        const result = demoChainService.withdrawDemoPosition(body);
        if (body.tokenMint) coinStore.recordEvent(body.tokenMint, { type: 'position_withdrawn', practice: true, poolId: body.poolId,
          nftMint: body.nftMint, sol: result.solReturned, walletPublicKey });
        return res.json({ success: true, result });
      }
      if (rejectIfSecretPinLocked(res, 'withdrawing a position with a saved wallet')) return;
      const job = requireRuntime().get(body.jobId);
      if (!job || job.walletPublicKey !== walletPublicKey) throw Object.assign(new Error('Prepare and confirm the saved withdrawal first.'), { code: 'EXECUTION_APPROVAL_REQUIRED', statusCode: 409 });
      const { keypair } = resolveSigner({ walletPublicKey, tempWalletSecretKey: body.tempWalletSecretKey });
      if (keypair.publicKey.toBase58() !== walletPublicKey) throw Object.assign(new Error('Use the saved withdrawal wallet.'), { code: 'WALLET_MISMATCH', statusCode: 409 });
      claim(walletPublicKey, 'withdraw-position', job.jobId); claimed = true;
      const result = await runtime.execute({ id: job.jobId, ownerKeypair: keypair, planDigest: body.planDigest, maxSpendLamports: body.maxSpendLamports });
      res.json({ success: result.status === 'confirmed', result });
    } catch (error) { onError(res, error); }
    finally { if (claimed) release(walletPublicKey); }
  });
}

// HTTP translates the authenticated request into the owned quote runtime.
// Demo jobs keep their existing short-lived fixture store.
export function installQuoteAcquisitionRoutes(app, { runtime, isDemoMode, demoChainService, resolveSigner,
  rejectIfSecretPinLocked, claim, release, sendErrorResponse }) {
  const demoJobs = new Map(), jobExpiryMs = 10 * 60000;
  const requireRuntime = () => {
    if (!runtime) throw Object.assign(new Error('Start the owned runtime before acquiring quote tokens.'), { code: 'EXECUTION_RECOVERY_REQUIRED', statusCode: 409 });
    return runtime;
  };
  const errorResponse = (res, error) => sendErrorResponse(res, error, error instanceof TypeError ? 400 : 500);
  const signer = (req, res, job) => {
    const walletPublicKey = job?.walletPublicKey || req.body.walletPublicKey;
    if (job && req.body.walletPublicKey && req.body.walletPublicKey !== walletPublicKey) throw Object.assign(new Error('Use the saved quote wallet.'), { code: 'WALLET_MISMATCH', statusCode: 409 });
    if (walletPublicKey && rejectIfSecretPinLocked(res, 'acquiring quote tokens with the saved launch wallet')) return null;
    const { keypair } = resolveSigner({ tempWalletSecretKey: req.body.tempWalletSecretKey, walletPublicKey });
    if (job && keypair.publicKey.toBase58() !== walletPublicKey) throw Object.assign(new Error('Use the signer for the saved quote wallet.'), { code: 'WALLET_MISMATCH', statusCode: 409 });
    return keypair;
  };
  const saved = (id) => {
    const job = requireRuntime().get(id);
    if (!job) throw Object.assign(new Error('Use a saved quote job.'), { code: 'OPERATION_UNKNOWN', statusCode: 404 });
    return job;
  };
  app.post('/api/acquire-quote-tokens', async (req, res) => {
    if (isDemoMode()) return demoChainService.handleAcquireQuoteTokens(req, res, { acquireJobs: demoJobs, jobExpiryMs });
    let walletPublicKey, claimed = false;
    try {
      const ownerKeypair = signer(req, res); if (!ownerKeypair) return;
      walletPublicKey = ownerKeypair.publicKey.toBase58();
      const active = requireRuntime().active(walletPublicKey); if (active) return res.json(active);
      claim(walletPublicKey, 'acquire-quote-tokens'); claimed = true;
      res.json(await runtime.prepare({ walletPublicKey, autoSwapPlan: req.body.autoSwapPlan, requestId: req.body.requestId }));
    } catch (error) { errorResponse(res, error); }
    finally { if (claimed) release(walletPublicKey); }
  });
  const execute = (cleanup) => async (req, res) => {
    let walletPublicKey, claimed = false, handedOff = false;
    try {
      const job = saved(req.params.jobId), ownerKeypair = signer(req, res, job); if (!ownerKeypair) return;
      walletPublicKey = ownerKeypair.publicKey.toBase58();
      claim(walletPublicKey, 'acquire-quote-tokens', job.jobId); claimed = true;
      const started = await runtime[cleanup ? 'startCleanup' : 'start']({ id: job.jobId, ownerKeypair,
        planDigest: req.body.planDigest, maxSpendLamports: req.body.maxSpendLamports, recoveryDigest: req.body.recoveryDigest });
      started.completion.catch((error) => console.error(`[quotes][${job.jobId}] ${error.code || 'EXECUTION_INTERRUPTED'}: ${error.message}`))
        .finally(() => release(walletPublicKey));
      handedOff = true; res.json(started.job);
    } catch (error) { errorResponse(res, error); }
    finally { if (claimed && !handedOff) release(walletPublicKey); }
  };
  app.post('/api/acquire-quote-tokens/:jobId/execute', execute(false));
  app.post('/api/acquire-quote-tokens/:jobId/cleanup', execute(true));
  app.post('/api/acquire-quote-tokens/:jobId/cleanup/prepare', async (req, res) => {
    let walletPublicKey, claimed = false;
    try {
      const job = saved(req.params.jobId), ownerKeypair = signer(req, res, job); if (!ownerKeypair) return;
      walletPublicKey = ownerKeypair.publicKey.toBase58();
      claim(walletPublicKey, 'acquire-quote-tokens', job.jobId); claimed = true;
      res.json(await runtime.prepareCleanup(job.jobId));
    } catch (error) { errorResponse(res, error); }
    finally { if (claimed) release(walletPublicKey); }
  });
  app.get('/api/acquire-quote-tokens/active/:walletPublicKey', (req, res) => {
    try { res.json({ job: isDemoMode() ? null : requireRuntime().active(req.params.walletPublicKey) }); }
    catch (error) { errorResponse(res, error); }
  });
  app.get('/api/acquire-quote-tokens/:jobId', (req, res) => {
    try {
      if (!isDemoMode()) return res.json(saved(req.params.jobId));
      const job = demoJobs.get(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Use a current demo quote job.' });
      res.json({ ...job, inProgressMints: Array.from(job.inProgressMints) });
    } catch (error) { errorResponse(res, error); }
  });
  app.delete('/api/acquire-quote-tokens/:jobId', (req, res) => {
    try { res.json(isDemoMode() ? { deleted: demoJobs.delete(req.params.jobId) } : requireRuntime().archive(req.params.jobId)); }
    catch (error) { errorResponse(res, error); }
  });
  return { busy: () => [...demoJobs.values()].some((job) => job.status === 'running') };
}
